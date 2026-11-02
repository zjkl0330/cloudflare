// 从证据文件生成 docs/endpoint-coverage.md（可反复重跑，保持与实测同步）
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const V = JSON.parse(readFileSync("docs/evidence/api-verification.json", "utf8"));
const rows = Array.isArray(V) ? V : (V.rows || V.results || []);

// 真实 ID 折成占位符：表格更好读，也不会把账号结构写进文档
// 注：证据文件发布前被 tools/sanitize-for-publish.mjs 把真实账号 id 换成了「«ACCOUNT_ID»」，
// 这里必须把它也折回 {a} —— 否则一重跑生成器，40 行路径全变成「/accounts/«ACCOUNT_ID»/…」。
function norm(p) {
  return String(p || "")
    .replace(/«ACCOUNT_ID»/g, "{a}")
    .replace(/\/accounts\/[0-9a-f]{32}/g, "/accounts/{a}")
    .replace(/\/zones\/[0-9a-f]{32}/g, "/zones/{z}")
    .replace(/\/database\/[0-9a-f-]{36}/g, "/database/{uuid}")
    .replace(/\/namespaces\/[0-9a-f]{32}/g, "/namespaces/{ns}")
    .replace(/\/workers\/domains\/[0-9a-f]{40}/g, "/workers/domains/{d}")
    .replace(/\/workers\/domains\/[0-9a-f-]{36}/g, "/workers/domains/{d}")
    .replace(/\/deployments\/[0-9a-f-]{36}/g, "/deployments/{deployment_id}")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{version_id}")
    .replace(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g, "{a}")
    .replace(/rin-server/g, "{s}")
    .replace(/\|/g, "\\|");
}

const GN = { A: "账号与资源发现", B: "流量分析", C: "Workers 版本与部署", D: "域名 / Zone / DNS", E: "端点存在性探测", F: "写权限语义探测（非法 payload）" };

function verdict(r) {
  const c = String(r.errCode ?? "");
  if (r.ok && r.http === 200) return "✅ 实测 200，已拿到真实数据";
  if (r.ok) return "✅ 实测 " + r.http + "，响应可用";
  if (c === "10000" || c === "1000") return "⛔ 令牌缺该权限（补齐清单见 05 §3）";
  if (c === "10042") return "🚫 服务未在后台启用（R2）";
  if (c === "1404") return "🚫 套餐无配额（SSL for SaaS）";
  if (c === "7003" || c === "7000") return "🚫 路由不存在 / 服务未开通";
  if (c === "9109") return "ℹ️ account-scoped 令牌无用户级认证主体（正常现象）";
  if (c === "10007") return "❌ 脚本名要从 id 取，不是 name";
  if (c === "100146") return "❌ 版本 ID 不存在";
  if (c === "10025") return "❌ 路径写错：写值要用 `/values/{key}`（错误信息直接给了正确路径）";
  if (c === "8000007") return "🟡 路由+鉴权可达，但账号里没有 Pages 项目可验";
  if (c === "10210" || c === "10082" || c === "10026" || r.http === 415) return "🟢 路由+鉴权可达，已到业务校验层（写权限具备）";
  if (c === "10405" || (c === "1001" && r.http === 405)) return "❌ 该动词不支持（不是权限问题）";
  if (c === "1001") return "❌ 这条路径不是代码下载端点";
  if (r.http === 500) return "🔥 接口自身不工作（500 空响应，多形状已复现）";
  if (r.http === 410) return "🚫 已废弃";
  if (r.http === 422) return "🟠 SQL 语法/字段错误（正确写法见 01）";
  return "🟠 " + String(r.brief || "").slice(0, 60);
}

let md = "# 端点覆盖清单（实测状态）\n\n"
  + "> 由 `node tools/gen-coverage.mjs` 从 `docs/evidence/api-verification.json` 生成；`{a}` `{z}` `{s}` `{version_id}` `{ns}` `{d}` 都是占位符，真实 ID 见证据文件。\n"
  + "> 图例：✅ 实测 200 ｜ 🟢 用非法 payload 证明路由与鉴权可达（写操作本阶段没真发）｜ 🟡 可达但缺真实资源 ｜ ⛔ 令牌缺权限 ｜ 🚫 服务/套餐限制 ｜ 🔥 接口不工作 ｜ ❌ 该写法不成立 ｜ 🟠 用法需修正\n\n"
  + "| 功能块 | 测的是什么 | 请求 | HTTP | 状态与结论 |\n|---|---|---|---|---|\n";

for (const r of rows) {
  if (r.group === "G") continue;
  md += "| " + (GN[r.group] || r.group) + " | " + (r.label || "") + " | `" + r.method + " " + norm(r.path) + "` | "
    + r.http + " | " + norm(verdict(r)) + " |\n";
}

md += "\n## 只在定向探测里出现过的形状（不在上面这批请求中）\n\n"
  + "| 探测 | 结果 | 结论 |\n|---|---|---|\n"
  + "| `GET …/workers/scripts/{s}/versions/{version_id}` | 200 | 版本详情可用，`resources.bindings` 含全部绑定 |\n"
  + "| `GET …/versions/{version_id}/content` | 200 但返回**版本 JSON** | ⚠️ 后缀被忽略，**没有「下载指定版本源码」的接口** |\n"
  + "| `GET …/versions/{version_id}/totallybogus` | 200 版本 JSON | 同上，回落证据 |\n"
  + "| `GET …/workers/scripts/{s}/analytics` | 200 **multipart 整包代码** | 该端点不存在，回落证据 |\n"
  + "| `GET …/workers/scripts/{s}/tail-sessions` | 200 multipart 整包 | 同上 |\n"
  + "| `GET …/versions/{bogus}/content` | 404 `100146` | 版本 ID 确实被解析，只是尾巴被丢 |\n"
  + "| `GET /accounts/{a}/analytics/workers_usage/sum` | 500 | Workers 用量拿不到 |\n"
  + "| `analytics_engine/datasets` 的 `v2` / `?dataplane` / `column/definitions` | 500 ×3 | AE 数据集列表拿不到，改用 SQL 直查 |\n"
  + "| `POST /analytics/sql`（`events.analyticsEngine.default` + `time_range` + `scope.accountTag`） | 200 `n=0` | AE 查询语法确认，只是没有数据集 |\n"
  + "| `POST /analytics/sql`（AE 不带 `time_range`） | 422 `query must include a time range` | 参数口径确认 |\n"
  + "| `GET /accounts/{a}/workers/routes` | 400 `7003` | 路由是 zone 作用域，account 级没有这个集合 |\n"
  + "| `GET /accounts/{a}/workers/tails`、`/tails/any` | 405 `10405` | 只能 POST 创建，无列表；**且该路径已从官方规格移除** |\n"
  + "| `POST /accounts/{a}/workers/scripts/__nope__/tails`（空 body） | 404 `10007` This Worker does not exist | **证明现令牌已具备建 Tail 的权限**：权限检查在资源查找之前，报的是「Worker 不存在」而不是 `10000`。规格里该端点接受 `Workers Tail Read` 或 `Workers Scripts Write` 任一 |\n"
  + "| `GET /accounts/{a}/d1/database/{uuid}/time_travel[/info]` | 404 | 未启用 |\n"
  + "| `GET /accounts/{a}/tokens` | 200 | 能看到令牌名/状态，看不到权限明细 |\n"
  + "| GraphQL `workersAnalyticsAdaptiveGroups` 等 6 个候选数据集名 | `unknown field` | Workers 分析在 GraphQL 里没有对应数据集 |\n"
  + "| GraphQL `httpRequests1mGroups` / `firewallEventsAdaptiveGroups` | `does not have access to the path` | 套餐门控 |\n"
  + "| GraphQL `orderBy:[\"count_DESC\"]` | 200 真实数据 | 排序枚举 = 字段名 + `_ASC`/`_DESC`，且必须是字符串数组 |\n\n";

// 数据面补测表：直接来自 probe-sql-surfaces.mjs 的证据文件，保持与实测同步
if (existsSync("docs/evidence/sql-surfaces.json")) {
  const SS = JSON.parse(readFileSync("docs/evidence/sql-surfaces.json", "utf8"));
  md += "## 数据面补测（Analytics SQL / Analytics Engine / Workers Observability）\n\n"
    + "| 请求 | HTTP | 结论 |\n|---|---|---|\n";
  for (const r of SS) md += "| `" + r.method + " " + norm(String(r.path)) + "` | " + r.http + " | " + norm(r.ok ? "✅ " + (r.note || "可用") : "🟠 " + (r.note || String(r.brief).slice(0, 70))) + " |\n";
  md += "\n";
} else {
  md += "（缺 `docs/evidence/sql-surfaces.json`，跑一次 `node tools/probe-sql-surfaces.mjs` 再重新生成本文件）\n\n";
}

// 交叉核对补测（probe-shapes6）+ Rulesets 阶段入口（probe-rulesets-phases）：
// 这两批是"同类 App 调过、我们原来没测"的端点，以及 cf-mobile 那条 404=空态经验的复现，
// 自动从证据文件生成，别手抄 —— 手抄过一次就出现了 `09` E12 那种写反的情况。
function probeTable(file, title, note) {
  if (!existsSync(file)) return "（缺 `" + file.replace(/^docs\/evidence\//, "") + "`，跑对应 probe 再重新生成本文件）\n\n";
  const J = JSON.parse(readFileSync(file, "utf8"));
  let t = "## " + title + "\n\n" + (note || "") + "\n\n| 测的是什么 | 请求 | HTTP | 结论 |\n|---|---|---|---|\n";
  for (const [k, v] of Object.entries(J)) {
    if (!v || typeof v.status !== "number") continue; // 跳过 __summary 之类
    const body = String(v.body || "");
    const code = /"code":\s*(\d+)/.exec(body)?.[1] || (/method_not_allowed/.test(body) ? "1001" : "");
    const msg = /"message":\s*"((?:\\.|[^"\\])*)"/.exec(body)?.[1]?.replace(/\\"/g, '"') || /error":\s*"([^"]+)/.exec(body)?.[1] || "";
    const verdict = v.status === 200 ? "✅ 实测 200" : v.status === 0 ? "🔥 网络失败" : "🟠 " + (code ? "code " + code + " " : "") + msg.slice(0, 60);
    t += "| " + norm(k) + " | `" + (v.method || "GET") + " " + norm(String(v.path || "").replace(/https:\/\/api\.cloudflare\.com\/client\/v4/, "")) + "` | " + v.status + " | " + norm(verdict) + " |\n";
  }
  return t + "\n";
}
md += probeTable("docs/evidence/probe6.json",
  "同类 App 交叉核对补测（`tools/probe-shapes6.mjs`）",
  "写动词一律打不存在的 worker/id，只判断路由与动词可达，不产生变更（口径见 `09` §F）。`deploy` / `PATCH domains` 的 405 结论见 `08` §6.2。");
md += probeTable("docs/evidence/rulesets-phases.json",
  "Rulesets 阶段入口（`tools/probe-rulesets-phases.mjs`）",
  "`404 code 10003` = 该阶段没配过规则（**正常空态**）；`400 unknown phase` = 阶段名对本套餐不成立（该错误对象没有 code）。结论与用法见 `04` §8。");

// Git 仓库连接（2026-11-02）：这一批**没有实测证据**，所以不混进上面的实测表，
// 单独成节并逐条写明依据 —— 免得有人把「按官方规格拼的请求」当成「已经验过」。
md += "## Git 仓库连接（2026-11-02 新增，未实测）\n\n"
  + "> 这一节不是证据文件生成的：我们**没有**可用的 GitHub/GitLab 凭据，也没在真账号上装过 CF 的 Git App，\n"
  + "> 所以只锁「发出去的请求形状」，真实写操作留给用户真机验收。写侧仍走本机写开关 + 预览确认两道闸门。\n\n"
  + "| 动作 | 请求 | 状态 | 结论与边界 |\n|---|---|---|---|\n"
  + "| Pages 连接已有仓库 | `PATCH /accounts/{a}/pages/projects/{p}`（body: `source` / `build_config` / `production_branch`） | 🟡 形状来自官方规格 | 只能连**已有**项目到**已有**仓库；账号必须先在 dashboard 装过 GitHub/GitLab 集成，OAuth 授权无法用 API 完成；仅 APK 直连可发（网页模式整表单灰掉） |\n"
  + "| 列我的仓库 · GitHub | `GET https://api.github.com/user/repos` | 🟡 仅 APK | 用用户自备 PAT（classic `repo` 或细粒度 Metadata/Contents 读）；浏览器无 CORS，网页模式不提供 |\n"
  + "| 列我的仓库 · GitLab | `GET https://gitlab.com/api/v4/projects?membership=true` | 🟡 仅 APK | 用 `read_api` 范围的 PAT；同样无 CORS |\n"
  + "| Workers 读触发器 | `GET /accounts/{a}/builds/workers/{tag}/triggers` | 🟡 按官方规格拼、未实测 | `tag` 先由 `GET /accounts/{a}/workers/scripts/{s}` 取（不是脚本名）；缺 tag 直接报错，不硬拼 |\n"
  + "| Workers 列 build token | `GET /accounts/{a}/builds/tokens` | 🟡 按官方规格拼、未实测 | 选已有 token 的 uuid 填进 trigger；没有 token 需先在 dashboard 建 |\n"
  + "| Workers 建仓库连接 | `PUT /accounts/{a}/builds/repos/connections`（body: `provider_type` / `provider_account_id` / `provider_account_name` / `repo_id` / `repo_name`） | 🟡 按官方规格拼、未实测 | 返回 `repo_connection_uuid`；仓库的 owner/repo 数字 id 由 `GET /user/repos`（GitHub）或 `/projects`（GitLab）解析后转 Number |\n"
  + "| Workers 建构建触发器 | `POST /accounts/{a}/builds/triggers`（body 含 `external_script_id` / `repo_connection_uuid` / `trigger_name` / `build_command` / `deploy_command` / `build_token_uuid` / 分支路径过滤 / `root_directory` / `build_caching_enabled`） | 🟡 按官方规格拼、未实测 | 客户端只发一条 POST，直连层/网关拆成「connection → trigger」两次上游调用；trigger 失败时错误里带回 connection uuid，便于 dashboard 清理 |\n"
  + "| Workers 断开构建 | `DELETE /accounts/{a}/builds/triggers/{uuid}` | 🟡 按官方规格拼、未实测 | 只删触发器，不动仓库连接与已部署版本 |\n\n"
  + "> Workers Builds 的硬前提：令牌必须是 user-scoped、带 `Workers Builds Configuration: Edit`；\n"
  + "> 账号须已在 dashboard 装过 Cloudflare GitHub/GitLab App（OAuth 装 App 无法用 API 完成）。\n"
  + "> 网页模式只能新建 GitHub 连接（GitHub REST 有 CORS，GitLab API 没有）；已有触发器的读取/断开两种模式都可用。\n\n";

md += "## 本阶段刻意没发请求的写操作（需授权后逐项补测）\n\n"
  + "| 动作 | 请求 | 前置条件 |\n|---|---|---|\n"
  + "| 上传新 Worker 版本 | `POST /accounts/{a}/workers/scripts/{s}/versions`（multipart） | 拿测试 Worker，不要用生产那个 |\n"
  + "| 版本切换 / 灰度 | `POST /accounts/{a}/workers/scripts/{s}/deployments` | 可先原样重部署当前 148 版 |\n"
  + "| 绑定自定义域名 | `PUT /accounts/{a}/workers/domains` | 会建 DNS + 签 Advanced Certificate，建议用一次性子域 |\n"
  + "| 解绑自定义域名 | `DELETE /accounts/{a}/workers/domains/{id}` | 同上，注意 CA 速率限制 |\n"
  + "| DNS 记录增删改 | `POST/PATCH/DELETE /zones/{z}/dns_records[/{id}]` | **先补 `Zone:DNS:Edit`** |\n"
  + "| 清缓存 | `POST /zones/{z}/purge_cache` | **先补 `Zone:Cache Purge:Purge`** |\n"
  + "| 站点设置改动 | `PATCH /zones/{z}/settings/{id}` | 权限未测；56 项中 44 项 `editable:true` |\n"
  + "| 写 secret | `PUT /accounts/{a}/workers/scripts/{s}/secrets/{name}` | 值从仓库外文件读，不进日志 |\n"
  + "| 改 cron | `PUT /accounts/{a}/workers/scripts/{s}/schedules` | 整体替换语义，先读后写 |\n"
  + "| 创建 Tail + 连 wss | `POST /accounts/{a}/workers/scripts/{s}/tails`（规格里另有 `/workers/observability/telemetry/live-tail`） | 真机验证 wss 可达性（风险 C3）；老的 `/accounts/{a}/workers/tails` 已从规格移除 |\n"
  + "| Pages 建项目 / 回滚 | `POST /accounts/{a}/pages/projects`、`POST …/deployments/{id}/rollback` | 先要有项目（风险 A1） |\n"
  + "| D1 写 SQL / KV 写 | `POST …/d1/database/{uuid}/execute`、`PUT /storage/kv/namespaces/{id}/values/{key}` | 只在测试库/测试 namespace 上验 |\n";

writeFileSync("docs/endpoint-coverage.md", md);
console.log("生成 docs/endpoint-coverage.md，主表行数：", rows.filter((r) => r.group !== "G").length);
