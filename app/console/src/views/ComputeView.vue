<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { reloadTick, requestReload } from "../lib/bus";
import { useRouter } from "vue-router";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import ComputeBoard from "../components/compute/ComputeBoard.vue";
import GitConnectDialog from "../components/compute/GitConnectDialog.vue";
import WorkerRepoDialog from "../components/compute/WorkerRepoDialog.vue";
import WorkersQuota from "../components/ver/WorkersQuota.vue";
import CleanupPanel from "../components/ver/CleanupPanel.vue";
import { api, apiAs, forceFreshWindow, GwError, pageDeployed, pageLastActivity, workerName } from "../lib/api";
import { loadConfig } from "../lib/config";
import { getWorkerRepo, type GitPlatform, type WorkerRepoLink } from "../lib/git";
import { dt, rel } from "../lib/fmt";
import { labelOf, type CfAccount } from "../lib/accounts";
import { agg, aggAccounts, aggSkipped, focusAccount, mapLimit } from "../lib/aggregate";

const nav = useRouter();

/** 当前单账号 id：本机记录（Workers 仓库）按账号分开存 */
const accountId = computed(() => loadConfig().account);

/* ---------- 多账号合一（只读）：Workers / Pages 两份清单直接相加 ---------- */
const aggErrors = ref<Array<{ accName: string; label: string; err: GwError }>>([]);
const aggLoading = ref(false);
const aggDone = ref(0);

const arrOf = (r: any): any[] => (Array.isArray(r?.result) ? r.result : []);
const asGw = (e: unknown): GwError => (e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e)));
const tagged = (items: any[], a: CfAccount): any[] => items.map((x) => ({ ...x, __acc: a.id, __accName: labelOf(a) }));

/**
 * 合并取数：账号之间并发 2；Workers / Pages 两条各自 catch ——
 * 一个账号缺 Pages 权限不该把它的 Worker 也一起抹掉。
 */
async function loadAgg() {
  aggLoading.value = true;
  aggDone.value = 0;
  workersLoading.value = true;
  pagesLoading.value = true;
  workersErr.value = null;
  pagesErr.value = null;
  aggErrors.value = [];
  const accs = aggAccounts();
  const outW: any[] = [];
  const outP: any[] = [];
  let done = 0;
  await mapLimit(accs, 2, async (a) => {
    const e = apiAs(a.id);
    const [wr, pr] = await Promise.allSettled([e.workers(), e.pages()]);
    if (wr.status === "fulfilled") outW.push(...tagged(arrOf(wr.value), a));
    else aggErrors.value.push({ accName: labelOf(a), label: "Workers", err: asGw(wr.reason) });
    if (pr.status === "fulfilled") outP.push(...tagged(arrOf(pr.value), a));
    else aggErrors.value.push({ accName: labelOf(a), label: "Pages", err: asGw(pr.reason) });
    aggDone.value = ++done;
  });
  workers.value = outW;
  pages.value = outP;
  workersLoading.value = false;
  pagesLoading.value = false;
  aggLoading.value = false;
}

/** 退出合并视图（顶栏下拉里也有同一个开关） */
function exitAgg() {
  agg.on = false;
  requestReload();
}

/* ---- Workers 列表 ---- */
const workers = ref<any[]>([]);
const workersErr = ref<GwError | null>(null);
const workersLoading = ref(false);
const wq = ref("");
const wsort = ref<"modified" | "name">("modified");

async function loadWorkers() {
  if (agg.on) return; // 合并模式由 loadAgg 统一取两列表
  workersLoading.value = true;
  workersErr.value = null;
  try {
    const r = await api.workers();
    workers.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    workersErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    workersLoading.value = false;
  }
}

const shownWorkers = computed(() => {
  const s = wq.value.trim().toLowerCase();
  const arr = s ? workers.value.filter((w) => workerName(w).toLowerCase().includes(s)) : [...workers.value];
  return wsort.value === "name"
    ? arr.sort((a, b) => workerName(a).localeCompare(workerName(b)))
    : arr.sort((a, b) => String(b.modified_on || "").localeCompare(String(a.modified_on || "")));
});

/** 宫格与 Worker 详情页的分区一一对应（9 张卡 9 个入口，不再有"这张卡没有入口"的情况） */
const workerCards = [
  { ico: "versions", label: "版本列表", c: "versions" },
  { ico: "deployments", label: "部署历史", c: "deployments" },
  { ico: "traffic", label: "流量归属", c: "traffic" },
  { ico: "globe", label: "自定义域名", c: "domains" },
  { ico: "settings", label: "配置信息", c: "settings" },
  { ico: "link", label: "绑定", c: "bindings" },
  { ico: "secrets", label: "变量与 Secret", c: "secrets" },
  { ico: "crons", label: "定时触发器", c: "crons" },
  { ico: "switch", label: "版本切换", c: "switch" },
];

function workerActionsFor(w: any) {
  return [
    ...workerCards.map((k) => ({ ico: k.ico, label: k.label, go: `${k.c}|${workerName(w)}` })),
    { ico: "git", label: "仓库", go: "repo" },
    {
      ico: "logs",
      label: "日志",
      go: "logs",
      why: "实时日志走 WebSocket 中继（tail.developers.workers.dev），这一版没实现，所以这里没有数据可看。",
    },
  ];
}

function onWorkerGo(a: any, w: any) {
  if (a.go === "repo") { repoWorker.value = w; return; }
  if (!a.go.includes("|")) return;
  const [c] = a.go.split("|");
  if (agg.on && w.__acc) focusAccount(String(w.__acc)); // 详情页读"当前账号"，先切过去
  nav.push(`/workers/${encodeURIComponent(workerName(w))}?c=${c}`);
}
function openWorker(w: any) {
  if (agg.on && w.__acc) focusAccount(String(w.__acc));
  nav.push("/workers/" + encodeURIComponent(workerName(w)));
}

/* ---- Pages 列表 ---- */
const pages = ref<any[]>([]);
const pagesErr = ref<GwError | null>(null);
const pagesLoading = ref(false);

async function loadPages() {
  if (agg.on) return; // 合并模式由 loadAgg 统一取两列表
  pagesLoading.value = true;
  pagesErr.value = null;
  try {
    const r = await api.pages();
    pages.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    pagesErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    pagesLoading.value = false;
  }
}

const hasProject = computed(() => pages.value.length > 0);

/* ---------- Pages / Workers 连接 Git 仓库（2026-11-02） ----------
 * Pages 是真写（PATCH 项目对象，仅 APK 直连）；Workers 也是真写（Workers Builds API，
 * 客户端一条 POST 由直连层/网关拆成 connection + trigger 两次上游调用）。
 * 本机缓存仍留一份摘要给列表徽章用：connected=true 只来自「读到真实 trigger」或「刚连成功」，
 * 拿不到就不写 —— 徽章宁可没有，也不说没证据的话。 */
const gitProject = ref<any | null>(null);
const gitNote = ref("");
const repoWorker = ref<any | null>(null);
const repoTick = ref(0);

const repoAccount = computed(() => String(repoWorker.value?.__acc ?? accountId.value));
const repoWorkerName = computed(() => workerName(repoWorker.value ?? {}));

/** 列表里的项目对象带 source 时才算"已连接"；没有这个字段就不猜 */
function pageSource(p: any): { platform: GitPlatform; owner: string; repo: string; branch: string } | null {
  const t = String(p?.source?.type ?? "");
  if (t !== "github" && t !== "gitlab") return null;
  const c = p.source?.config ?? {};
  const owner = String(c.owner ?? "");
  const repo = String(c.repo_name ?? c.repo ?? "");
  if (!owner || !repo) return null;
  return { platform: t, owner, repo, branch: String(c.production_branch ?? p.production_branch ?? "") };
}

function pageGitBadges(p: any): { text: string; cls?: string; title?: string }[] {
  const s = pageSource(p);
  return s ? [{ text: `Git · ${s.owner}/${s.repo}`, title: `source.type=${s.platform} · 生产分支 ${s.branch || "—"}（来自项目对象的 source 字段）` }] : [];
}

/** 本机记录按「账号|Worker」存；读一次成表，避免每一行都去解析 localStorage */
const workerRepoMap = computed(() => {
  repoTick.value;
  const m = new Map<string, WorkerRepoLink>();
  for (const w of workers.value) {
    const acc = String(w.__acc ?? accountId.value);
    const r = getWorkerRepo(acc, workerName(w));
    if (r) m.set(acc + "|" + workerName(w), r);
  }
  return m;
});
function workerRepoOf(w: any): WorkerRepoLink | null {
  return workerRepoMap.value.get(String(w.__acc ?? accountId.value) + "|" + workerName(w)) ?? null;
}

function workerRepoBadges(w: any): { text: string; cls?: string; title?: string }[] {
  const r = workerRepoOf(w);
  if (!r) return [];
  const who = r.platform === "gitlab" ? "GitLab" : "GitHub";
  if (!r.connected) {
    return [{ text: "本机记录", title: `只是本机摘要：${who} ${r.owner}/${r.repo}${r.branch ? " · " + r.branch : ""}。没有读到真实触发器，不代表已连接。` }];
  }
  return [{
    text: `Git · ${r.owner}/${r.repo}`,
    title: `${who} · 触发分支 ${r.branch || "不限"}${r.triggerId ? " · trigger " + r.triggerId : ""}（来自 Workers Builds 的触发器列表）`,
  }];
}

function onGitConnected(v: { owner: string; repo: string; branch: string }) {
  gitNote.value = `已连接 ${v.owner}/${v.repo} · 分支 ${v.branch}（项目会按 Git 构建，旧部署记录仍可回滚）`;
  refresh();
}

/** 项目详情拆成与 Workers 详情同一套分区：点行进详情，动作宫格直接落到对应卡片 */
const pageCards = [
  { ico: "settings", label: "概览", c: "overview" },
  { ico: "deployments", label: "部署历史", c: "deps" },
  { ico: "traffic", label: "自定义域名", c: "domains" },
  { ico: "secrets", label: "环境变量", c: "env" },
  { ico: "buildlog", label: "构建日志", c: "logs" },
];
const projectActions = [
  ...pageCards.map((k) => ({ ico: k.ico, label: k.label, go: `${k.c}|${k.c}` })),
];

/** 合并视图只读：连接仓库是写操作，必须落在单个账号上（点了直接说原因，不静默用错账号） */
function projectActionsFor() {
  return [
    { ico: "git", label: "连接仓库", go: "git", why: agg.on ? "合并视图只读：写操作要切到单个账号再进这一屏。" : undefined },
    ...projectActions,
  ];
}

function pagePath(p: any) {
  return "/pages/" + encodeURIComponent(String(p.name ?? ""));
}
function openProject(p: any) {
  if (agg.on && p.__acc) focusAccount(String(p.__acc));
  nav.push(pagePath(p));
}
function onProjectGo(p: any, a: any) {
  if (a.go === "git") { gitProject.value = p; return; }
  if (!a.go.includes("|")) return;
  if (agg.on && p.__acc) focusAccount(String(p.__acc));
  nav.push(pagePath(p) + "?c=" + a.go.split("|")[0]);
}

/** 「刷新」绕过两层缓存真出一次 */
const quotaTick = ref(0);
/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
function refresh() {
  forceFreshWindow();
  quotaTick.value++;
  if (agg.on) { void loadAgg(); return; }
  void loadWorkers();
  void loadPages();
}

onMounted(() => {
  if (agg.on) { void loadAgg(); return; }
  void loadWorkers();
  void loadPages();
});

/** 顶部分段：默认「看板」= Workers + Pages 二合一（一块看板读完两类资源）；
 *  「Workers」/「Pages」两档才是逐项动手的完整列表。 */
const kind = ref<"all" | "workers" | "pages">("all");

/** 版本清理面板要处理的 Worker 集合：默认空，必须手动勾，绝不默认全选 */
const cleanSel = ref<string[]>([]);
function toggleClean(w: string) {
  cleanSel.value = cleanSel.value.includes(w) ? cleanSel.value.filter((x) => x !== w) : [...cleanSel.value, w];
}
</script>

<template>
  <div>
    <!-- Workers / Pages 分段：默认看板（二合一），另两档是逐项动手的完整列表。
         原来这三档叫「全部 / Workers / Pages」，而「全部」只是把两张表上下拼起来，
         数量与时间各写一遍 —— 现在「看板」真的是一块合并后的读数面。 -->
    <div class="row segs">
      <button class="chip" :class="{ on: kind === 'all' }" @click="kind = 'all'">看板</button>
      <button class="chip" :class="{ on: kind === 'workers' }" @click="kind = 'workers'">Workers</button>
      <button class="chip" :class="{ on: kind === 'pages' }" @click="kind = 'pages'">Pages</button>
    </div>
    <div v-if="kind === 'all'" class="small muted" style="margin-bottom: 10px">
      看板只汇总、不放逐项动作：要连接仓库请切到 Pages 分档（项目行第一个动作）或 Workers 分档（行内「仓库」）。
    </div>

    <!-- 合并视图（只读）：账号数、取数进度、逐账号失败都在这里说清 -->
    <div v-if="agg.on" class="aggbar">
      <div class="aggtop">
        <span class="aggt">合并视图 · {{ aggAccounts().length }} 个账号 · 只读</span>
        <button class="ghost sm" @click="exitAgg">退出合并</button>
      </div>
      <div class="small muted" v-if="aggLoading">
        正在取数：{{ aggDone }}/{{ aggAccounts().length }} 个账号已就绪
      </div>
      <div class="small muted" v-else>点条目会先切到它所属账号再进详情；写操作请在单账号下进行。</div>
      <div class="small muted" v-if="aggSkipped().length">网页模式跳过 {{ aggSkipped().length }} 个 OAuth 账号（拿不到令牌）。</div>
      <div v-for="(x, i) in aggErrors" :key="i" class="small agg-err">
        {{ x.accName }} · {{ x.label }}：{{ x.err.hint }}
      </div>
    </div>

    <!-- 每日额度：接口只给事件数，请求数与上限的来源在这块内部各自标清（docs/09 §E16）。
         合并视图里额度只对当前账号有意义，故收起。 -->
    <WorkersQuota v-if="kind !== 'pages' && !agg.on" :tick="quotaTick" />

    <!-- 二合一看看板：4 格合计 + 一份按最近改动并起来的清单（只用上面两条列表，不发额外请求） -->
    <ComputeBoard
      v-if="kind === 'all'"
      :workers="workers"
      :pages="pages"
      :w-err="workersErr"
      :p-err="pagesErr"
      :loading="workersLoading || pagesLoading"
      :agg="agg.on"
    />

    <!-- Workers 区块（逐项动手时才展开） -->
    <div class="card" v-if="kind === 'workers'">
      <h3>Workers（{{ workers.length }} 个）</h3>
      <ErrorNote :err="workersErr" />
      <div class="small muted" style="margin: 6px 0 10px">
        Worker 行里的「仓库」连接 Workers Builds：选一个 Git 仓库、填构建/部署命令与 build token，推送后真的会构建并部署。
        连接成功前不会显示 Git 徽章；端点按官方规格拼成，尚未在真实账号实测，错误会原样上屏。
      </div>
      <div v-if="workers.length" style="margin-bottom: 10px">
        <div class="row wtool">
          <input v-model="wq" class="field" placeholder="搜索 Worker 名称" />
          <!-- 排序并成一个键：两个 chip 只切一个状态，占一行不值当 -->
          <button
            class="chip"
            :title="wsort === 'modified' ? '当前按修改时间排序，点一下改成按名称' : '当前按名称排序，点一下改成按修改时间'"
            @click="wsort = wsort === 'modified' ? 'name' : 'modified'"
          >{{ wsort === "modified" ? "按修改时间" : "按名称" }}</button>
        </div>
      </div>
      <div class="empty" v-if="workersLoading && !shownWorkers.length">加载中…</div>
      <div class="rows" v-if="shownWorkers.length">
        <!-- max=10：9 张分区卡 + 「仓库」全部露出，只剩没实现的「日志」收进更多 -->
        <RowCard
          v-for="w in shownWorkers"
          :key="(w.__acc || '') + workerName(w)"
          :title="workerName(w)"
          :meta="`${rel(w.modified_on)} 修改 · ${dt(w.created_on, false)} 创建`"
          :max="10"
          :badges="[
            ...(w.__accName ? [{ text: w.__accName, title: '归属账号 ' + w.__acc }] : []),
            ...(w.tail_consumers && w.tail_consumers.length ? [{ text: '实时日志', title: '字段 tail_consumers：这个 Worker 挂了 Workers Tail 消费者（实时日志流）' }] : []),
            ...(w.logpush ? [{ text: '日志推送', title: '字段 logpush：日志往外推给第三方（Logpush）' }] : []),
            ...(w.has_assets ? [{ text: '静态资源', title: '字段 has_assets：绑了 Workers Static Assets，除代码还托管文件（页面/图片这类）' }] : []),
            ...workerRepoBadges(w),
            ...(w.placement?.mode === 'smart' ? [{ text: '智能放置', cls: 'roll', title: 'Smart Placement：CF 把执行点放到离你的数据源（D1/KV/R2/源站）最近的边缘，而不是只就近访问者' }] : []),
          ]"
          :actions="workerActionsFor(w)"
          @open="openWorker(w)"
          @go="(a) => onWorkerGo(a, w)"
        />
      </div>
      <div v-else-if="!workersLoading && !workersErr" class="empty">
        {{ agg.on ? "这些账号里都没有 Worker" : "这个账号里没有 Worker" }}
      </div>
    </div>

    <!-- 版本清理：低频运维功能，默认收起（2026-10-25）。
         收起之前它跟上面的 Worker 列表摆成"两份清单"，看着像重复数据。
         展开后仍是原来那块：候选必须手勾，默认空。只看板不摆它，切到 Workers 档才出现。 -->
    <details class="foldcard" v-if="kind === 'workers' && !agg.on">
      <summary>
        <span>版本清理</span>
        <span class="fc-s">批量删旧部署记录</span>
      </summary>
      <div class="fc-body">
        <div class="small muted" style="margin-bottom: 8px">
          勾选要清理的 Worker → 「分析」→ 只删超出保留窗口、且不包含运行中版本的<b>部署记录</b>。
          删除版本本体那条路由 CF 对 API Token 一律 405，所以这里不走它。
        </div>
        <div class="row" style="flex-wrap: wrap; gap: 4px; margin-bottom: 10px">
          <button
            v-for="w in workers"
            :key="workerName(w)"
            class="chip"
            :class="{ on: cleanSel.includes(workerName(w)) }"
            type="button"
            @click="toggleClean(workerName(w))"
          >{{ workerName(w) }}</button>
        </div>
        <CleanupPanel :workers="cleanSel" @changed="refresh" />
      </div>
    </details>

    <!-- Pages 区块（逐项动手时才展开） -->
    <div class="card" v-if="kind === 'pages'">
      <h3>Pages 项目（{{ pages.length }} 个）</h3>
      <ErrorNote :err="pagesErr" />

      <div class="small muted" style="margin: 6px 0 10px">
        点项目行或下方任一动作进入项目详情：概览、部署历史（含回滚 / 重试 / 构建日志）、自定义域名、环境变量与构建配置。
        「连接仓库」是把已有项目接到已有 Git 仓库，不新建项目；只有 APK 直连模式能发这条写请求。
        已经连过 Git 的项目，行上会多一个「Git · owner/repo」徽章（来自项目对象的 source 字段；拿不到就不显示，不猜）。
      </div>
      <div v-if="gitNote" class="small" style="margin-bottom: 8px; color: var(--ok)">{{ gitNote }}</div>

      <div v-if="!hasProject && !pagesLoading && !pagesErr" class="small muted">
        {{ agg.on
          ? "这些账号里都没有 Pages 项目（不是没取到：两条列表都返回了空）"
          : "这个账号还没有 Pages 项目（不是没取到：令牌能过 Pages 路由，缺的是数据）。后台建一个，这块立刻就有内容。" }}
      </div>

      <div class="rows" v-if="hasProject">
        <RowCard
          v-for="p in pages"
          :key="(p.__acc || '') + String(p.name)"
          :title="String(p.name)"
          :meta="`${p.production_branch || '无分支'} • ${p.subdomain || '—'} • ${rel(pageLastActivity(p))}${pageDeployed(p) ? ' 部署' : ' 创建'}`"
          :badges="[
            ...(p.__accName ? [{ text: p.__accName, title: '归属账号 ' + p.__acc }] : []),
            { text: pageDeployed(p) ? '已部署' : '无部署', cls: pageDeployed(p) ? 'live' : undefined },
            ...pageGitBadges(p),
          ]"
          :actions="projectActionsFor()"
          @open="openProject(p)"
          @go="(a) => onProjectGo(p, a)"
        />
      </div>
    </div>

    <!-- 两个仓库对话框：Pages 走 PATCH 项目对象，Workers 走 Workers Builds（都是真写） -->
    <GitConnectDialog
      :project="gitProject ? String(gitProject.name) : null"
      :existing="gitProject ? pageSource(gitProject) : null"
      @close="gitProject = null"
      @connected="onGitConnected"
    />
    <WorkerRepoDialog
      :worker="repoWorker ? repoWorkerName : null"
      :account="repoAccount"
      @close="repoWorker = null"
      @changed="repoTick++"
    />
  </div>
</template>

<style scoped>
/* 顶部分段：ghx 的 pill 组，只靠描边/选中面分层，不叠投影 */
.segs { gap: 4px; margin: 0 0 12px; }

/* 合并视图状态条：一条强调色左轨 + 浅底，不再画成一整张卡片 */
.aggbar { border-left: 3px solid var(--accent); border-radius: 0 var(--r-sm) var(--r-sm) 0;
  padding: 9px 11px; margin-bottom: 10px; background: rgb(var(--accent-rgb) / .06); }
.aggtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.aggt { font-size: var(--t-sm); font-weight: 650; color: var(--accent); }
.agg-err { color: var(--bad); margin-top: 3px; }
/* 列表工具条：搜索框吃掉剩余宽度，排序键靠右 */
.wtool { gap: 6px; margin-bottom: 8px; }
.wtool .field { flex: 1; min-width: 0; max-width: 220px; }

/* 版本清理的折叠卡：ghx 的分区眉题（大写字距 + 发丝线），不再套一层圆角壳。
   展开后内容照旧走全局 .card 的读数轨语义。 */
.foldcard { border: 0; background: transparent; margin: 16px 0 10px; overflow: visible; }
.foldcard > summary {
  display: flex; align-items: center; gap: 8px; padding: 0 2px 7px;
  border-bottom: 1px solid var(--line-soft);
  cursor: pointer; list-style: none;
  font-size: var(--t-2xs); font-weight: 600; color: var(--muted);
  letter-spacing: .04em; text-transform: uppercase;
}
.foldcard > summary::-webkit-details-marker { display: none; }
.foldcard > summary::before {
  content: ""; width: 6px; height: 6px; flex: none;
  border-right: 1.6px solid var(--muted); border-bottom: 1.6px solid var(--muted);
  transform: rotate(-45deg); transition: transform .18s ease;
}
.foldcard[open] > summary::before { transform: rotate(45deg); }
.fc-s { margin-left: auto; font-size: var(--t-2xs); font-weight: 400; color: var(--muted);
  letter-spacing: 0; text-transform: none; }
.fc-body { padding: 10px 0 0; }
</style>
