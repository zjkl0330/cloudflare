// tools/check-direct-parity.mjs
//
// 直连层（src/lib/direct.ts）的**自动化**对齐检查 —— 之所以要有这个文件：
// routeREST 的段位错位（s[2] 当脚本名）在直连模式下连续存在了好几个版本都没被发现，
// 因为没有测试、全靠肉眼。这个脚本用 mock fetch 跑 gwDirect / writeDirect 的真实代码，
// 逐条断言「前端调用 → 生成的上游 CF URL + 方法 + 请求体」，改坏任何一条都会在这里红。
//
// 跑法（需要 esbuild 先把 TS 编成 JS）：
//   cd app/console
//   npx esbuild src/lib/direct.ts --format=esm --outfile=/tmp/direct.mjs
//   node ../../tools/check-direct-parity.mjs /tmp/direct.mjs
// 退出码 0 = 全对；非 0 = 有路由映射坏了。
import fs from "node:fs";

const modPath = process.argv[2] || "/tmp/direct.mjs";
if (!fs.existsSync(modPath)) {
  console.error(`找不到编译产物 ${modPath}，先跑：npx esbuild src/lib/direct.ts --format=esm --outfile=${modPath}`);
  process.exit(2);
}
const { gwDirect, writeDirect, dropDirect } = await import(modPath);

const DIRECT_BASE = "https://api.cloudflare.com/client/v4";
const ACC = "c".repeat(32); // 必须是真形状的 32 位 hex：直连层会 encodeURIComponent(account)，
// 之前这里写成「«ACCOUNT_ID»」这种占位符，编码后变成 %C2%AB…%C2%BB，46 条断言全线误报。
const ZONE = "b".repeat(32);
const DEP = "5e310b27-4a39-4324-8f49-681f36184a30"; // Pages / Workers 部署 id 的 UUID 形状
const CTX = { token: "test-token", account: ACC, fresh: false };

let captured = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  captured.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
  // 按路径形状回最小可用的 CF 信封
  if (u.endsWith("/graphql")) {
    return mkJson(200, { data: { viewer: { accounts: [{ g: [{ dimensions: { date: "2026-01-01" }, sum: { requests: 1, bytes: 1, encryptedRequests: 0, threats: 0 } }], v: [{ sum: { visits: 1, edgeResponseBytes: 1 } }], a: [] }] } } });
  }
  if (u.includes("/analytics/sql") || u.includes("/analytics_engine/sql")) {
    return mkJson(200, { data: [], statistics: {}, rows: 0 });
  }
  if (u.includes("/keys?")) {
    return mkJson(200, { success: true, result: [{ name: "k1" }], result_info: { cursor: "CUR2" } });
  }
  if (u.includes("/observability/usage")) {
    return mkJson(200, { success: true, result: { events: 1, breakdown: [] } });
  }
  // Workers Builds：脚本本体要回 tag（external_script_id 用它，不是脚本名）
  if (u.endsWith("/workers/scripts/hello")) {
    return mkJson(200, { success: true, result: { tag: "TAG-1" } });
  }
  if (u.includes("/builds/repos/connections") && init.method === "PUT") {
    return mkJson(200, { success: true, result: { repo_connection_uuid: "C".repeat(32) } });
  }
  if (u.includes("/builds/triggers") && init.method === "POST") {
    return mkJson(200, { success: true, result: { trigger_uuid: "T".repeat(32), trigger_name: "t" } });
  }
  if (init.method === "POST") {
    return mkJson(200, { success: true, result: { id: "deploy-1" } });
  }
  return mkJson(200, { success: true, result: [{ id: "item-1" }], result_info: { total_count: 1 } });
};
function mkJson(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// 断言：calls 里存在至少一条 (method, url 含 expected) —— expected 是完整上游 URL
function expectOne(label, expected, { method = "GET", bodyIncludes = null, exclude = false } = {}) {
  const hits = captured.filter(
    (c) => c.url === (expected.startsWith("http") ? expected : DIRECT_BASE + expected) && c.method === method,
  );
  let ok = exclude ? hits.length === 0 : hits.length > 0;
  if (ok && bodyIncludes) ok = hits.some((h) => String(h.body || "").includes(bodyIncludes));
  if (!ok) {
    console.error(`❌ ${label}\n   期望 ${method} ${expected}${bodyIncludes ? `（body 含 ${bodyIncludes}）` : ""}`);
    for (const c of captured) console.error(`   实际 ${c.method} ${c.url}`);
    fail = true;
  } else {
    pass++;
    console.log(`✅ ${label}`);
  }
}

let pass = 0;
let fail = false;
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("&");

async function call(path, query) {
  captured = [];
  dropDirect("/"); // 清模块级缓存：相邻用例同上游路径时会命中缓存、不发 fetch，断言就抓不到 URL
  await gwDirect(path, query || {}, CTX);
}

async function runWrite(method, path, body) {
  captured = [];
  dropDirect("/");
  await writeDirect(CTX, method, path, body);
}

/** 负例：必须被客户端校验拦下，且**一次上游都不打**（校验排在出网之前） */
async function expectReject(label, fn) {
  captured = [];
  dropDirect("/");
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  if (!rejected) {
    console.error(`❌ ${label} —— 应被拒绝但没有`);
    fail = true;
  } else if (captured.length) {
    console.error(`❌ ${label} —— 校验失败却仍出网 ${captured.length} 次`);
    fail = true;
  } else {
    pass++;
    console.log(`✅ ${label}（零出网）`);
  }
}

// ---- 只读：逐条 ----
await call("/v1/accounts");
expectOne("GET /v1/accounts", `/accounts?per_page=50&page=1`);

await call("/v1/account");
expectOne("GET /v1/account", `/accounts?per_page=50&page=1`);

await call("/v1/zones");
expectOne("GET /v1/zones", `/zones?per_page=50&page=1`);

await call("/v1/subscriptions");
expectOne("GET /v1/subscriptions", `/accounts/${ACC}/subscriptions`);

await call("/v1/workers");
expectOne("GET /v1/workers", `/accounts/${ACC}/workers/scripts?per_page=100&page=1`);

await call("/v1/workers/subdomain");
expectOne("GET /v1/workers/subdomain", `/accounts/${ACC}/workers/subdomain`);

const U_FROM = Date.now() - 3600_000, U_TO = U_FROM + 3600_000;
await call("/v1/workers/usage", { from: U_FROM, to: U_TO });
expectOne("GET /v1/workers/usage", `/accounts/${ACC}/workers/observability/usage?` + q({ from: U_FROM, to: U_TO }));

await call("/v1/workers/hello/versions", { page: 2, per_page: 50 });
expectOne("GET /v1/workers/hello/versions", `/accounts/${ACC}/workers/scripts/hello/versions?per_page=50&page=2`);

await call("/v1/workers/hello/versions/v123");
expectOne("GET /v1/workers/hello/versions/v123", `/accounts/${ACC}/workers/scripts/hello/versions/v123`);

await call("/v1/workers/hello/deployments");
expectOne("GET /v1/workers/hello/deployments", `/accounts/${ACC}/workers/scripts/hello/deployments?environment=production&per_page=50`);

await call("/v1/workers/hello/settings");
expectOne("GET /v1/workers/hello/settings", `/accounts/${ACC}/workers/scripts/hello/settings`);

await call("/v1/workers/hello/script-settings");
expectOne("GET /v1/workers/hello/script-settings", `/accounts/${ACC}/workers/scripts/hello/script-settings`);

await call("/v1/workers/hello/subdomain");
expectOne("GET /v1/workers/hello/subdomain", `/accounts/${ACC}/workers/scripts/hello/subdomain`);

await call("/v1/workers/hello/secrets");
expectOne("GET /v1/workers/hello/secrets", `/accounts/${ACC}/workers/scripts/hello/secrets`);

await call("/v1/workers/hello/crons");
expectOne("GET /v1/workers/hello/crons（用户实测撞过的那条）", `/accounts/${ACC}/workers/scripts/hello/schedules`);

// Workers Builds 读侧（2026-11-02，按官方规格拼，未实测）：先读脚本取 tag，再列触发器
await call("/v1/workers/hello/builds");
expectOne("GET workers/:s/builds（先取脚本 tag）", `/accounts/${ACC}/workers/scripts/hello`);
expectOne("GET workers/:s/builds（再列 triggers）", `/accounts/${ACC}/builds/workers/TAG-1/triggers`);
await call("/v1/builds/tokens");
expectOne("GET builds/tokens", `/accounts/${ACC}/builds/tokens`);

await call("/v1/domains");
expectOne("GET /v1/domains", `/accounts/${ACC}/workers/domains?per_page=100&page=1`);

await call("/v1/pages");
expectOne("GET /v1/pages", `/accounts/${ACC}/pages/projects?page=1&per_page=10`);

await call("/v1/pages/proj/deployments");
expectOne("GET /v1/pages/proj/deployments", `/accounts/${ACC}/pages/projects/proj/deployments?page=1&per_page=10`);

await call("/v1/pages/proj");
expectOne("GET Pages 项目详情", `/accounts/${ACC}/pages/projects/proj`);

await call("/v1/pages/proj/domains");
expectOne("GET Pages 自定义域名（不带 per_page：实测 100 回 400 8000024）", `/accounts/${ACC}/pages/projects/proj/domains`);

await call("/v1/pages/proj/deployments/" + DEP + "/logs");
expectOne("GET Pages 构建日志（上游尾巴 /history/logs）", `/accounts/${ACC}/pages/projects/proj/deployments/${DEP}/history/logs`);

await call("/v1/d1");
expectOne("GET /v1/d1", `/accounts/${ACC}/d1/database?per_page=100&page=1`);

await call("/v1/d1/dbid");
expectOne("GET /v1/d1/dbid", `/accounts/${ACC}/d1/database/dbid`);

await call("/v1/d1/dbid/query?sql=" + encodeURIComponent("SELECT 1"));
expectOne("GET /v1/d1/dbid/query（GET 进 POST 出）", `/accounts/${ACC}/d1/database/dbid/query`, { method: "POST" });

await call("/v1/kv");
expectOne("GET /v1/kv", `/accounts/${ACC}/storage/kv/namespaces?per_page=100&page=1`);

await call("/v1/kv/nsid/keys", { limit: 100, cursor: "CUR1" });
expectOne("GET /v1/kv/nsid/keys（cursor 透传）", `/accounts/${ACC}/storage/kv/namespaces/nsid/keys?limit=100&cursor=CUR1`);

await call("/v1/r2");
expectOne("GET /v1/r2", `/accounts/${ACC}/r2/bucket?per_page=100&page=1`);

await call("/v1/zt/organization");
expectOne("GET /v1/zt/organization", `/accounts/${ACC}/access/organizations`);

await call("/v1/zt/apps");
expectOne("GET /v1/zt/apps", `/accounts/${ACC}/access/apps?per_page=100&page=1`);

await call("/v1/zt/groups");
expectOne("GET /v1/zt/groups", `/accounts/${ACC}/access/groups?per_page=100&page=1`);

await call("/v1/zt/policies");
expectOne("GET /v1/zt/policies", `/accounts/${ACC}/access/policies?per_page=100&page=1`);

await call("/v1/zones/" + ZONE + "/dns_records");
expectOne("GET dns_records", `/zones/${ZONE}/dns_records?per_page=100&page=1`);

await call("/v1/zones/" + ZONE + "/routes");
expectOne("GET zone routes", `/zones/${ZONE}/workers/routes?per_page=100`);

await call("/v1/zones/" + ZONE + "/waf");
expectOne("GET waf（三 phase）", `/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`);
expectOne("GET waf（三 phase）", `/zones/${ZONE}/rulesets/phases/http_request_firewall_managed/entrypoint`);
expectOne("GET waf（三 phase）", `/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`);

await call("/v1/traffic/series", { range: "7d" });
expectOne("GET traffic/series", `/analytics/sql`, { method: "POST" });

await call("/v1/traffic/adaptive", { range: "7d", dim: "cache" });
expectOne("GET traffic/adaptive", `/graphql`, { method: "POST" });

await call("/v1/overview", { range: "7d" });
expectOne("GET overview（GraphQL + SQL 合成）", `/graphql`, { method: "POST" });
expectOne("GET overview（GraphQL + SQL 合成）", `/analytics/sql`, { method: "POST" });

// ---- 写侧 ----
await runWrite("POST", "/v1/workers/hello/deployments", { version_id: "a531f564-3080-4c07-84a2-98cb7b9ea0e5", percentage: 100 });
expectOne("POST 版本切换·单版本形状（回滚/全量）", `/accounts/${ACC}/workers/scripts/hello/deployments`, {
  method: "POST",
  bodyIncludes: `"strategy":"percentage"`,
});

// 灰度形状：UI 滑杆 <100 时发双版本数组（50/50 已实测），客户端不传 strategy
await runWrite("POST", "/v1/workers/hello/deployments", {
  versions: [
    { version_id: "a531f564-3080-4c07-84a2-98cb7b9ea0e5", percentage: 30 },
    { version_id: "5e310b27-4a39-4324-8f49-681f36184a30", percentage: 70 },
  ],
  annotations: { "workers/message": "从手机发起" },
});
expectOne("POST 版本切换·灰度形状（双版本合计 100）", `/accounts/${ACC}/workers/scripts/hello/deployments`, {
  method: "POST",
  bodyIncludes: `"percentage":30`,
});

// 旧 UI 预览形状（versions+strategy 混传）必须被拒 —— 0.2.0 的回滚失败就是它
let rejected = false;
try {
  await runWrite("POST", "/v1/workers/hello/deployments", { versions: [{ version_id: "a531f564-3080-4c07-84a2-98cb7b9ea0e5", percentage: 100 }], strategy: "percentage" });
} catch { rejected = true; }
if (!rejected) { console.error("❌ 旧形状 {versions,strategy} 应被拒绝（单版本数组+strategy 属于未实测形状）"); fail = true; } else { pass++; console.log("✅ 旧形状 {versions,strategy} 被拒绝"); }

// cron 保存：客户端 {schedules:[{cron}]} → 上游 PUT schedules **裸数组**（实测：包信封 400）
await runWrite("PUT", "/v1/workers/hello/crons", { schedules: [{ cron: "0 1 * * *" }] });
expectOne("PUT crons（拆成上游裸数组）", `/accounts/${ACC}/workers/scripts/hello/schedules`, {
  method: "PUT",
  bodyIncludes: `"cron":"0 1 * * *"`,
});
{
  const hit = captured.find((c) => c.url.endsWith("/schedules") && c.method === "PUT");
  if (hit && String(hit.body).includes("schedules")) { console.error("❌ cron 上游体不该带 {schedules:…} 信封"); fail = true; }
}

// Secret 增删：客户端 POST → 上游 PUT（201 实测）；DELETE 原样
await runWrite("POST", "/v1/workers/hello/secrets", { name: "FOO", text: "bar", type: "secret_text" });
expectOne("POST secrets（上游 PUT 动词）", `/accounts/${ACC}/workers/scripts/hello/secrets`, {
  method: "PUT",
  bodyIncludes: `"type":"secret_text"`,
});
await runWrite("DELETE", "/v1/workers/hello/secrets/FOO");
expectOne("DELETE secrets/FOO", `/accounts/${ACC}/workers/scripts/hello/secrets/FOO`, { method: "DELETE" });

// 绑定保存：客户端 PUT {bindings} → 上游 PATCH settings + multipart part=settings（JSON 415 实测）
await runWrite("PUT", "/v1/workers/hello/settings", { bindings: [{ type: "plain_text", name: "A", text: "b" }] });
{
  const hit = captured.find((c) => c.url.endsWith("/settings") && c.method === "PATCH");
  const fd = hit?.body;
  const part = fd instanceof FormData ? fd.get("settings") : null;
  if (!(typeof part === "string" && part.includes('"bindings"') && part.includes("plain_text"))) {
    console.error("❌ settings 上游必须是 PATCH + FormData 且 part 名 settings（实测 JSON 415）"); fail = true;
  } else { pass++; console.log("✅ PUT settings（上游 PATCH + multipart part=settings）"); }
}

// 删版本 / 删部署记录（后者 API Token 可用实测 200；前者 Token 405 但照实透传）
await runWrite("DELETE", "/v1/workers/hello/versions/" + "d".repeat(32));
expectOne("DELETE versions/vid", `/accounts/${ACC}/workers/scripts/hello/versions/${"d".repeat(32)}`, { method: "DELETE" });
await runWrite("DELETE", "/v1/workers/hello/deployments/5e310b27-4a39-4324-8f49-681f36184a30");
expectOne("DELETE deployments/depId", `/accounts/${ACC}/workers/scripts/hello/deployments/5e310b27-4a39-4324-8f49-681f36184a30`, { method: "DELETE" });

// Pages 回滚 / 重试：上游都是 POST + 空 body（2026-10-21 临时项目 cfconsole-tmp-1021 实测）
await runWrite("POST", "/v1/pages/proj/deployments/" + DEP + "/rollback", undefined);
expectOne("POST Pages rollback（空 body）", `/accounts/${ACC}/pages/projects/proj/deployments/${DEP}/rollback`, { method: "POST" });
await runWrite("POST", "/v1/pages/proj/deployments/" + DEP + "/retry", undefined);
expectOne("POST Pages retry（空 body）", `/accounts/${ACC}/pages/projects/proj/deployments/${DEP}/retry`, { method: "POST" });

// D1 写通道：POST {sql}（写闸门管；GET 只读通道不在此测）
await runWrite("POST", "/v1/d1/dbid/query", { sql: "INSERT INTO t VALUES (1)" });
expectOne("POST d1 query（写通道）", `/accounts/${ACC}/d1/database/dbid/query`, {
  method: "POST",
  bodyIncludes: `"sql":"INSERT`,
});

// KV 键值写：客户端 {value} → 上游**裸文本** body（JSON 会把引号存进去，实测过）
await runWrite("PUT", "/v1/kv/nsid/values/e2e-key", { value: "hello" });
expectOne("PUT kv values（裸文本 body）", `/accounts/${ACC}/storage/kv/namespaces/nsid/values/e2e-key`, {
  method: "PUT",
  bodyIncludes: "hello",
});
{
  const hit = captured.find((c) => c.url.endsWith("/values/e2e-key") && c.method === "PUT");
  if (hit && /^"/.test(String(hit.body))) { console.error("❌ kv 上游 body 不该是 JSON 字符串"); fail = true; }
}
await runWrite("DELETE", "/v1/kv/nsid/values/e2e-key");
expectOne("DELETE kv values/key", `/accounts/${ACC}/storage/kv/namespaces/nsid/values/e2e-key`, { method: "DELETE" });

await runWrite("POST", "/v1/zones/" + ZONE + "/dns_records", { name: "x", type: "A", content: "1.2.3.4", ttl: 1, proxied: false });
expectOne("POST dns_records", `/zones/${ZONE}/dns_records`, { method: "POST" });

await runWrite("DELETE", "/v1/zones/" + ZONE + "/dns_records/" + "c".repeat(32), undefined);
expectOne("DELETE dns_records/rid", `/zones/${ZONE}/dns_records/${"c".repeat(32)}`, { method: "DELETE" });

await runWrite("POST", "/v1/zones/" + ZONE + "/purge_cache", { files: ["https://x.example.com/a"] });
expectOne("POST purge_cache", `/zones/${ZONE}/purge_cache`, { method: "POST" });

// ---- 自定义域名 / 站点路由 / Pages 环境变量 / workers.dev 开关（2026-10-22 临时资源自清理实测）----
// Workers 自定义域名：客户端 POST → 上游 **PUT**（POST 实测 405）
await runWrite("POST", "/v1/domains", { hostname: "api.example.com", zone_id: ZONE, service: "hello", environment: "production" });
expectOne("POST /v1/domains（上游 PUT 动词）", `/accounts/${ACC}/workers/domains`, {
  method: "PUT",
  bodyIncludes: `"hostname":"api.example.com"`,
});
await runWrite("DELETE", "/v1/domains/" + "a".repeat(32));
expectOne("DELETE /v1/domains/:id", `/accounts/${ACC}/workers/domains/${"a".repeat(32)}`, { method: "DELETE" });

// Pages 自定义域名：POST {name} / DELETE …/domains/{name}（同一条上游路径）
await runWrite("POST", "/v1/pages/proj/domains", { name: "www.example.com" });
expectOne("POST Pages domains", `/accounts/${ACC}/pages/projects/proj/domains`, {
  method: "POST",
  bodyIncludes: `"name":"www.example.com"`,
});
await runWrite("DELETE", "/v1/pages/proj/domains/www.example.com");
expectOne("DELETE Pages domains/:name", `/accounts/${ACC}/pages/projects/proj/domains/www.example.com`, { method: "DELETE" });

// Pages 环境变量：客户端 PUT {environment,vars} → 上游 PATCH 项目对象的 deployment_configs
await runWrite("PUT", "/v1/pages/proj/env_vars", { environment: "production", vars: { FOO: { value: "bar", type: "plain_text" } } });
expectOne("PUT Pages env_vars（上游 PATCH 项目对象）", `/accounts/${ACC}/pages/projects/proj`, {
  method: "PATCH",
  bodyIncludes: `"deployment_configs":{"production":{"env_vars":{"FOO":{"value":"bar","type":"plain_text"}}}}`,
});

// 站点 Workers 路由：POST / PUT / DELETE 同路径
await runWrite("POST", "/v1/zones/" + ZONE + "/routes", { pattern: "example.com/*", script: "hello" });
expectOne("POST zone routes", `/zones/${ZONE}/workers/routes`, { method: "POST", bodyIncludes: `"pattern":"example.com/*"` });
await runWrite("PUT", "/v1/zones/" + ZONE + "/routes/" + "f".repeat(32), { pattern: "example.com/*", script: "hello" });
expectOne("PUT zone routes/:id", `/zones/${ZONE}/workers/routes/${"f".repeat(32)}`, { method: "PUT" });
await runWrite("DELETE", "/v1/zones/" + ZONE + "/routes/" + "f".repeat(32));
expectOne("DELETE zone routes/:id", `/zones/${ZONE}/workers/routes/${"f".repeat(32)}`, { method: "DELETE" });

// 脚本级 workers.dev 开关：客户端 PUT → 上游 POST，两个布尔全量写
await runWrite("PUT", "/v1/workers/hello/subdomain", { enabled: true, previews_enabled: false });
expectOne("PUT workers/:s/subdomain（上游 POST）", `/accounts/${ACC}/workers/scripts/hello/subdomain`, {
  method: "POST",
  bodyIncludes: `"enabled":true,"previews_enabled":false`,
});

// ---- Workers Builds 连接（2026-11-02，按官方规格拼，未实测）----
// 客户端一条 POST /v1/workers/{s}/builds → 上游两次调用：先 PUT connections，再 POST triggers。
const CONN_UUID = "C".repeat(32);
const BUILD_CLIENT_BODY = {
  provider_type: "github",
  provider_account_id: 4242,
  provider_account_name: "octo",
  repo_id: 123456,
  repo_name: "octo/site",
  trigger_name: "octo/site",
  build_command: "npm run build",
  deploy_command: "npx wrangler deploy",
  build_token_uuid: "a".repeat(32),
  branch_includes: ["main"],
  branch_excludes: [],
  path_includes: [],
  path_excludes: [],
  root_directory: "",
  build_caching_enabled: false,
};
await runWrite("POST", "/v1/workers/hello/builds", BUILD_CLIENT_BODY);
expectOne("POST workers/:s/builds（① PUT 仓库连接）", `/accounts/${ACC}/builds/repos/connections`, {
  method: "PUT",
  bodyIncludes: `"repo_id":123456`,
});
expectOne("POST workers/:s/builds（② POST 触发器，用 connection uuid）", `/accounts/${ACC}/builds/triggers`, {
  method: "POST",
  bodyIncludes: `"repo_connection_uuid":"${CONN_UUID}"`,
});
{
  const hit = captured.find((c) => c.url.endsWith("/builds/triggers") && c.method === "POST");
  const body = String(hit?.body || "");
  // external_script_id 必须是脚本 tag，不是脚本名 —— 这是最容易写错的一处
  if (!body.includes(`"external_script_id":"TAG-1"`)) {
    console.error(`❌ 触发器 body 的 external_script_id 不是脚本 tag（实际：${body.slice(0, 200)}）`);
    fail = true;
  } else { pass++; console.log("✅ 触发器 external_script_id 用的是脚本 tag"); }
}
await runWrite("DELETE", "/v1/builds/" + "e".repeat(32));
expectOne("DELETE builds/:id（上游 triggers/{uuid}）", `/accounts/${ACC}/builds/triggers/${"e".repeat(32)}`, { method: "DELETE" });

// 负例：未知字段 / 非数字 repo_id / 非法分支名 / path_includes 非空 —— 全部零出网
await expectReject("Workers Builds 白名单外字段被拒绝", () =>
  writeDirect(CTX, "POST", "/v1/workers/hello/builds", { ...BUILD_CLIENT_BODY, deploy_on_push: true }));
await expectReject("Workers Builds 非数字 repo_id 被拒绝", () =>
  writeDirect(CTX, "POST", "/v1/workers/hello/builds", { ...BUILD_CLIENT_BODY, repo_id: "abc" }));
await expectReject("Workers Builds 非法分支名被拒绝", () =>
  writeDirect(CTX, "POST", "/v1/workers/hello/builds", { ...BUILD_CLIENT_BODY, branch_includes: ["bad~name"] }));
await expectReject("Workers Builds 非空 path_includes 被拒绝", () =>
  writeDirect(CTX, "POST", "/v1/workers/hello/builds", { ...BUILD_CLIENT_BODY, path_includes: ["src/**"] }));

// ---- Pages 连接已有 Git 仓库（2026-11-01）：客户端 PATCH /v1/pages/{p}/git →
// 上游 PATCH 项目对象。⚠️ 请求形状按官方规格拼，**没有真实账号实测**（要连的账号必须先装过 Git App），
// 所以这里只锁「我们发出去的到底是什么」，不代表上游一定 200。
await runWrite("PATCH", "/v1/pages/proj/git", {
  source: { type: "github", config: { owner: "octo", repo_name: "site", production_branch: "main" } },
  build_config: { build_command: "npm run build", destination_dir: "dist" },
});
expectOne("PATCH Pages git（上游 PATCH 项目对象 + source/build_config）", `/accounts/${ACC}/pages/projects/proj`, {
  method: "PATCH",
  bodyIncludes: `"source":{"type":"github"`,
});
{
  const hit = captured.find((c) => c.url.endsWith("/pages/projects/proj") && c.method === "PATCH");
  const body = String(hit?.body || "");
  // 只带白名单字段：多一个未知键上游就可能整条 400，而且 deployments_enabled 必须是 true
  const parsed = body ? JSON.parse(body) : {};
  const topKeys = Object.keys(parsed).sort().join(",");
  if (topKeys !== "build_config,production_branch,source" || parsed.source?.config?.deployments_enabled !== true) {
    console.error(`❌ Pages git 上游体字段不对：顶层=${topKeys}，deployments_enabled=${parsed.source?.config?.deployments_enabled}`);
    fail = true;
  } else { pass++; console.log("✅ Pages git 上游体只带 source/build_config/production_branch"); }
}

// 负例：顶层 production_branch 与 source.config 里的不一致必须被拒（两处不一致上游只会挑一个）
rejected = false;
try {
  await runWrite("PATCH", "/v1/pages/proj/git", {
    source: { type: "github", config: { owner: "octo", repo_name: "site", production_branch: "main" } },
    production_branch: "dev",
  });
} catch { rejected = true; }
if (!rejected) { console.error("❌ Pages git 顶层 production_branch 与 source.config 不一致应被拒绝"); fail = true; } else { pass++; console.log("✅ Pages git 两处 branch 不一致被拒绝"); }

// 负例：白名单外的字段必须被拒（不夹带未验证字段上游）
rejected = false;
try {
  await runWrite("PATCH", "/v1/pages/proj/git", {
    source: { type: "github", config: { owner: "octo", repo_name: "site", production_branch: "main" } },
    deploy_on_push: true,
  });
} catch { rejected = true; }
if (!rejected) { console.error("❌ Pages git 白名单外字段应被拒绝"); fail = true; } else { pass++; console.log("✅ Pages git 白名单外字段被拒绝"); }

console.log(`\n合计：${pass} 条通过，${fail ? "有失败 ❌" : "0 条失败 ✅"}`);
process.exit(fail ? 1 : 0);
