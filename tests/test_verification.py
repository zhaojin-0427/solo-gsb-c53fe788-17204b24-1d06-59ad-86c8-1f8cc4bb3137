"""现场地址核验端到端测试。

基准一律取自所选已发布方案的发布快照（或旧记录留存落点），按 ID 对齐，
闭区间按 start..start+channels-1 计算；缺失、额外、线路/地址/通道不符与
跨行重叠分别成表；异常行可整表拒收或隔离继续核对，但绝不报告一致；
核验只读，不修改编排与发布数据。
"""
from __future__ import annotations

import os
import tempfile

import pytest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DMX_DB_PATH"] = _tmp.name

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine, SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Plan  # noqa: E402
from app.services import init_db  # noqa: E402


@pytest.fixture(scope="module")
def client():
    Base.metadata.drop_all(bind=engine)
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def setup(client):
    """型录 + 4 台灯 + 一次发布，返回 plan_id 与基准 allocations。"""
    client.post(
        "/api/catalog/import",
        files={"file": ("cat.csv",
                        "manufacturer,name,mode,channels\n"
                        "ACME,Solar,Basic,10\nBrightCo,Par,3CH,3\nVfy,Beam,Std,16\n",
                        "text/csv")},
    )
    types = client.get("/api/catalog").json()
    m10 = next(m for t in types if t["name"] == "Solar" for m in t["modes"])
    m3 = next(m for t in types if t["name"] == "Par" for m in t["modes"])
    m16 = next(m for t in types if t["name"] == "Beam" for m in t["modes"])
    names = [("VfyA", m10["id"]), ("VfyB", m3["id"]), ("VfyC", m3["id"]), ("VfyD", m16["id"])]
    for name, mode_id in names:
        client.post("/api/fixtures", json={"name": name, "mode_id": mode_id})
    p = client.post("/api/plans/preview").json()
    assert p["optimality_status"] == "optimal"
    plan_id = p["plan_id"]
    assert client.post(f"/api/plans/{plan_id}/publish").status_code == 200
    got = client.get(f"/api/plans/{plan_id}").json()
    assert got["from_snapshot"] is True
    return {"plan_id": plan_id, "allocations": got["allocations"]}


def _site_csv(rows, header=True):
    out = "灯具ID,线路,起始地址,通道数\n" if header else ""
    out += "\n".join(f"{fid},{line},{start},{ch}" for fid, line, start, ch in rows)
    return out + "\n"


def _baseline_rows(allocs):
    return [(a["fixture_id"], a["line_id"], a["start"], a["channels"]) for a in allocs]


def verify(client, plan_id, csv_text, mode="isolate"):
    return client.post(
        f"/api/plans/{plan_id}/verify",
        files={"file": ("site.csv", csv_text, "text/csv")},
        data={"mode": mode},
    )


# ---------- 方案列表与入口校验 ----------
def test_39_published_list_includes_plan(client, setup):
    pid = setup["plan_id"]
    lst = client.get("/api/plans/published").json()
    mine = next(p for p in lst if p["id"] == pid)
    assert mine["fixture_count"] == 4
    assert mine["from_snapshot"] is True
    assert mine["published_at"]


def test_40_verify_unknown_or_unpublished_plan_rejected(client, setup):
    # 不存在的方案：明确 404，而不是把它当空基准判“一致”
    r = verify(client, setup["plan_id"] + 99999, "灯具ID,线路,起始地址,通道数\n1,1,1,1\n")
    assert r.status_code == 404
    assert "未发布" in r.json()["detail"] or "不存在" in r.json()["detail"]

    # 未发布（草稿）方案同样拒绝
    p = client.post("/api/plans/preview").json()
    draft_id = p["plan_id"]
    try:
        r = verify(client, draft_id, _site_csv(_baseline_rows(p["allocations"])))
        assert r.status_code == 404
    finally:
        with SessionLocal() as db:
            db.query(Plan).filter(Plan.id == draft_id).delete()
            db.commit()


def test_41_empty_file_rejected(client, setup):
    r = client.post(
        f"/api/plans/{setup['plan_id']}/verify",
        files={"file": ("site.csv", b"   \n", "text/csv")},
        data={"mode": "isolate"},
    )
    assert r.status_code == 422
    assert "为空" in r.json()["detail"]


# ---------- 一致 ----------
def test_42_exact_site_csv_matches(client, setup):
    r = verify(client, setup["plan_id"], _site_csv(_baseline_rows(setup["allocations"])))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["verdict"] == "match"
    assert d["matched_count"] == 4
    assert (d["missing_count"], d["extra_count"], d["mismatch_count"], d["overlap_count"]) == (0, 0, 0, 0)
    assert d["anomaly_summary"] == {"bad_row": 0, "duplicate_id": 0, "invalid_line": 0, "out_of_range": 0}
    assert d["baseline_source"] == "snapshot"


def test_43_header_aliases_and_positional_fallback(client, setup):
    rows = _baseline_rows(setup["allocations"])
    # 英文表头别名
    en = "id,universe,start address,ch\n" + "\n".join(f"{a},{b},{c},{d}" for a, b, c, d in rows) + "\n"
    assert verify(client, setup["plan_id"], en).json()["verdict"] == "match"
    # 无表头：按 列位置 解析
    no_header = "\n".join(f"{a},{b},{c},{d}" for a, b, c, d in rows) + "\n"
    d = verify(client, setup["plan_id"], no_header).json()
    assert d["verdict"] == "match" and d["accepted_count"] == 4


# ---------- 缺失 / 额外 / 不符 / 重叠 分别呈现 ----------
def test_44_missing_and_extra(client, setup):
    allocs = setup["allocations"]
    kept = _baseline_rows(allocs[:2])  # 少传后两台 -> 缺失 2
    kept.append((888888, 1, 400, 5))  # 基准外 -> 额外 1
    d = verify(client, setup["plan_id"], _site_csv(kept)).json()
    assert d["verdict"] == "mismatch"
    assert {m["fixture_id"] for m in d["missing"]} == {allocs[2]["fixture_id"], allocs[3]["fixture_id"]}
    assert [e["fixture_id"] for e in d["extra"]] == [888888]
    assert d["extra"][0]["name"] is None
    assert d["mismatch_count"] == 0 and d["overlap_count"] == 0


def test_45_line_address_channel_mismatches_are_separate_flags(client, setup):
    a = setup["allocations"]
    fid = {x["name"]: x for x in a}
    bA, bB, bC, bD = fid["VfyA"], fid["VfyB"], fid["VfyC"], fid["VfyD"]

    rows = [
        (bA["fixture_id"], 2 if bA["line_id"] == 1 else 1, bA["start"], bA["channels"]),  # 仅线路不符
        (bB["fixture_id"], bB["line_id"], bB["start"] + 100, bB["channels"]),             # 仅地址不符
        (bC["fixture_id"], bC["line_id"], bC["start"], bC["channels"] + 1),               # 仅通道不符
        (bD["fixture_id"], bD["line_id"], bD["start"], bD["channels"]),                   # 一致
    ]
    d = verify(client, setup["plan_id"], _site_csv(rows)).json()
    assert d["verdict"] == "mismatch" and d["mismatch_count"] == 3 and d["matched_count"] == 1
    by_id = {m["fixture_id"]: m for m in d["mismatches"]}
    mA = by_id[bA["fixture_id"]]
    assert (mA["line_mismatch"], mA["address_mismatch"], mA["channels_mismatch"]) == (True, False, False)
    mB = by_id[bB["fixture_id"]]
    assert (mB["line_mismatch"], mB["address_mismatch"], mB["channels_mismatch"]) == (False, True, False)
    # 起始不变、通道变化 => 地址维度按起始裁决为一致，通道维度不符；闭区间结束值随之变化
    mC = by_id[bC["fixture_id"]]
    assert (mC["line_mismatch"], mC["address_mismatch"], mC["channels_mismatch"]) == (False, False, True)
    assert mC["site"]["end"] == mC["site"]["start"] + mC["site"]["channels"] - 1


def test_46_within_site_overlap_is_reported_separately(client, setup):
    a = setup["allocations"]
    # 现场两台同线路闭区间重叠（即使基准它们不重叠），与落点不符分开列出
    rows = _baseline_rows(a)
    rows[1] = (a[1]["fixture_id"], a[0]["line_id"], a[0]["start"] + 1, a[1]["channels"])
    rows[2] = (a[2]["fixture_id"], a[0]["line_id"], a[0]["start"], a[2]["channels"])
    d = verify(client, setup["plan_id"], _site_csv(rows)).json()
    assert d["overlap_count"] >= 1
    o = next(o for o in d["overlaps"] if {o["a"]["fixture_id"], o["b"]["fixture_id"]}
             == {a[1]["fixture_id"], a[2]["fixture_id"]})
    assert o["line_id"] == a[0]["line_id"]
    assert o["overlap_start"] <= o["overlap_end"]
    # 重叠与不符是两张表：同灯可以既不符又参与重叠，计数互不吞并
    assert d["verdict"] == "mismatch"


# ---------- 异常行：整表拒收 / 隔离继续，绝不报告一致 ----------
def test_47_anomalies_strict_rejects_entire_table(client, setup):
    csv_text = (
        "灯具ID,线路,起始地址,通道数\n"
        f"{setup['allocations'][0]['fixture_id']},1,1,10\n"
        "oops,notint,1,3\n"            # 坏行
        "777,1,510,5\n"                # 越过 512
        "5,9,1,3\n"                    # 非法线路
    )
    r = verify(client, setup["plan_id"], csv_text, mode="strict")
    assert r.status_code == 422
    d = r.json()
    assert d["verdict"] == "rejected"
    types = {x["type"] for x in d["anomalies"]}
    assert {"bad_row", "out_of_range", "invalid_line"} <= types
    # 整表拒收时不进行核对
    assert (d["missing_count"], d["extra_count"], d["mismatch_count"], d["overlap_count"]) == (0, 0, 0, 0)
    assert d["matched"] == []


def test_48_anomalies_isolated_but_never_match(client, setup):
    csv_text = (
        "灯具ID,线路,起始地址,通道数\n"
        + "\n".join(f"{a['fixture_id']},{a['line_id']},{a['start']},{a['channels']}"
                    for a in setup["allocations"])
        + f"\n{setup['allocations'][0]['fixture_id']},1,1,10\n"  # 重复 ID（与首行同值）
          "\noops,1,abc,3\n"                                     # 坏行
    )
    d = verify(client, setup["plan_id"], csv_text, mode="isolate").json()
    # 其余行全部正确，但存在异常 => 绝不能报告一致
    assert d["verdict"] == "mismatch"
    assert d["matched_count"] == 4
    assert d["anomaly_summary"]["duplicate_id"] == 1
    assert d["anomaly_summary"]["bad_row"] == 1
    assert d["isolated_row_count"] == 2
    # 被隔离的重复行不进入额外/重叠统计
    assert d["extra_count"] == 0 and d["overlap_count"] == 0


def test_49_all_anomaly_kinds_classified(client, setup):
    csv_text = (
        "灯具ID,线路,起始地址,通道数\n"
        "1,1,1,3\n"          # 合法
        "1,2,1,3\n"          # 重复 ID
        "2,0,1,3\n"          # 非法线路
        "3,1,0,3\n"          # 起始越界
        "4,1,1,513\n"        # 通道数越过 512
        "5,1,512,2\n"        # 闭区间越过 512
        "x,1,1,3\n"          # 坏行（ID 非整数）
    )
    d = verify(client, setup["plan_id"], csv_text, mode="isolate").json()
    s = d["anomaly_summary"]
    assert s["duplicate_id"] >= 1
    assert s["invalid_line"] >= 1
    assert s["out_of_range"] >= 3  # 起始越界 / 通道>512 / 闭区间越界
    assert s["bad_row"] >= 1
    assert d["verdict"] == "mismatch"  # 有异常绝不一致
    # 异常行带行号与原始内容，供页面逐项展示
    for an in d["anomalies"]:
        assert an["line"] is not None and an["message"]
        assert "fixture_id" in an["raw"]


# ---------- 版本基准：改名 / 删除 / 再发布都不改变所选版本裁决 ----------
def test_50_baseline_pinned_to_selected_version(client, setup):
    pid = setup["plan_id"]
    allocs = setup["allocations"]
    fid0 = allocs[0]["fixture_id"]
    old_name = allocs[0]["name"]

    # 改名 + 删除一台 + 再次发布（新版本落点可能完全不同）
    client.put(f"/api/fixtures/{fid0}", json={"name": "VfyA-Renamed"})
    client.delete(f"/api/fixtures/{allocs[3]['fixture_id']}")
    p2 = client.post("/api/plans/preview").json()
    assert p2["optimality_status"] == "optimal"
    pid2 = p2["plan_id"]
    assert client.post(f"/api/plans/{pid2}/publish").status_code == 200

    # 用旧版本（pid）的原始落点核验：基准仍是旧快照——名称不漂移、已删除灯仍在基准中
    d = verify(client, pid, _site_csv(_baseline_rows(allocs))).json()
    assert d["verdict"] == "match"
    m = next(x for x in d["matched"] if x["fixture_id"] == fid0)
    assert m["name"] == old_name
    assert any(x["fixture_id"] == allocs[3]["fixture_id"] for x in d["matched"])

    # 同一份 CSV 拿去和新版本比：基准是新快照（少一台），应出现缺失/额外，而不是混淆版本
    d2 = verify(client, pid2, _site_csv(_baseline_rows(allocs))).json()
    assert d2["verdict"] == "mismatch"
    assert d2["baseline_count"] == 3
    assert any(x["fixture_id"] == allocs[3]["fixture_id"] for x in d2["extra"])

    # 方案列表两个版本都在
    ids = {p["id"] for p in client.get("/api/plans/published").json()}
    assert {pid, pid2} <= ids


def test_51_verify_is_read_only(client, setup):
    pid = setup["plan_id"]
    before = client.get(f"/api/plans/{pid}").json()
    verify(client, pid, _site_csv(_baseline_rows(setup["allocations"])))
    verify(client, pid, "灯具ID,线路,起始地址,通道数\n999,1,1,3\n", mode="strict")
    after = client.get(f"/api/plans/{pid}").json()
    assert after["allocations"] == before["allocations"]
    assert after["status"] == "published"
    # 灯具数据未被核验改动
    fx = client.get("/api/fixtures").json()
    assert any(f["name"] == "VfyA-Renamed" for f in fx) or any(f["name"] == "VfyA" for f in fx)


# ---------- 无快照旧记录：以留存落点为基准 ----------
def test_52_legacy_publish_record_as_baseline(client):
    """旧库缺少快照的发布记录也能核验：线路/起止/通道来自留存明细，名称不参与裁决。"""
    from datetime import datetime, timezone

    from app.models import PlanAllocation
    from app.services import get_config_version

    # 取当前任意一台真实灯具作为留存明细引用
    fx = client.get("/api/fixtures").json()
    target = next(f for f in fx if f["name"] == "VfyB")

    with SessionLocal() as db:
        plan = Plan(
            config_version=get_config_version(db),
            status="published",
            optimality_status="optimal",
            migration_count=0,
            used_lines=1,
            published_at=datetime(2019, 1, 1, tzinfo=timezone.utc),  # 不抢占最近发布
        )
        db.add(plan)
        db.flush()
        db.add(PlanAllocation(plan_id=plan.id, fixture_id=target["id"],
                              line_id=4, start=200, end=202, migrated=False))
        db.commit()
        legacy_id = plan.id

    d = verify(client, legacy_id, f"灯具ID,线路,起始地址,通道数\n{target['id']},4,200,3\n").json()
    assert d["verdict"] == "match"
    assert d["baseline_source"] == "legacy_publish_record"
    assert d["from_snapshot"] is False

    # 地址不符：旧记录落点仍是裁决基准
    d2 = verify(client, legacy_id, f"灯具ID,线路,起始地址,通道数\n{target['id']},4,201,3\n").json()
    assert d2["verdict"] == "mismatch" and d2["mismatch_count"] == 1
