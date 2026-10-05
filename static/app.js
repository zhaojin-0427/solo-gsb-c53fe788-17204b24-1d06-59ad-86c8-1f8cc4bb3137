/* DMX 灯具地址编排台 —— 原生 JavaScript 前端 */
"use strict";

const state = {
  catalog: [],
  fixtures: [],
  lines: [],
  reservations: [],
  version: null,
  latestPublishedPlanId: null,
  preview: null, // 当前展示的预览 payload（feasible 时）
  publishedPlans: [], // 已发布方案列表（现场核验基准选择）
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data && data.detail ? data.detail : `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- Tabs ----------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "published") loadPublished();
  });
});

// ---------- 全局版本 ----------
async function refreshVersion() {
  const v = await api("/api/plans/version");
  state.version = v.config_version;
  state.latestPublishedPlanId = v.latest_published_plan_id;
  $("#version-badge").textContent = `配置版本 v${v.config_version}`;
  $("#published-badge").textContent = v.latest_published_plan_id
    ? `已发布 #${v.latest_published_plan_id}`
    : "未发布";
  $("#published-badge").classList.toggle("badge-muted", !v.latest_published_plan_id);
  refreshStaleBanner();
}

function refreshStaleBanner() {
  const banner = $("#stale-banner");
  if (state.preview && state.preview.config_version !== state.version) {
    banner.textContent =
      `配置已变化（当前 v${state.version}，预览基于 v${state.preview.config_version}），请重新生成预览；旧预览无法发布。`;
    banner.classList.remove("hidden");
    $("#btn-publish").disabled = true;
  } else {
    banner.classList.add("hidden");
  }
}

// ---------- 型录 ----------
async function loadCatalog() {
  state.catalog = await api("/api/catalog");
  const list = $("#catalog-list");
  if (!state.catalog.length) {
    list.innerHTML = '<p class="muted">尚未导入任何型号。</p>';
  } else {
    list.innerHTML = state.catalog
      .map(
        (t) => `
      <div class="type-card">
        <div class="title">${esc(t.manufacturer)} ${esc(t.name)}
          <button class="danger" data-del-type="${t.id}" style="float:right;font-size:12px">删除型号</button>
        </div>
        <div>${t.modes
          .map((m) => `<span class="mode-chip">${esc(m.name)} · ${m.channels}ch</span>`)
          .join("")}</div>
      </div>`
      )
      .join("");
  }
  fillFixtureModeSelect();
}

$("#catalog-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.delType;
  if (id && confirm("确认删除该型号及其全部模式？被灯具实例引用时将被拒绝。")) {
    try {
      await api(`/api/catalog/${id}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadCatalog(), refreshVersion(), loadFixtures()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

const SAMPLE_CSV = `manufacturer,name,mode,channels
ACME,Solar 360,Basic,9
ACME,Solar 360,Extended,14
ACME,Solar 360,Full,22
BrightCo,MegaPar 200,3CH,3
BrightCo,MegaPar 200,8CH,8
BrightCo,MegaPar 200,11CH,11
LitePro,Beam 150,Standard,16
LitePro,Beam 150,Macro,20
StrobeKing,Storm 1k,Basic,2
StrobeKing,Storm 1k,DMX Pro,5`;

$("#btn-load-sample").addEventListener("click", () => {
  $("#catalog-text").value = SAMPLE_CSV;
});

async function importCatalogBody(body, isForm) {
  const opts = isForm ? { method: "POST", body } : { method: "POST", body: JSON.stringify(body) };
  const result = await api("/api/catalog/import", opts);
  $("#catalog-msg").innerHTML = `<span class="muted">新增型号 ${result.created_types}，更新型号 ${result.updated_types}，新增模式 ${result.created_modes}，更新模式通道数 ${result.updated_modes}</span>`;
  toast("型录导入成功", "success");
  await Promise.all([loadCatalog(), refreshVersion()]);
}

$("#catalog-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    await importCatalogBody(form, true);
    e.target.value = "";
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-import-text").addEventListener("click", async () => {
  const text = $("#catalog-text").value.trim();
  if (!text) return toast("请先粘贴 CSV/JSON 内容", "error");
  try {
    let rows;
    if (text.startsWith("[") || text.startsWith("{")) {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [parsed];
      await importCatalogBody(rows, false);
    } else {
      const form = new FormData();
      form.append("file", new Blob([text], { type: "text/csv" }), "catalog.csv");
      await importCatalogBody(form, true);
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---------- 灯具实例 ----------
function fillFixtureModeSelect() {
  const sel = $("#fixture-mode-select");
  const current = sel.value;
  sel.innerHTML = state.catalog
    .flatMap((t) =>
      t.modes.map(
        (m) =>
          `<option value="${m.id}">${esc(t.manufacturer)} ${esc(t.name)} / ${esc(m.name)} (${m.channels}ch)</option>`
      )
    )
    .join("");
  if (current) sel.value = current;
}

async function loadFixtures() {
  state.fixtures = await api("/api/fixtures");
  $("#fixture-count").textContent = state.fixtures.length;
  $("#fixture-tbody").innerHTML = state.fixtures
    .map(
      (f) => `
    <tr>
      <td>${f.id}</td>
      <td>${esc(f.name)}</td>
      <td>${esc(f.type_name || "-")}</td>
      <td>${esc(f.mode_name || "-")}</td>
      <td>${f.channels}</td>
      <td>${f.previous_line ?? "—"}</td>
      <td>${f.previous_start ?? "—"}</td>
      <td>${f.locked ? "🔒" : ""}</td>
      <td>
        <button data-edit="${f.id}">编辑</button>
        <button class="danger" data-del="${f.id}">删除</button>
      </td>
    </tr>`
    )
    .join("");
}

$("#fixture-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    name: fd.get("name").trim(),
    mode_id: Number(fd.get("mode_id")),
    previous_line: fd.get("previous_line") ? Number(fd.get("previous_line")) : null,
    previous_start: fd.get("previous_start") ? Number(fd.get("previous_start")) : null,
    locked: fd.get("locked") === "on",
  };
  try {
    await api("/api/fixtures", { method: "POST", body: JSON.stringify(body) });
    toast("灯具已添加", "success");
    e.target.reset();
    await Promise.all([loadFixtures(), refreshVersion()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#fixture-tbody").addEventListener("click", async (e) => {
  const delId = e.target.dataset.del;
  const editId = e.target.dataset.edit;
  if (delId && confirm("确认删除该灯具实例？")) {
    try {
      await api(`/api/fixtures/${delId}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadFixtures(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  } else if (editId) {
    const f = state.fixtures.find((x) => x.id === Number(editId));
    const name = prompt("灯具名称", f.name);
    if (name === null) return;
    const line = prompt("既有线路 (1-4，留空表示无)", f.previous_line ?? "");
    if (line === null) return;
    const start = prompt("既有起始地址 (1-512，留空表示无)", f.previous_start ?? "");
    if (start === null) return;
    const locked = confirm("确定 = 锁定到既有线路与地址；取消 = 不锁定");
    try {
      await api(`/api/fixtures/${editId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: name.trim() || f.name,
          previous_line: line.trim() ? Number(line) : null,
          previous_start: start.trim() ? Number(start) : null,
          locked,
        }),
      });
      toast("已更新", "success");
      await Promise.all([loadFixtures(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

// ---------- 线路与保留区 ----------
async function loadLines() {
  state.lines = await api("/api/lines");
  $("#line-tbody").innerHTML = state.lines
    .map(
      (l) => `
    <tr>
      <td>${l.id}</td>
      <td><input value="${esc(l.name)}" data-line-name="${l.id}" style="width:180px" /></td>
      <td>
        <label class="switch">
          <input type="checkbox" data-line-active="${l.id}" ${l.is_active ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </td>
      <td><button data-line-save="${l.id}">保存</button></td>
    </tr>`
    )
    .join("");
  $("#res-line").innerHTML = state.lines
    .map((l) => `<option value="${l.id}">${l.id} - ${esc(l.name)}</option>`)
    .join("");
}

$("#line-tbody").addEventListener("click", async (e) => {
  const id = e.target.dataset.lineSave;
  if (!id) return;
  const name = $(`[data-line-name="${id}"]`).value;
  const isActive = $(`[data-line-active="${id}"]`).checked;
  try {
    await api(`/api/lines/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, is_active: isActive }),
    });
    toast("线路已更新", "success");
    await Promise.all([loadLines(), refreshVersion(), loadReservations()]);
  } catch (err) {
    toast(err.message, "error");
    await loadLines();
  }
});

async function loadReservations() {
  state.reservations = await api("/api/reservations");
  const lineName = Object.fromEntries(state.lines.map((l) => [l.id, l.name]));
  $("#reservation-tbody").innerHTML = state.reservations
    .map(
      (r) => `
    <tr>
      <td>${r.id}</td>
      <td>${r.line_id} - ${esc(lineName[r.line_id] || "")}</td>
      <td>${r.start}</td>
      <td>${r.end}</td>
      <td>${r.end - r.start + 1}</td>
      <td>${esc(r.reason)}</td>
      <td><button class="danger" data-del-res="${r.id}">删除</button></td>
    </tr>`
    )
    .join("");
}

$("#reservation-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    line_id: Number(fd.get("line_id")),
    start: Number(fd.get("start")),
    end: Number(fd.get("end")),
    reason: fd.get("reason") || "",
  };
  try {
    await api("/api/reservations", { method: "POST", body: JSON.stringify(body) });
    toast("保留区已添加", "success");
    e.target.reset();
    await Promise.all([loadReservations(), refreshVersion()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#reservation-tbody").addEventListener("click", async (e) => {
  const id = e.target.dataset.delRes;
  if (id && confirm("确认删除该保留区？")) {
    try {
      await api(`/api/reservations/${id}`, { method: "DELETE" });
      toast("已删除", "success");
      await Promise.all([loadReservations(), refreshVersion()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

// ---------- 编排预览 ----------
$("#btn-preview").addEventListener("click", generatePreview);

async function generatePreview() {
  try {
    const result = await api("/api/plans/preview", { method: "POST" });
    // 只有逐级证明最优（optimal）的预览才可发布；未证最优结果不得进入发布流程。
    state.preview = result.feasible && result.optimality_status === "optimal" ? result : null;
    renderPreview(result);
    await refreshVersion();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderPreview(p) {
  const conflictPanel = $("#conflict-panel");
  const unprovenPanel = $("#unproven-panel");
  const migrationPanel = $("#migration-panel");
  const allocPanel = $("#alloc-panel");

  if (p.optimality_status === "unproven") {
    // 未证最优：一律不可发布。按是否取得完整可用排布（feasible）分两种展示——
    // 有候选：展示候选排布仅供参考；空候选：暂无可展示排布，且不当作已证无解。
    const hasCandidate = p.feasible && Array.isArray(p.allocations) && p.allocations.length > 0;
    unprovenPanel.classList.remove("hidden");
    $("#unproven-msg").textContent = p.message || "未能在限定时间内证明最优。";
    $("#unproven-detail").textContent = hasCandidate
      ? "求解器在限定时间内只找到可行候选，未能逐级证明“迁移台数最少 → 启用线路数最少 → 字典序最小”。下列排布仅供参考，未生成可发布草稿；请减少灯具数量或稍后重新生成预览。"
      : "求解器在限定时间内未取得任何可展示的候选排布（暂无可展示排布）。这不是已证明无解：约束可能仍有可行排布，只是本次求解未能取得。未生成草稿，也不能发布；请减少灯具数量、放宽部分锁定或稍后重新生成预览。";
    conflictPanel.classList.add("hidden");
    $("#btn-publish").disabled = true;
    if (hasCandidate) {
      allocPanel.classList.remove("hidden");
      $("#plan-summary").textContent =
        `候选预览（未证最优，不可发布）· 基于配置 v${p.config_version}` +
        ` · 迁移 ${p.migration_count} 台 · 启用 ${p.used_lines} 条线路`;
      renderTracks(p.occupancy);
      renderMigrations(p.migrations);
      renderAllocations(p.allocations);
    } else {
      migrationPanel.classList.add("hidden");
      allocPanel.classList.add("hidden");
      $("#tracks").innerHTML = "";
      $("#plan-summary").textContent =
        `暂无可展示排布（未证最优，未生成草稿）· 基于配置 v${p.config_version}`;
    }
    return;
  }

  unprovenPanel.classList.add("hidden");

  if (!p.feasible) {
    conflictPanel.classList.remove("hidden");
    migrationPanel.classList.add("hidden");
    allocPanel.classList.add("hidden");
    $("#tracks").innerHTML = "";
    $("#btn-publish").disabled = true;
    $("#plan-summary").textContent = "无可行方案";
    $("#conflict-list").innerHTML = p.conflicts
      .map((c) => `<li><strong>[${esc(c.type)}]</strong> ${esc(c.message)}</li>`)
      .join("");
    return;
  }

  conflictPanel.classList.add("hidden");
  allocPanel.classList.remove("hidden");
  $("#plan-summary").textContent =
    `预览 #${p.plan_id} · 基于配置 v${p.config_version} · ✅ 已逐级证明最优` +
    ` · 迁移 ${p.migration_count} 台 · 启用 ${p.used_lines} 条线路`;

  renderTracks(p.occupancy);
  renderMigrations(p.migrations);
  renderAllocations(p.allocations);

  const fresh = p.config_version === state.version;
  $("#btn-publish").disabled = !fresh;
}

function renderTracks(occupancy) {
  const pct = (addr) => `calc(${(addr - 1) / 512 * 100}%)`;
  const widthPct = (a, b) => `calc(${(b - a + 1) / 512 * 100}%)`;
  $("#tracks").innerHTML = occupancy
    .map((line) => {
      const resBlocks = line.reservations
        .map(
          (r) =>
            `<div class="block reserved" style="left:${pct(r.start)};width:${widthPct(r.start, r.end)}"
              title="保留区 #${r.id}：${r.start}-${r.end} ${esc(r.reason)}">保 #${r.id}</div>`
        )
        .join("");
      const fxBlocks = line.fixtures
        .map((f) => {
          const cls = f.locked ? "locked" : f.migrated ? "migrated" : "fixture";
          return `<div class="block ${cls}" style="left:${pct(f.start)};width:${widthPct(f.start, f.end)}"
            title="#${f.fixture_id} ${esc(f.name)}：${f.start}-${f.end}（${f.channels}ch）${f.locked ? " 🔒锁定" : f.migrated ? " 迁移" : ""}">
            ${f.channels >= 14 ? esc(f.name) : f.fixture_id}</div>`;
        })
        .join("");
      return `
      <div class="track ${line.is_active ? "" : "disabled"}">
        <div class="track-head">
          <strong>线路 ${line.line_id} · ${esc(line.name)}</strong>${line.is_active ? "" : "（已停用）"}
          <span class="muted">已用 ${line.used_channels}/512，空闲 ${line.free_channels}</span>
        </div>
        <div class="track-bar">${line.is_active ? resBlocks + fxBlocks : ""}</div>
        <div class="track-scale"><span>1</span><span>128</span><span>256</span><span>384</span><span>512</span></div>
      </div>`;
    })
    .join("");
}

function addrOr(v) {
  return v ?? "—";
}

function renderMigrations(migrations) {
  const panel = $("#migration-panel");
  $("#migration-count").textContent = migrations.length;
  if (!migrations.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#migration-tbody").innerHTML = migrations
    .map(
      (m) => `
    <tr>
      <td>${m.fixture_id}</td><td>${esc(m.name)}</td>
      <td>${addrOr(m.from_line)}</td><td>${addrOr(m.from_start)}</td>
      <td>➡️</td>
      <td>${m.to_line}</td><td>${m.to_start}</td>
      <td>${m.locked ? "🔒" : ""}</td>
    </tr>`
    )
    .join("");
}

function renderAllocations(allocations) {
  $("#alloc-tbody").innerHTML = allocations
    .map(
      (a) => `
    <tr>
      <td>${a.fixture_id}</td><td>${esc(a.name)}</td>
      <td>${a.line_id}</td><td>${a.start}</td><td>${a.end}</td><td>${a.channels}</td>
      <td>${a.locked ? "🔒 锁定" : a.migrated ? "🟠 迁移" : "✅ 原位"}</td>
    </tr>`
    )
    .join("");
}

$("#btn-publish").addEventListener("click", async () => {
  if (!state.preview) return;
  if (state.preview.optimality_status !== "optimal") {
    toast("该预览未证明最优，不能发布", "error");
    return;
  }
  if (state.preview.config_version !== state.version) {
    toast("配置版本已过期，请重新生成预览", "error");
    return;
  }
  if (!confirm("确认按当前预览原子发布？发布后旧预览立即失效。")) return;
  try {
    const result = await api(`/api/plans/${state.preview.plan_id}/publish`, { method: "POST" });
    toast(`已发布 #${result.plan_id}（配置 v${result.config_version}）`, "success");
    state.preview = null;
    $("#plan-summary").textContent = "发布完成，可在“已发布”页签下载 CSV";
    $("#btn-publish").disabled = true;
    await Promise.all([refreshVersion(), loadFixtures()]);
    loadPublished();
  } catch (err) {
    toast(err.message, "error");
    await refreshVersion();
  }
});

// ---------- 已发布 ----------
// 名称来源标注：无快照旧记录的名称是当前值（current），灯具已删除则不可用
// （unavailable）；快照记录无该字段，名称即发布时事实，不加标注。
function publishedNameSuffix(source) {
  if (source === "current") return ' <span class="muted">（当前名称）</span>';
  if (source === "unavailable") return ' <span class="muted">（名称不可用）</span>';
  return "";
}

async function loadPublished() {
  const data = await api("/api/plans/published/latest");
  // 同步拉取已发布方案清单，填充现场核验的基准选择（保留当前选择）
  await loadPublishedPlans(data.has_published ? data.plan_id : null);
  const empty = $("#published-empty");
  const content = $("#published-content");
  if (!data.has_published) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  content.classList.remove("hidden");
  // 已发布地址表来自发布时的不可变快照：发布后改名、切换锁定、调整保留区
  // 都不会改变此表与 CSV；仅旧库缺少快照的记录按字段来源裁决重建并提示——
  // 名称标注“当前名称”，无法还原的锁定状态显示“未知”而非“否”。
  const legacy = data.from_snapshot === false;
  const when = new Date(data.published_at || data.created_at).toLocaleString("zh-CN");
  $("#published-meta").textContent =
    `发布 #${data.plan_id} · 配置 v${data.config_version} · ${when} · 迁移 ${data.migration_count} 台 · 启用 ${data.used_lines} 条线路`;
  const notice = $("#published-notice");
  if (legacy) {
    notice.textContent =
      data.notice || "该发布记录缺少快照：地址与迁移标记为发布时事实，名称为当前值，锁定/迁移起点/保留区占用未知。";
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }
  $("#btn-download-csv").href = `/api/plans/published/${data.plan_id}/csv`;
  // 除地址表外，同步渲染迁移清单与各线路占用块，供逐项核对
  renderPublishedTracks(data.occupancy || []);
  renderPublishedMigrations(data.migrations || []);
  $("#published-tbody").innerHTML = data.allocations
    .map((a) => {
      const nameSuffix = publishedNameSuffix(a.name_source);
      // locked 为 null 表示历史锁定状态无法还原：显示“未知”，不得当作未锁定
      const lockedCell = a.locked === null || a.locked === undefined ? "未知" : a.locked ? "🔒" : "";
      return `
    <tr>
      <td>${a.fixture_id}</td><td>${esc(a.name)}${nameSuffix}</td>
      <td>${a.line_id}</td><td>${a.start}</td><td>${a.end}</td><td>${a.channels}</td>
      <td>${a.migrated ? "🟠 是" : "否"}</td><td>${lockedCell}</td>
    </tr>`;
    })
    .join("");
}

// 已发布占用采用独立渲染，不复用预览的 renderTracks：预览组件要求 reservations
// 必为数组且停用线路不画块；而无快照旧记录的占用中 reservations 与含保留区的
// 已用/空闲数为 null（未知）、名称与线路启停是当前现状。若复用，旧记录的 null
// 会被当成“无保留区/零通道”、现状停用会隐藏发布时灯具块——两者都会改写历史
// 占用。独立渲染让旧记录的 null 与现状启停只以“未知/当前”标注呈现，快照记录
// 则照常显示完整快照值；预览路径行为完全不变。
function renderPublishedTracks(occupancy) {
  const pct = (addr) => `calc(${(addr - 1) / 512 * 100}%)`;
  const widthPct = (a, b) => `calc(${(b - a + 1) / 512 * 100}%)`;
  $("#published-tracks").innerHTML = occupancy
    .map((line) => {
      // 保留区无法还原（null）时不画保留块、不计入已用：显示“未知”，不得当作无保留区
      const resUnknown = line.reservations === null || line.reservations === undefined;
      const resBlocks = resUnknown
        ? ""
        : line.reservations
            .map(
              (r) =>
                `<div class="block reserved" style="left:${pct(r.start)};width:${widthPct(r.start, r.end)}"
                  title="保留区 #${r.id}：${r.start}-${r.end} ${esc(r.reason)}">保 #${r.id}</div>`
            )
            .join("");
      // 灯具块是发布时事实：线路后来停用（或当时停用）也必须画出，不得隐藏
      const fxBlocks = (line.fixtures || [])
        .map((f) => {
          // 历史锁定未知（null）时按普通灯具着色并标注“锁定未知”，不得当作未锁定；
          // 迁移标记是发布时事实，与锁定状态各自独立标注
          const lockedUnknown = f.locked === null || f.locked === undefined;
          const cls = f.locked ? "locked" : f.migrated ? "migrated" : "fixture";
          const stateTip =
            (f.migrated ? " 迁移" : "") + (lockedUnknown ? " 锁定未知" : f.locked ? " 🔒锁定" : "");
          const nameTip =
            f.name_source === "current" ? "（当前名称）" : f.name_source === "unavailable" ? "（名称不可用）" : "";
          return `<div class="block ${cls}" style="left:${pct(f.start)};width:${widthPct(f.start, f.end)}"
            title="#${f.fixture_id} ${esc(f.name)}${nameTip}：${f.start}-${f.end}（${f.channels}ch）${stateTip}">
            ${f.channels >= 14 ? esc(f.name) : f.fixture_id}</div>`;
        })
        .join("");
      // 线路名称与启停为当前现状时标注来源；启停是现状，不影响发布时灯具块的展示
      const lineNameSuffix = line.name_source === "current" ? ' <span class="muted">（当前名称）</span>' : "";
      const activeLabel = line.is_active
        ? line.is_active_source === "current"
          ? ' <span class="muted">（当前启用）</span>'
          : ""
        : line.is_active_source === "current"
          ? ' <span class="muted">（当前已停用）</span>'
          : "（已停用）";
      // 含保留区的已用/空闲无法还原（null）时显示“未知”，不得当作零；
      // 另给出仅灯具占用的事实部分（fixtures_used_channels）
      const size = line.size ?? 512;
      let usage;
      if (line.used_channels === null || line.used_channels === undefined) {
        usage = `已用 未知/${size}，空闲 未知`;
        if (line.fixtures_used_channels !== null && line.fixtures_used_channels !== undefined) {
          usage += `（其中灯具占用 ${line.fixtures_used_channels} 通道，为发布时事实）`;
        }
      } else {
        usage = `已用 ${line.used_channels}/${size}，空闲 ${line.free_channels}`;
      }
      const resNote = resUnknown ? " · 保留区：未知（无法还原）" : "";
      return `
      <div class="track ${line.is_active ? "" : "disabled"}">
        <div class="track-head">
          <strong>线路 ${line.line_id} · ${esc(line.name)}</strong>${lineNameSuffix}${activeLabel}
          <span class="muted">${usage}${resNote}</span>
        </div>
        <div class="track-bar">${resBlocks + fxBlocks}</div>
        <div class="track-scale"><span>1</span><span>128</span><span>256</span><span>384</span><span>512</span></div>
      </div>`;
    })
    .join("");
}

function renderPublishedMigrations(migrations) {
  const panel = $("#published-migration-panel");
  $("#published-migration-count").textContent = migrations.length;
  if (!migrations.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#published-migration-tbody").innerHTML = migrations
    .map((m) => {
      const nameSuffix = publishedNameSuffix(m.name_source);
      // 迁移落点（新线路/新地址）是留存事实；起点无法还原（null）时显示“未知”，
      // 不得当作无起点；历史锁定未知时同样显示“未知”，不得当作未锁定
      const fromLine = m.from_line === null || m.from_line === undefined ? "未知" : m.from_line;
      const fromStart = m.from_start === null || m.from_start === undefined ? "未知" : m.from_start;
      const lockedCell = m.locked === null || m.locked === undefined ? "未知" : m.locked ? "🔒" : "";
      return `
    <tr>
      <td>${m.fixture_id}</td><td>${esc(m.name)}${nameSuffix}</td>
      <td>${fromLine}</td><td>${fromStart}</td>
      <td>➡️</td>
      <td>${m.to_line}</td><td>${m.to_start}</td>
      <td>${lockedCell}</td>
    </tr>`;
    })
    .join("");
}

// ---------- 现场地址核验 ----------
async function loadPublishedPlans(preferId = null) {
  state.publishedPlans = await api("/api/plans/published");
  const sel = $("#verify-plan-select");
  const prev = sel.value || String(preferId ?? "");
  sel.innerHTML = state.publishedPlans
    .map((p) => {
      const when = new Date(p.published_at).toLocaleString("zh-CN");
      const src = p.from_snapshot ? "快照" : "旧记录落点";
      return `<option value="${p.id}">#${p.id} · v${p.config_version} · ${when} · ${p.fixture_count} 台（${src}）</option>`;
    })
    .join("");
  if (prev && state.publishedPlans.some((p) => String(p.id) === prev)) {
    sel.value = prev;
  } else if (state.publishedPlans.length) {
    sel.value = String(state.publishedPlans[0].id);
  }
  updateVerifyHint();
}

function updateVerifyHint() {
  const p = state.publishedPlans.find((x) => String(x.id) === $("#verify-plan-select").value);
  $("#verify-hint").textContent = p
    ? `基准：#${p.id} 共 ${p.fixture_count} 台灯，来源 ${p.from_snapshot ? "发布快照" : "旧记录留存落点"}`
    : "";
}

$("#verify-plan-select").addEventListener("change", updateVerifyHint);

function csvBlob(rows) {
  return new Blob(["﻿" + rows], { type: "text/csv;charset=utf-8" });
}

// 模板：以所选方案的基准落点预填，供现场人员核对/替换为实测值
$("#btn-verify-template").addEventListener("click", async () => {
  const planId = $("#verify-plan-select").value;
  if (!planId) return toast("尚无已发布方案可作为基准", "error");
  try {
    const data = await api(`/api/plans/${planId}`);
    const lines = ["灯具ID,线路,起始地址,通道数"];
    for (const a of data.allocations) {
      lines.push(`${a.fixture_id},${a.line_id},${a.start},${a.channels}`);
    }
    const url = URL.createObjectURL(csvBlob(lines.join("\r\n") + "\r\n"));
    const a = document.createElement("a");
    a.href = url;
    a.download = `verify_template_plan${planId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-verify").addEventListener("click", async () => {
  const planId = $("#verify-plan-select").value;
  const fileInput = $("#verify-file");
  const file = fileInput.files[0];
  if (!planId) return toast("请先发布至少一个方案", "error");
  if (!file) return toast("请选择现场 CSV 文件", "error");
  const btn = $("#btn-verify");
  btn.disabled = true;
  btn.textContent = "核验中…";
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", $("#verify-mode-select").value);
    const res = await fetch(`/api/plans/${planId}/verify`, { method: "POST", body: fd });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 404) throw new Error(typeof data.detail === "string" ? data.detail : "方案不存在或尚未发布");
    if (!res.ok && !(res.status === 422 && data && data.verdict)) {
      const detail = data && data.detail ? data.detail : `HTTP ${res.status}`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    // 422 + verdict=rejected 表示“整表拒收”，页面同样渲染完整异常清单
    renderVerifyResult(data);
  } catch (err) {
    toast(err.message, "error");
    $("#verify-result").classList.add("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "上传并核验";
    fileInput.value = "";
  }
});

const VERIFY_ANOMALY_LABELS = {
  bad_row: "坏行",
  duplicate_id: "重复 ID",
  invalid_line: "非法线路",
  out_of_range: "区间越界",
};

function nameCell(name, source) {
  if (name === null || name === undefined) return '<span class="muted">基准外灯具</span>';
  const suffix = source === "current"
    ? ' <span class="muted">（当前名称）</span>'
    : source === "unavailable"
      ? ' <span class="muted">（名称不可用）</span>'
      : "";
  return `${esc(name)}${suffix}`;
}

function renderVerifyResult(r) {
  const box = $("#verify-result");
  box.classList.remove("hidden");

  const verdictMap = {
    match: ["ok", "✅ 整表一致", "与所选版本发布落点完全一致（无缺失、额外、不符或重叠）。"],
    mismatch: ["bad", "❌ 不一致", r.message],
    rejected: ["warn", "⛔ 整表拒收", r.message],
  };
  const [cls, title, message] = verdictMap[r.verdict] || ["bad", "？", r.message || ""];

  const summaryChips = [
    `基准 ${r.baseline_count} 台`,
    `现场有效行 ${r.accepted_count} 行`,
    `缺失 ${r.missing_count}`,
    `额外 ${r.extra_count}`,
    `落点不符 ${r.mismatch_count}`,
    `区间重叠 ${r.overlap_count} 对`,
    `一致 ${r.matched_count} 台`,
  ];
  if (r.isolated_row_count) summaryChips.push(`隔离异常行 ${r.isolated_row_count} 行`);

  const anomaliesTable = !r.anomalies.length ? "" : `
    <section class="verify-section">
      <h3>异常行${r.verdict === "rejected" ? "（整表拒收，未进行核对）" : "（已隔离，不参与对齐与重叠判定）"} <span class="count">${r.anomalies.length}</span></h3>
      <table class="data">
        <thead><tr><th>CSV 行号</th><th>类型</th><th>灯具ID</th><th>问题</th><th>原始内容</th></tr></thead>
        <tbody>${r.anomalies.map((x) => `
          <tr>
            <td>${x.line ?? "—"}</td>
            <td><span class="tag tag-anom">${VERIFY_ANOMALY_LABELS[x.type] || x.type}</span></td>
            <td>${x.fixture_id ?? "—"}</td>
            <td>${esc(x.message)}</td>
            <td><code>${esc(["fixture_id", "line_id", "start", "channels"].map((k) => x.raw?.[k] ?? "").join(" | "))}</code></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>`;

  const missingTable = section("缺失灯具（基准有、现场没有）", r.missing_count, `
    <thead><tr><th>灯具ID</th><th>名称</th><th>线路</th><th>起始</th><th>结束</th><th>通道数</th></tr></thead>
    <tbody>${r.missing.map((b) => `
      <tr><td>${b.fixture_id}</td><td>${nameCell(b.name, b.name_source)}</td>
      <td>${b.line_id}</td><td>${b.start}</td><td>${b.end}</td><td>${b.channels}</td></tr>`).join("")}</tbody>`);

  const extraTable = section("额外灯具（现场有、基准没有）", r.extra_count, `
    <thead><tr><th>灯具ID</th><th>名称</th><th>线路</th><th>起始</th><th>结束</th><th>通道数</th><th>CSV 行号</th></tr></thead>
    <tbody>${r.extra.map((x) => `
      <tr><td>${x.fixture_id}</td><td>${nameCell(x.name, x.name_source)}</td>
      <td>${x.line_id}</td><td>${x.start}</td><td>${x.end}</td><td>${x.channels}</td><td>${x.line_no}</td></tr>`).join("")}</tbody>`);

  // 地址差异与通道差异分别呈现：每行标注三个独立标记，维度列明确给出基准→现场
  const mismatchTable = section("落点不符（线路 / 地址 / 通道 分别裁决）", r.mismatch_count, `
    <thead><tr><th>灯具ID</th><th>名称</th><th>不符维度</th>
      <th>线路（基准 → 现场）</th><th>起始地址（基准 → 现场）</th>
      <th>闭区间（基准 → 现场）</th><th>通道数（基准 → 现场）</th></tr></thead>
    <tbody>${r.mismatches.map((m) => {
      const tags = [
        m.line_mismatch ? '<span class="tag tag-bad">线路不符</span>' : "",
        m.address_mismatch ? '<span class="tag tag-bad">地址不符</span>' : "",
        m.channels_mismatch ? '<span class="tag tag-bad">通道不符</span>' : "",
      ].join(" ");
      const cell = (bad) => (bad ? "cell-bad" : "cell-ok");
      return `
      <tr>
        <td>${m.fixture_id}</td><td>${nameCell(m.name, m.name_source)}</td><td>${tags}</td>
        <td class="${cell(m.line_mismatch)}">${m.baseline.line_id} → ${m.site.line_id}</td>
        <td class="${cell(m.address_mismatch)}">${m.baseline.start} → ${m.site.start}</td>
        <td class="${cell(m.address_mismatch || m.channels_mismatch)}">${m.baseline.start}-${m.baseline.end} → ${m.site.start}-${m.site.end}</td>
        <td class="${cell(m.channels_mismatch)}">${m.baseline.channels} → ${m.site.channels}</td>
      </tr>`;
    }).join("")}</tbody>`);

  // 跨行重叠单独成表，与地址差异分开呈现
  const overlapTable = section("现场区间重叠（现场行之间、同线路闭区间相交）", r.overlap_count, `
    <thead><tr><th>线路</th><th>重叠区间</th><th>灯具 A（ID/区间/行号）</th><th>灯具 B（ID/区间/行号）</th></tr></thead>
    <tbody>${r.overlaps.map((o) => `
      <tr>
        <td>${o.line_id}</td>
        <td><span class="tag tag-bad">${o.overlap_start}-${o.overlap_end}（${o.overlap_end - o.overlap_start + 1}ch）</span></td>
        <td>#${o.a.fixture_id} ${nameCell(o.a.name, o.a.name_source)} ${o.a.start}-${o.a.end} <span class="muted">第 ${o.a.line_no} 行</span></td>
        <td>#${o.b.fixture_id} ${nameCell(o.b.name, o.b.name_source)} ${o.b.start}-${o.b.end} <span class="muted">第 ${o.b.line_no} 行</span></td>
      </tr>`).join("")}</tbody>`);

  const matchedTable = section("逐项一致", r.matched_count, `
    <thead><tr><th>灯具ID</th><th>名称</th><th>线路</th><th>起始</th><th>结束</th><th>通道数</th></tr></thead>
    <tbody>${r.matched.map((b) => `
      <tr><td>${b.fixture_id}</td><td>${nameCell(b.name, b.name_source)}</td>
      <td>${b.line_id}</td><td>${b.start}</td><td>${b.end}</td><td>${b.channels}</td></tr>`).join("")}</tbody>`);

  box.innerHTML = `
    <div class="verify-verdict ${cls}">
      <strong>${title}</strong>
      <span>${esc(message)}</span>
      <div class="verify-chips">${summaryChips.map((c) => `<span class="verify-chip">${c}</span>`).join("")}</div>
      <div class="muted">基准来源：${r.baseline_source === "snapshot" ? "发布快照（发布时事实）" : "旧记录留存落点（PlanAllocation 明细）"} · 配置 v${r.config_version}</div>
    </div>
    ${anomaliesTable}
    ${missingTable}
    ${extraTable}
    ${mismatchTable}
    ${overlapTable}
    ${matchedTable}`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function section(titleText, count, tableInner) {
  if (!count) return "";
  return `
    <section class="verify-section">
      <h3>${titleText} <span class="count">${count}</span></h3>
      <table class="data">${tableInner}</table>
    </section>`;
}

// ---------- 启动 ----------
(async function init() {
  try {
    await Promise.all([loadCatalog(), loadFixtures(), loadLines(), refreshVersion()]);
    await loadReservations();
  } catch (err) {
    toast("初始化失败：" + err.message, "error");
  }
})();
