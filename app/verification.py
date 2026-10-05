"""现场地址核验：以指定已发布方案的发布快照（或旧记录留存落点）为基准，
按灯具 ID 对齐现场 CSV，逐项给出缺失、额外、线路/地址/通道不符与现场
区间重叠清单及整表结论。

本模块为**只读**操作：不修改任何灯具、编排草稿、发布记录与快照——基准
一律取自所选方案版本（get_plan_payload 已完成“快照优先、旧记录按字段
来源裁决”的还原），灯具后来改名、删除或再次发布都不影响本次核验结论。
名称与保留区不参与裁决：名称仅用于清单展示，ID 才是对齐键；保留区
（尤其旧记录中本就未知的历史保留区）不纳入任何比对。
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import planner
from .models import Plan, PlanAllocation, PublishedSnapshot

#: 整表拒收：CSV 存在任何异常行即拒绝核对
MODE_STRICT = "strict"
#: 隔离异常行继续核对：异常行被剔除、其余行照常比对，但绝不可能报告一致
MODE_ISOLATE = "isolate"
VALID_MODES = (MODE_STRICT, MODE_ISOLATE)

LINE_SIZE = 512

#: 现场 CSV 表头别名（归一化：去空白、转小写后匹配），四列缺一即回退为按列位置解析
HEADER_ALIASES: dict[str, set[str]] = {
    "fixture_id": {"灯具id", "灯具编号", "id", "fixtureid", "fixtureuid"},
    "line_id": {"线路", "线路id", "线路编号", "line", "lineid", "universe"},
    "start": {"起始地址", "起始", "地址", "start", "startaddress", "dmxaddress"},
    "channels": {"通道数", "通道", "channels", "channel", "channelcount", "ch"},
}
FIELD_LABELS = {
    "fixture_id": "灯具ID",
    "line_id": "线路",
    "start": "起始地址",
    "channels": "通道数",
}
FIELDS = ("fixture_id", "line_id", "start", "channels")


def list_published_plans(db: Session) -> list[dict]:
    """所有已发布方案（新到旧），供“已发布”页选择核验基准。"""
    plans = (
        db.query(Plan)
        .filter(Plan.status == "published")
        .order_by(Plan.published_at.desc(), Plan.id.desc())
        .all()
    )
    snapshot_plan_ids = {
        row[0]
        for row in db.query(PublishedSnapshot.plan_id).distinct().all()
    }
    counts: dict[int, int] = defaultdict(int)
    for plan_id, in db.query(PlanAllocation.plan_id).all():
        counts[plan_id] += 1
    return [
        {
            "id": p.id,
            "config_version": p.config_version,
            "published_at": p.published_at,
            "migration_count": p.migration_count,
            "used_lines": p.used_lines,
            "from_snapshot": p.id in snapshot_plan_ids,
            "fixture_count": counts[p.id],
        }
        for p in plans
    ]


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return raw.decode("gbk")
        except UnicodeDecodeError:
            raise HTTPException(
                status_code=422,
                detail="现场 CSV 编码无法识别（支持 UTF-8 含 BOM 或 GBK），整表拒收。",
            )


def _norm_header(cell: str) -> str:
    return cell.strip().lower().replace("_", "").replace(" ", "")


def _match_header(row: list[str]) -> dict[str, int] | None:
    """首行能识别全部四列时按表头映射，否则返回 None 走按列位置解析。"""
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(row):
        key = _norm_header(cell)
        for field, aliases in HEADER_ALIASES.items():
            if key in aliases and field not in mapping:
                mapping[field] = idx
    return mapping if all(f in mapping for f in FIELDS) else None


def _is_int(text: str) -> bool:
    return text.strip("+-").isdigit() and text not in ("", "+", "-")


def _anomaly(line, atype: str, message: str, raw: dict | None = None, fixture_id=None) -> dict:
    return {
        "line": line,
        "type": atype,
        "fixture_id": fixture_id,
        "message": message,
        "raw": raw or {},
    }


def _parse_and_classify(text: str) -> tuple[list[dict], list[dict], int]:
    """解析现场 CSV，返回 (参与核对的行, 异常行清单, 非空数据行总数)。

    异常四类：bad_row（坏行/缺列/非整数）、duplicate_id（重复 ID，首次
    出现且其余合法的行保留）、invalid_line（线路非 1..4）、out_of_range
    （起始/通道越界或闭区间越过 512）。一条物理行可产生多条异常记录。
    """
    records = list(csv.reader(io.StringIO(text)))
    nonempty = [
        (lineno, [cell.strip() for cell in row])
        for lineno, row in enumerate(records, start=1)
        if any(cell.strip() for cell in row)
    ]

    anomalies: list[dict] = []
    if not nonempty:
        anomalies.append(_anomaly(None, "bad_row", "CSV 没有数据行（连表头也无法识别为空表以外的内容）。"))
        return [], anomalies, 0

    header = _match_header(nonempty[0][1])
    if header is not None:
        data = nonempty[1:]

        def cells_of(row: list[str]) -> dict[str, str]:
            return {f: (row[header[f]].strip() if header[f] < len(row) else "") for f in FIELDS}
    else:
        data = nonempty

        def cells_of(row: list[str]) -> dict[str, str]:
            picked = {f: (row[i].strip() if i < len(row) else "") for i, f in enumerate(FIELDS)}
            extra = [c for c in row[len(FIELDS):] if c.strip()]
            if extra:
                # 按列位置解析时多余的非空列无法归属，按坏行隔离
                picked["__extra__"] = "，".join(extra)
            return picked

    if header is not None and not data:
        anomalies.append(_anomaly(None, "bad_row", "CSV 只有表头、没有数据行。"))
        return [], anomalies, 0

    accepted: list[dict] = []
    # ID 重复判定基于“结构上能解析出 ID”的所有行（首见行号），
    # 与该行其他字段是否合法无关：文件里确实出现了重复 ID 就必须暴露。
    first_seen: dict[int, int] = {}
    site_row_count = 0

    for lineno, row in data:
        site_row_count += 1
        cells = cells_of(row)
        raw = {f: cells.get(f, "") for f in FIELDS}
        extras = cells.get("__extra__")

        row_anoms: list[dict] = []
        missing = [FIELD_LABELS[f] for f in FIELDS if not cells.get(f)]
        if extras is not None:
            missing.append(f"多余列（{extras}）")
        nonint = [
            FIELD_LABELS[f]
            for f in FIELDS
            if cells.get(f) and not _is_int(cells[f])
        ]
        if missing or nonint:
            detail = []
            if missing:
                detail.append(f"字段不完整或无法归属：{'、'.join(missing)}")
            if nonint:
                detail.append(f"以下字段不是整数：{'、'.join(nonint)}")
            row_anoms.append(
                _anomaly(lineno, "bad_row", f"坏行：{'；'.join(detail)}。", raw=raw)
            )
            anomalies.extend(row_anoms)
            continue  # 结构损坏的行不再参与取值类校验

        vals = {f: int(cells[f]) for f in FIELDS}

        if vals["fixture_id"] in first_seen:
            row_anoms.append(
                _anomaly(
                    lineno,
                    "duplicate_id",
                    f"灯具ID {vals['fixture_id']} 重复（首次出现于第 {first_seen[vals['fixture_id']]} 行）。",
                    raw=raw,
                    fixture_id=vals["fixture_id"],
                )
            )
        else:
            first_seen[vals["fixture_id"]] = lineno

        if not 1 <= vals["line_id"] <= 4:
            row_anoms.append(
                _anomaly(
                    lineno,
                    "invalid_line",
                    f"线路 {vals['line_id']} 非法（DMX 线路须为 1..4）。",
                    raw=raw,
                    fixture_id=vals["fixture_id"],
                )
            )

        range_reasons = []
        if not 1 <= vals["start"] <= LINE_SIZE:
            range_reasons.append(f"起始地址 {vals['start']} 越界（须为 1..{LINE_SIZE}）")
        if vals["channels"] < 1:
            range_reasons.append(f"通道数 {vals['channels']} 非法（须 ≥ 1）")
        elif vals["channels"] > LINE_SIZE:
            range_reasons.append(f"通道数 {vals['channels']} 越界（单台最多 {LINE_SIZE}）")
        elif 1 <= vals["start"] <= LINE_SIZE and vals["start"] + vals["channels"] - 1 > LINE_SIZE:
            range_reasons.append(
                f"闭区间 {vals['start']}..{vals['start'] + vals['channels'] - 1}"
                f" 越过 {LINE_SIZE} 通道上限"
            )
        if range_reasons:
            row_anoms.append(
                _anomaly(
                    lineno,
                    "out_of_range",
                    "区间越界：" + "；".join(range_reasons) + "。",
                    raw=raw,
                    fixture_id=vals["fixture_id"],
                )
            )

        if row_anoms:
            anomalies.extend(row_anoms)
            continue
        accepted.append(
            {
                "fixture_id": vals["fixture_id"],
                "line_id": vals["line_id"],
                "start": vals["start"],
                "end": vals["start"] + vals["channels"] - 1,
                "channels": vals["channels"],
                "line_no": lineno,
            }
        )

    return accepted, anomalies, site_row_count


def _site_name(baseline_by_id: dict[int, dict], fixture_id: int) -> tuple[str | None, str | None]:
    base = baseline_by_id.get(fixture_id)
    if base is None:
        return None, None
    return base.get("name"), base.get("name_source")


def verify_site_csv(db: Session, plan_id: int, raw_bytes: bytes, mode: str) -> dict:
    if mode not in VALID_MODES:
        raise HTTPException(status_code=422, detail=f"未知核验模式：{mode}（须为 strict 或 isolate）")

    plan = db.get(Plan, plan_id)
    if plan is None or plan.status != "published":
        # 方案不存在或未发布时明确拒绝——草稿、已作废方案都不能作为核验基准
        raise HTTPException(status_code=404, detail="方案不存在或尚未发布，无法以其落点进行现场核验。")

    # 快照优先；旧库无快照时由 planner 按字段来源裁决还原——
    # 线路/起止/通道（PlanAllocation）仍是发布时事实，可作为核验基准。
    payload = planner.get_plan_payload(db, plan_id)
    baseline_source = "snapshot" if payload.get("from_snapshot") else "legacy_publish_record"
    baseline = [
        {
            "fixture_id": a["fixture_id"],
            "name": a.get("name"),
            "name_source": a.get("name_source"),
            "line_id": a["line_id"],
            "start": a["start"],
            "end": a["end"],
            "channels": a["channels"],
        }
        for a in payload["allocations"]
    ]
    baseline_by_id = {b["fixture_id"]: b for b in baseline}

    text = _decode(raw_bytes)
    accepted, anomalies, site_row_count = _parse_and_classify(text)
    anomaly_summary = {
        "bad_row": sum(1 for x in anomalies if x["type"] == "bad_row"),
        "duplicate_id": sum(1 for x in anomalies if x["type"] == "duplicate_id"),
        "invalid_line": sum(1 for x in anomalies if x["type"] == "invalid_line"),
        "out_of_range": sum(1 for x in anomalies if x["type"] == "out_of_range"),
    }
    isolated_lines = {x["line"] for x in anomalies if x["line"] is not None}

    base_result = {
        "plan_id": plan_id,
        "config_version": plan.config_version,
        "published_at": plan.published_at,
        "from_snapshot": payload.get("from_snapshot"),
        "baseline_source": baseline_source,
        "mode": mode,
        "baseline_count": len(baseline),
        "site_row_count": site_row_count,
        "accepted_count": len(accepted),
        "isolated_row_count": len(isolated_lines),
        "anomaly_summary": anomaly_summary,
        "anomalies": anomalies,
    }

    if mode == MODE_STRICT and anomalies:
        # 整表拒收：不做任何比对，也绝不报告一致
        return {
            **base_result,
            "verdict": "rejected",
            "matched_count": 0,
            "missing_count": 0,
            "extra_count": 0,
            "mismatch_count": 0,
            "overlap_count": 0,
            "matched": [],
            "missing": [],
            "extra": [],
            "mismatches": [],
            "overlaps": [],
            "message": (
                f"现场 CSV 存在 {len(anomalies)} 条异常（涉及 {len(isolated_lines)} 行），"
                "按“整表拒收”策略未进行落点核对；修正后重新上传，或改用“隔离异常行继续核对”。"
            ),
        }

    site_by_id = {row["fixture_id"]: row for row in accepted}

    # 1) 缺失：基准有、现场无（异常隔离掉的重复 ID 不在此重复计）
    missing = [dict(b) for b in baseline if b["fixture_id"] not in site_by_id]
    # 2) 额外：现场有、基准无
    extra = []
    for row in accepted:
        if row["fixture_id"] not in baseline_by_id:
            name, name_source = _site_name(baseline_by_id, row["fixture_id"])
            extra.append({**row, "name": name, "name_source": name_source})
    # 3) 落点不符：线路 / 地址（起始） / 通道数 三个维度分别裁决
    mismatches = []
    matched = []
    for row in accepted:
        base = baseline_by_id.get(row["fixture_id"])
        if base is None:
            continue
        line_mismatch = base["line_id"] != row["line_id"]
        address_mismatch = base["start"] != row["start"]
        channels_mismatch = base["channels"] != row["channels"]
        common = {
            "fixture_id": row["fixture_id"],
            "name": base.get("name"),
            "name_source": base.get("name_source"),
            "baseline": {
                "line_id": base["line_id"],
                "start": base["start"],
                "end": base["end"],
                "channels": base["channels"],
            },
            "site": {
                "line_id": row["line_id"],
                "start": row["start"],
                "end": row["end"],
                "channels": row["channels"],
            },
        }
        if line_mismatch or address_mismatch or channels_mismatch:
            mismatches.append(
                {
                    **common,
                    "line_mismatch": line_mismatch,
                    "address_mismatch": address_mismatch,
                    "channels_mismatch": channels_mismatch,
                }
            )
        else:
            matched.append(
                {
                    "fixture_id": row["fixture_id"],
                    "name": base.get("name"),
                    "name_source": base.get("name_source"),
                    **common["baseline"],
                }
            )

    # 4) 现场区间重叠：只在现场有效行之间、同线路上按闭区间两两求交；
    #    与基准是否重叠无关（基准落点求解时已保证互不重叠），单独成表。
    overlaps = []
    by_line: dict[int, list[dict]] = defaultdict(list)
    for row in accepted:
        by_line[row["line_id"]].append(row)
    for line_id in sorted(by_line):
        rows = sorted(by_line[line_id], key=lambda r: (r["start"], r["fixture_id"]))
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if b["start"] > a["end"]:
                    break  # 已按起点排序，之后不可能再与 a 相交
                if a["start"] <= b["end"] and b["start"] <= a["end"]:
                    name_a, src_a = _site_name(baseline_by_id, a["fixture_id"])
                    name_b, src_b = _site_name(baseline_by_id, b["fixture_id"])
                    overlaps.append(
                        {
                            "line_id": line_id,
                            "overlap_start": max(a["start"], b["start"]),
                            "overlap_end": min(a["end"], b["end"]),
                            "a": {
                                "fixture_id": a["fixture_id"],
                                "name": name_a,
                                "name_source": src_a,
                                "start": a["start"],
                                "end": a["end"],
                                "channels": a["channels"],
                                "line_no": a["line_no"],
                            },
                            "b": {
                                "fixture_id": b["fixture_id"],
                                "name": name_b,
                                "name_source": src_b,
                                "start": b["start"],
                                "end": b["end"],
                                "channels": b["channels"],
                                "line_no": b["line_no"],
                            },
                        }
                    )

    has_diff = bool(anomalies or missing or extra or mismatches or overlaps)
    verdict = "match" if not has_diff and accepted else "mismatch"
    if verdict == "match":
        message = (
            f"现场 {len(accepted)} 台灯的线路、起始地址与通道数闭区间与方案 "
            f"#{plan_id} 的发布落点完全一致，无缺失、额外、不符或区间重叠。"
        )
    else:
        parts = [
            f"缺失 {len(missing)}",
            f"额外 {len(extra)}",
            f"落点不符 {len(mismatches)}",
            f"区间重叠 {len(overlaps)} 对",
        ]
        if anomalies:
            parts.append(f"隔离异常 {len(anomalies)} 条")
        message = f"现场与方案 #{plan_id} 的发布落点不一致：{'、'.join(parts)}。"

    return {
        **base_result,
        "verdict": verdict,
        "matched_count": len(matched),
        "missing_count": len(missing),
        "extra_count": len(extra),
        "mismatch_count": len(mismatches),
        "overlap_count": len(overlaps),
        "matched": matched,
        "missing": missing,
        "extra": extra,
        "mismatches": mismatches,
        "overlaps": overlaps,
        "message": message,
    }
