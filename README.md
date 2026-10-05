# DMX 灯具地址编排台

本地运行的 DMX 灯具地址编排 Web 应用：导入灯具型录、建立灯具实例与最多四条 512 通道线路、设置保留区，
由 OR-Tools CP-SAT 求解器在不跨线路、通道连续、无重叠的前提下完成地址编排，支持预览、原子发布与 CSV 导出。

## 功能

- **灯具型录管理**：按 `manufacturer,name,mode,channels` 导入 CSV/JSON；同一型号支持多个模式（占用通道数不同），重复模式更新通道数。
- **灯具实例**：为灯具选择型号/模式，记录上一版线路与起始地址，可锁定既有线路与起始地址。
- **线路与保留区**：固定 4 条 × 512 通道线路，可重命名、停用；每条线路可设置保留通道区。
- **编排规则**：每台灯具获得一段连续通道，不跨线路、不与其他灯具或保留区重叠；锁定灯具必须留在原位。
- **优化目标（按优先级，逐级证明）**：
  1. 已配灯具的**迁移台数最少**；
  2. 在此前提下**启用线路数最少**；
  3. 再按灯具 ID 排序，逐台取 `(线路 ID, 起始地址)` **字典序最小**的确定方案。

  三个阶段都要求 CP-SAT 返回 `OPTIMAL`（真正证明最优）后才采信目标值并固定进入下一级；
  任一阶段限时内只拿到 `FEASIBLE`（可行但未证明最优的候选）时，**不固定其取值继续求解**，
  而是返回与“真正无解”明确区分的“未证最优”状态。
- **预览的四种结果**（均为 HTTP 200，由 `optimality_status` 与 `feasible` 共同区分）：
  - `optimal`：三级目标均已证明最优，持久化为草稿并返回 `plan_id`，可以发布；
  - `unproven` 且 `feasible=true`：有可行候选但未能逐级证明最优，返回候选占用供参考，
    但**无 `plan_id`、不生成可发布草稿**；
  - `unproven` 且 `feasible=false`（空候选）：求解返回 UNKNOWN、候选读取失败或冲突诊断
    超时，未能取得任何完整可用排布。页面提示“暂无可展示排布”，**不当作已证无解**，
    同样不生成草稿、不能发布；
  - `infeasible`：已证明无解，给出具体冲突约束（容量不足、锁定越界、锁定块互相重叠/与保留区冲突、碎块不可排布等）。
- **原子发布**：预览绑定配置版本与最优性状态；配置一旦变化旧预览立即失效并拒绝发布（409），
  未证最优或旧版本遗留、**没有最优性证明记录的草稿同样拒发（409）**，需重新生成预览。
  发布在单个数据库事务内完成，并写入不可变快照。
- **已发布地址表来自快照**：`GET /api/plans/{id}`（已发布方案）与 `GET /api/plans/published/latest`
  从发布时写入的不可变快照还原地址、名称、锁定、迁移与占用信息——发布后改名、切换锁定、
  调整保留区或重命名线路都不会让已发布表与快照 CSV 漂移；已发布状态与原配置版本以方案记录为准，
  不会把快照里发布前的 draft 状态直接返回。草稿仍按当前配置实时重建。
  “已发布”页签完整展示**线路占用轨（各线路灯具块）、迁移清单（逐台落点）与地址表**三部分，
  可逐项核对；有快照的记录一律显示完整快照值。
  旧库缺少快照的发布记录仍可查询与下载：响应以 `from_snapshot=false`、`field_sources` 与
  `notice` 逐项标注字段来源——留存明细中的线路、起止地址与逐台迁移标记仍是发布时事实；
  名称取当前值并标注来源；无法还原的历史锁定、迁移起点与保留区占用标为未知（`null`），
  不会把未知写成“否”（详见下文“无快照旧发布记录的字段含义”）。页面对此类记录同样展示
  迁移清单与占用轨：迁移起点、历史锁定、保留区及含保留区的已用/空闲数显示“未知”，
  名称与线路启停标注“当前”来源，线路后来停用也不会隐藏发布时的灯具块。
- **浏览器防护**：只有 `optimal` 且配置版本未过期的预览可发布；未证最优时显示黄色
  “未证最优（不可发布）”面板——有候选时展示候选排布仅供参考，空候选时提示
  “暂无可展示排布”；两种情况下发布按钮都保持禁用。
- **CSV 导出**：已发布地址表（UTF-8 带 BOM，Excel 可直接打开），与“已发布”页签同源——
  均取自发布快照，页面看到的内容与下载的 CSV 始终一致。无快照旧记录的 CSV 列保持不变，
  但历史锁定状态写“未知”（而非“是/否”），当前名称以“（当前名称）”后缀标注来源。
- **现场地址核验（“已发布”页签内）**：选择任一已发布方案作为基准版本，上传现场导出的
  CSV（列：`灯具ID,线路,起始地址,通道数`；表头支持中英文别名，无表头时按列位置解析；
  闭区间按 `起始地址 .. 起始地址+通道数−1` 计算，上限 512）。服务端以**所选版本的发布
  快照**为基准（旧库无快照时以 PlanAllocation **留存落点**为基准），按灯具 ID 对齐，
  分别给出：
  - **缺失**（基准有、现场没有）、**额外**（现场有、基准没有）；
  - **落点不符**：线路不符、地址（起始）不符、通道数不符三个维度分别标注（同灯可同时
    命中多项），并逐列给出基准值 → 现场值；
  - **现场区间重叠**：现场有效行之间、同线路闭区间两两相交（13-13 相交算重叠，
    12/13 相邻不算），与地址差异**分表呈现、互不吞并**；
  - 另列逐项一致清单与整表结论（一致 / 不一致 / 整表拒收）。

  对**重复 ID、坏行（缺列/非整数/多余列）、非法线路（非 1..4）、区间越界（起始越界、
  通道数超 512、闭区间越过 512）**提供两种策略：**整表拒收**（strict，任一异常即不核对，
  HTTP 422 并返回完整异常清单）或**隔离异常行继续核对**（isolate，默认；异常行剔除后
  其余照常比对，但**只要存在异常就绝不报告一致**）。
  灯具后来改名、删除或再次发布，核验仍以**所选版本**的落点为准（名称仅用于展示、不参与
  裁决；旧记录未知的历史名称与保留区也不参与裁决）；方案不存在或未发布时明确拒绝（404）；
  核验全程只读，不修改任何灯具、编排草稿、发布记录与快照。页面提供“下载基准模板 CSV”
  （预填所选方案落点）。

## 快速开始（Docker Compose，推荐）

需要本机已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动后用浏览器访问：

> **http://localhost:8000**

数据保存在宿主机 `./data` 目录（绑定挂载到容器内 `/data/dmx.db`）中，容器重建不丢数据。

编排并发布后，打开 **已发布** 页签即可核对已发布明细：线路占用轨（各线路灯具块）、
迁移清单（逐台落点）与地址表同页展示，并可直接下载与页面同源的 CSV；
旧库缺少快照的发布记录会在黄色横幅与表格内逐项标注字段来源（“当前名称”“未知”等）。

同页的 **现场地址核验** 区域可选择任一已发布方案、上传现场 CSV（
`灯具ID,线路,起始地址,通道数`），按所选版本的发布落点逐项核对缺失/额外/线路·地址·通道
不符/现场区间重叠；可先点“下载基准模板 CSV”获取预填模板。异常行可选“隔离异常行继续
核对”（默认）或“整表拒收”；存在任何异常时结论绝不会是一致。

停止：

```bash
docker compose down          # 保留数据
docker compose down -v       # 同时删除数据卷
```

## 本地直接运行（不使用 Docker）

需要 Python 3.11+。

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

然后访问 http://localhost:8000 。SQLite 数据库默认位于 `./data/dmx.db`，可用环境变量
`DMX_DB_PATH` 修改位置。

## 使用流程

1. 打开 **灯具型录** 页签，点击“载入示例 CSV”再“导入文本内容”（或上传自己的 `.csv`/`.json`）。
2. 打开 **灯具实例**，添加灯具；对已在现场配过地址的灯具填写“既有线路/起始地址”，需要保持不动的勾选“锁定”。
3. 打开 **线路与保留区**，按需停用线路、添加保留通道区。
4. 回到 **编排**，点击“生成预览”：
   - 查看四条线路的占用条与迁移清单；摘要中出现“✅ 已逐级证明最优”才可发布；
   - 若出现黄色“未证最优（不可发布）”面板且下方带候选排布，说明求解器限时内未完成
     某级最优性证明，候选排布仅供参考，请减少灯具数量或稍后重新生成；
   - 若黄色面板提示“暂无可展示排布”（空候选），说明求解器限时内连一个完整候选都没
     取得（UNKNOWN / 候选读取失败 / 诊断超时）——这**不是**已证明无解，不生成草稿、
     不能发布，请减少灯具数量、放宽部分锁定或稍后重试；
   - 若出现红色冲突面板（已证无解），按提示调整约束后重新生成；
   - 预览期间如果改了任何配置，顶部出现黄色横幅且发布按钮禁用，需重新生成预览。
5. 点击“按此预览原子发布”。发布后在 **已发布** 页签核对明细并下载 CSV：
   页面同屏展示**线路占用轨**（各线路灯具块与保留区）、**迁移清单**（逐台原线路/原地址 →
   新线路/新地址）与**地址表**，三者与 CSV 均取自发布时的不可变快照：此后再改名、
   切换锁定或调整保留区，已发布页签与 CSV 仍保持发布时刻的内容；仅旧库缺少快照的
   发布记录按字段来源裁决重建，页面上以黄色横幅提示，且名称列标注“（当前名称）”、
   锁定列显示“未知”（详见下文“无快照旧发布记录的字段含义”）。
6. 发布成功后，方案中的地址自动成为各灯具的“既有地址”，下一轮编排会优先保持它们不动。
7. **现场核验**：在“已发布”页签的“现场地址核验”区域选择基准方案（任一已发布版本均可），
   上传现场 CSV 后查看缺失/额外/线路·地址·通道不符/现场区间重叠的逐项清单与整表结论；
   核验只读取所选版本的发布落点，改名、删除灯具或再次发布都不会改变该版本的基准，
   也不会改动任何编排与发布数据。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/catalog` | 列出/新建型号 |
| POST | `/api/catalog/import` | 上传 CSV/JSON 批量导入型录 |
| DELETE | `/api/catalog/{id}` | 删除型号（仍被引用时拒绝） |
| GET/POST | `/api/fixtures` | 灯具列表/新建 |
| PUT/DELETE | `/api/fixtures/{id}` | 编辑/删除灯具 |
| GET | `/api/lines` / PATCH `/api/lines/{id}` | 线路列表/重命名/启停 |
| GET/POST/DELETE | `/api/reservations[/{id}]` | 保留区管理 |
| GET | `/api/plans/version` | 当前配置版本与最近发布信息 |
| POST | `/api/plans/preview` | 求解并生成预览 |
| GET | `/api/plans/{id}` | 方案详情：草稿按当前配置重建；已发布从快照还原，无快照旧记录按字段来源裁决重建 |
| POST | `/api/plans/{id}/publish` | 按预览原子发布（版本不符返回 409） |
| GET | `/api/plans/published` | 已发布方案列表（供现场核验选择基准版本） |
| GET | `/api/plans/published/latest` | 最近一次发布的完整地址表（取自发布快照） |
| GET | `/api/plans/published/{id}/csv` | 下载已发布地址表 CSV（与已发布查询同源） |
| POST | `/api/plans/{id}/verify` | 现场地址核验：multipart 上传现场 CSV（字段 `file`、`mode=strict|isolate`），按所选发布版本的快照/留存落点只读比对 |

交互式文档：启动后访问 http://localhost:8000/docs 。

### 预览与发布：实际请求/响应示例

**1）生成预览（已证最优，可发布）**

```bash
curl -s -X POST http://localhost:8000/api/plans/preview
```

```json
{
  "feasible": true,
  "optimality_status": "optimal",
  "id": 12,
  "plan_id": 12,
  "config_version": 7,
  "status": "draft",
  "migration_count": 0,
  "used_lines": 1,
  "created_at": "2026-10-02T08:30:00.000000",
  "allocations": [
    {"fixture_id": 1, "name": "Spot1", "line_id": 1, "start": 10, "end": 19,
     "channels": 10, "migrated": false, "locked": false}
  ],
  "migrations": [],
  "occupancy": [
    {"line_id": 1, "name": "线路 1", "is_active": true, "size": 512,
     "used_channels": 10, "free_channels": 502, "fixtures": ["..."], "reservations": []}
  ],
  "conflicts": []
}
```

只有 `optimality_status` 为 `optimal` 的响应才带 `plan_id` 并落库为可发布草稿。

**2）生成预览（未证最优、有候选，不可发布）**

灯具很多、求解器限时内只证明到可行性时，返回 200 但状态为 `unproven`：
响应包含候选排布供参考，但**没有 `plan_id`**，数据库中也不会生成草稿。

```json
{
  "feasible": true,
  "optimality_status": "unproven",
  "unproven_stage": "lines",
  "message": "第二阶段（启用线路数最少）在限定时间内仅找到可行解，未能证明启用线路数最少；未生成可发布草稿，请重试。",
  "config_version": 7,
  "migration_count": 4,
  "used_lines": 3,
  "allocations": ["...候选排布，仅供参考..."],
  "migrations": ["..."],
  "occupancy": ["..."],
  "conflicts": [{"type": "unproven", "message": "第二阶段（启用线路数最少）……"}]
}
```

`unproven_stage` 取值：`migration`（迁移台数未证最优）、`lines`（启用线路数未证最优）、
`lexicographic`（字典序破局未能逐台证明）、`diagnosis`（冲突诊断超时）。这种结果调用
发布接口会得到 404（无草稿可发）；浏览器中发布按钮禁用。请减少灯具数量或稍后重试。

**3）生成预览（未证最优、空候选，暂无可展示排布）**

求解返回 UNKNOWN、候选读取失败或冲突诊断超时时，连一个完整候选排布都没能取得。
此时仍返回 HTTP 200 与 `optimality_status=unproven`（附阶段信息），但 `feasible=false`
且 `allocations` 为空：

```json
{
  "feasible": false,
  "optimality_status": "unproven",
  "unproven_stage": "migration",
  "message": "第一阶段（已配灯具迁移台数最少）在限定时间内未能证明最优，且未取得任何可展示的候选排布；这不代表已证明无解，未生成可发布草稿，请减少灯具数量或稍后重试。",
  "config_version": 7,
  "migration_count": 0,
  "used_lines": 0,
  "allocations": [],
  "migrations": [],
  "occupancy": [],
  "conflicts": [{"type": "unproven", "message": "第一阶段（已配灯具迁移台数最少）……"}]
}
```

注意：`feasible=false` 在这里**不**表示已证明无解——它只表示本次求解未取得可展示的
完整排布。页面据此提示“暂无可展示排布”，不显示冲突面板，也不生成草稿或开放发布。
是否可行的裁决始终以是否取得完整可用排布为准，不会把空候选误报为“候选预览”。

**4）生成预览（真正无解）**

```json
{
  "feasible": false,
  "optimality_status": "infeasible",
  "config_version": 7,
  "conflicts": [
    {"type": "capacity",
     "message": "通道总需求 640 超过启用线路的可用容量 512（1 条 × 512，扣除保留区）。",
     "total_demand": 640, "total_capacity": 512}
  ],
  "occupancy": []
}
```

`infeasible` 表示已证明无解；`unproven` 表示可能有解但没来得及证明最优（含空候选的
“暂无可展示排布”）——三者不会混淆。

**5）发布已证最优的预览**

```bash
curl -s -X POST http://localhost:8000/api/plans/12/publish
```

```json
{"ok": true, "plan_id": 12, "config_version": 8,
 "optimality_status": "optimal", "published_at": "2026-10-02T08:31:05.000000"}
```

发布被拒绝的情况（均为 HTTP 409）：

- 配置版本过期（预览生成后改了灯具/线路/保留区）：
  `配置已变化（预览版本 7，当前版本 9），请基于最新配置重新生成预览后再发布。`
- 未证最优/无证明记录的草稿（含旧版本遗留草稿）：
  `该预览由旧版本生成、没有最优性证明记录，不能发布，请重新生成预览。`
- 重复发布：`该预览已为 published 状态，不能重复发布`。

**6）核对预览的最优性状态**

`GET /api/plans/{plan_id}` 返回体含 `optimality_status`；`GET /api/plans/published/latest`
与发布快照同样带该字段，可在查询与发布两侧核对。

**7）已发布地址表的快照语义**

已发布方案的查询响应中：

- `from_snapshot=true`：地址、名称、锁定、迁移、占用均还原自发布时的不可变快照，
  `status`/`config_version`/`published_at` 以方案记录为准（快照内可能仍是发布前的
  draft 状态，不会直接返回）；
- `from_snapshot=false` 且带 `notice` 与 `field_sources`：旧库缺少快照的发布记录，
  按字段来源逐项裁决重建（详见下文“无快照旧发布记录的字段含义”）——这是显式标注的
  回退，未知字段一律为 `null`，不会把当前值或“否”伪装成发布时事实；
- 草稿（`status=draft`）始终按当前配置实时重建，用于预览路径。

### 无快照旧发布记录的字段含义

旧库中缺少快照的发布记录（`from_snapshot=false`）仍可正常查询与下载 CSV，接口路径与
CSV 列均不变。后端按字段来源逐项裁决，响应中的 `field_sources` 汇总如下：

| 字段 | 来源（`field_sources` 值） | 含义 |
| --- | --- | --- |
| 线路、起始/结束地址、通道数、逐台“是否迁移” | `allocations: publish_record` | 取自留存的方案明细（PlanAllocation），是发布时事实 |
| 迁移台数、启用线路数、配置版本、发布时间 | 方案记录 | 发布时事实 |
| 灯具/线路名称、线路启停 | `names: current` | 取当前值，随改名漂移；JSON 中带 `name_source: "current"`，页面与 CSV 标注“（当前名称）”；灯具已删除时为 `#ID` 并标 `unavailable` |
| 是否锁定 | `locked: unknown` | 历史锁定状态无法还原：JSON 为 `null`，页面与 CSV 显示“未知”，**不会写成“否”** |
| 迁移起点（原线路/原地址） | `migration_origin: unknown` | 无法还原：JSON 为 `null`；迁移清单仅保留“迁移到何处”这一事实 |
| 保留区占用 | `reservations: unknown` | 无法还原：占用中的 `reservations` 为 `null`；含保留区的 `used_channels`/`free_channels` 同为 `null`，另以 `fixtures_used_channels` 给出仅灯具占用的事实部分 |

页面（黄色横幅 + 表格内标注）、JSON（`field_sources` 与各 `*_source` 字段）与 CSV
（“未知”“（当前名称）”标注）三处表达一致。有快照的发布结果不受任何影响。

“已发布”页签对无快照旧记录同样展示全部三个明细区，供逐项核对：

- **迁移清单**：每台迁移的落点（新线路/新地址）是留存事实，照常显示；迁移起点
  （原线路/原地址）无法还原，显示“未知”，不当作无起点；锁定列同为“未知”。
- **线路占用轨**：各线路的发布时灯具块一律画出——即使该线路**后来已停用**（启停为
  当前现状，标注“（当前已停用）/（当前启用）”），也不隐藏历史灯具块；保留区无法还原时
  不画保留块并标注“保留区：未知”，含保留区的已用/空闲数显示“未知”（不当作零），
  另给出仅灯具占用的事实部分；线路名称标注“（当前名称）”。
- **地址表**：名称标注“（当前名称）/（名称不可用）”，锁定列显示“未知”。

前端为此采用**独立渲染**（`renderPublishedTracks` / `renderPublishedMigrations`），
不复用预览的占用组件：预览组件要求 `reservations` 必为数组且停用线路不画块，直接复用
会把旧记录的 `null` 当成“无保留区/零通道”、让现状停用隐藏发布时灯具块，从而改写历史
占用。独立渲染保证旧记录的 `null` 与现状启停只以“未知/当前”标注呈现，预览路径行为不变。

### 现场地址核验：请求/响应示例

**上传现场 CSV（隔离异常行，默认）**

```bash
curl -s -X POST http://localhost:8000/api/plans/12/verify \
  -F "mode=isolate" \
  -F "file=@site.csv;type=text/csv"
```

`site.csv`（UTF-8 含 BOM/无 BOM 或 GBK；表头别名如 `灯具ID,线路,起始地址,通道数`，
也可无表头按列位置给出）：

```csv
灯具ID,线路,起始地址,通道数
1,1,10,10
2,1,101,20
```

响应（HTTP 200）按类别分表，`verdict` 为 `match` / `mismatch`：

```json
{
  "plan_id": 12,
  "verdict": "mismatch",
  "from_snapshot": true,
  "baseline_source": "snapshot",
  "mode": "isolate",
  "baseline_count": 3,
  "site_row_count": 4,
  "accepted_count": 3,
  "isolated_row_count": 1,
  "anomaly_summary": {"bad_row": 1, "duplicate_id": 0, "invalid_line": 0, "out_of_range": 0},
  "anomalies": [
    {"line": 4, "type": "bad_row", "fixture_id": null,
     "message": "坏行：以下字段不是整数：起始地址。",
     "raw": {"fixture_id": "8", "line_id": "1", "start": "abc", "channels": "3"}}
  ],
  "matched_count": 1,
  "missing_count": 1,
  "extra_count": 1,
  "mismatch_count": 0,
  "overlap_count": 0,
  "missing": [{"fixture_id": 3, "name": "Par1", "line_id": 1, "start": 1, "end": 3, "channels": 3}],
  "extra": [{"fixture_id": 99, "name": null, "line_id": 2, "start": 5, "end": 9, "channels": 5, "line_no": 3}],
  "mismatches": [],
  "overlaps": [],
  "matched": [{"fixture_id": 1, "name": "Spot1", "line_id": 1, "start": 10, "end": 19, "channels": 10}],
  "message": "现场与方案 #12 的发布落点不一致：缺失 1、额外 1、落点不符 0、区间重叠 0 对、隔离异常 1 条。"
}
```

- **落点不符**每项带三个独立布尔：`line_mismatch` / `address_mismatch`（起始地址）/
  `channels_mismatch`，并分别提供 `baseline` 与 `site` 的 `line_id/start/end/channels`；
- **现场区间重叠**仅在现场有效行之间、同线路按闭区间求交，输出
  `overlap_start/overlap_end` 与两盏灯的区间、CSV 行号；它与“落点不符”是两张表；
- `mode=strict` 时只要存在异常行即返回 **HTTP 422** 且 `verdict="rejected"`，
  不进行任何比对（响应仍含完整 `anomalies` 列表）；
- 方案不存在或未发布返回 **404**；空文件、无法识别的编码返回 422。

## 技术栈

- 后端：Python 3.11、FastAPI、SQLAlchemy 2.0、SQLite（WAL）、Google OR-Tools CP-SAT
- 前端：原生 HTML/CSS/JavaScript（无构建步骤、无框架依赖）
- 部署：Docker / Docker Compose 单容器，数据卷持久化
