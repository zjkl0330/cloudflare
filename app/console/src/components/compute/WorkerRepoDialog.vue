<script setup lang="ts">
/**
 * Workers 的「仓库」面板（2026-11-02 改为真连接）。
 *
 * 背景：2026-11-01 这里还只能把 owner/repo 记在本机，因为当时判断 Workers Builds 没有官方 API。
 * 现在按官方规格走 `PUT builds/repos/connections` → `POST builds/triggers` 两次上游调用
 * （客户端只发一条 POST /v1/workers/{s}/builds，由直连层 / 网关各拆两段）。
 *
 * 三条必须守住的边界（与 Pages 的 GitConnectDialog 同一口径）：
 *  1. **没有实测过**：界面上明写"按官方规格拼、未在真实账号验证"，错误原样上屏，不把 403 说成成功；
 *  2. 仓库数字 id 不猜：列表拿不到 id、手填查不到仓库，就直接报错让人改输入；
 *  3. build token 必须先在 dashboard 建好 —— 这里只负责选，不伪造一个 uuid。
 *
 * 网页模式下 GitLab 的 API 没有 CORS（列不出仓库、也查不到数字 id），所以只放行 GitHub 新连接；
 * 已有 GitLab 触发器的读取与断开不受影响（那两条走网关）。
 */
import { computed, ref, watch } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import WriteGate from "../WriteGate.vue";
import {
  api,
  GwError,
  isNativeApp,
  previewWorkerBuild,
  previewWorkerBuildDelete,
  writesOptIn,
  type BuildToken,
  type WorkerBuildInput,
  type WorkerBuildTrigger,
  type WritePreview,
} from "../../lib/api";
import {
  clearGitToken,
  getGitToken,
  getWorkerRepo,
  listGitRepos,
  maskToken,
  PLATFORM_LABEL,
  removeWorkerRepo,
  resolveGitRepo,
  saveWorkerRepo,
  setGitToken,
  type GitPlatform,
  type GitRepo,
} from "../../lib/git";

const props = defineProps<{ worker: string | null; account: string }>();
const emit = defineEmits<{ (e: "close"): void; (e: "changed"): void }>();

const native = isNativeApp();
const optIn = ref(writesOptIn());

/* ---------- 读侧：现有触发器 + build token ---------- */
const triggers = ref<WorkerBuildTrigger[]>([]);
const triggersLoading = ref(false);
const triggersErr = ref("");
const tokens = ref<BuildToken[]>([]);
const tokensLoading = ref(false);
const tokensErr = ref("");
const buildTokenUuid = ref("");

/* ---------- 仓库来源 ---------- */
const platform = ref<GitPlatform>("github");
const savedToken = ref<string | null>(null);
const tokenInput = ref("");
const reveal = ref(false);
const tokenErr = ref("");
const tokenBusy = ref(false);

const repos = ref<GitRepo[]>([]);
const reposLoading = ref(false);
const reposErr = ref("");
const repoQuery = ref("");
const selected = ref("");
const mode = ref<"mine" | "manual">("mine");
const manualOwner = ref("");
const manualRepo = ref("");

/* ---------- 构建配置 ---------- */
const branchIncludes = ref("");
const branchExcludes = ref("");
const buildCommand = ref("");
const deployCommand = ref("");
const rootDirectory = ref("");
const triggerName = ref("");
const caching = ref(false);

/* ---------- 写侧流程 ---------- */
const formErr = ref("");
const note = ref("");
const busy = ref(false);
const resolveBusy = ref(false);
const preview = ref<WritePreview | null>(null);
const sheetErr = ref("");
const pendingInput = ref<WorkerBuildInput | null>(null);
const pendingDelete = ref<WorkerBuildTrigger | null>(null);

const who = computed(() => PLATFORM_LABEL[platform.value]);
const filteredRepos = computed(() => {
  const q = repoQuery.value.trim().toLowerCase();
  return q ? repos.value.filter((r) => r.fullName.toLowerCase().includes(q)) : repos.value;
});
const selectedRepo = computed(() => repos.value.find((r) => r.fullName === selected.value) ?? null);
const canConnect = computed(() => !!props.worker && optIn.value && !busy.value && !resolveBusy.value);

function errText(e: unknown): string {
  return e instanceof GwError ? e.message : String((e as Error)?.message || e);
}

/* ---------- 读触发器：顺带把「本机徽章摘要」校准成真连接 ---------- */
async function loadTriggers() {
  const w = props.worker;
  if (!w) return;
  triggersLoading.value = true;
  triggersErr.value = "";
  try {
    const r = await api.workerBuilds(w);
    const data = r.result;
    triggers.value = Array.isArray(data?.triggers) ? data.triggers : [];
    const first = triggers.value[0];
    if (first && String(first.repo_name ?? "").includes("/")) {
      const full = String(first.repo_name);
      const p: GitPlatform = String(first.provider_type ?? "") === "gitlab" ? "gitlab" : "github";
      saveWorkerRepo(props.account, w, {
        platform: p,
        owner: full.slice(0, full.lastIndexOf("/")),
        repo: full.slice(full.lastIndexOf("/") + 1),
        branch: Array.isArray(first.branch_includes) ? first.branch_includes.join(",") : "",
        connected: true,
        triggerId: String(first.trigger_uuid ?? ""),
      });
    } else if (getWorkerRepo(props.account, w)?.connected) {
      // 读到了真实列表且为空：本机那条「已连接」已经过期，删掉，别让列表徽章继续撒谎
      removeWorkerRepo(props.account, w);
    }
  } catch (e) {
    triggersErr.value = errText(e);
  } finally {
    triggersLoading.value = false;
  }
}

async function loadTokens() {
  tokensLoading.value = true;
  tokensErr.value = "";
  try {
    const r = await api.buildsTokens();
    tokens.value = Array.isArray(r.result) ? r.result : [];
    if (!buildTokenUuid.value && tokens.value.length === 1) {
      buildTokenUuid.value = String(tokens.value[0].build_token_uuid ?? "");
    }
  } catch (e) {
    tokensErr.value = errText(e);
  } finally {
    tokensLoading.value = false;
  }
}

/* ---------- 令牌与仓库名单（与 Pages 的 GitConnectDialog 同一套钥匙串） ---------- */
async function resetForPlatform() {
  repos.value = [];
  repoQuery.value = "";
  selected.value = "";
  tokenInput.value = "";
  tokenErr.value = "";
  reposErr.value = "";
  savedToken.value = await getGitToken(platform.value);
  if (savedToken.value) void loadRepos();
}

async function loadRepos() {
  const t = savedToken.value;
  if (!t) return;
  reposLoading.value = true;
  reposErr.value = "";
  try {
    repos.value = await listGitRepos(platform.value, t);
    if (!repos.value.length) reposErr.value = `这把令牌看得见的 ${who.value} 仓库是空的（接口返回了 0 条，不是失败）。`;
  } catch (e) {
    reposErr.value = errText(e);
  } finally {
    reposLoading.value = false;
  }
}

async function saveToken() {
  tokenErr.value = "";
  tokenBusy.value = true;
  try {
    await setGitToken(platform.value, tokenInput.value);
    savedToken.value = tokenInput.value.trim();
    tokenInput.value = "";
    mode.value = "mine";
    await loadRepos();
  } catch (e) {
    tokenErr.value = errText(e);
  } finally {
    tokenBusy.value = false;
  }
}

async function removeToken() {
  tokenErr.value = "";
  try {
    await clearGitToken(platform.value);
  } catch (e) {
    tokenErr.value = errText(e);
  }
  savedToken.value = null;
  repos.value = [];
  selected.value = "";
}

function pickRepo(full: string) {
  selected.value = full;
  const r = repos.value.find((x) => x.fullName === full);
  branchIncludes.value = r?.defaultBranch || "";
  triggerName.value = r?.fullName || "";
}

/* ---------- 打开 / 换平台 ---------- */
async function loadAll() {
  if (!props.worker) return;
  formErr.value = "";
  note.value = "";
  sheetErr.value = "";
  preview.value = null;
  pendingInput.value = null;
  pendingDelete.value = null;
  busy.value = false;
  resolveBusy.value = false;
  mode.value = "mine";
  branchIncludes.value = "";
  branchExcludes.value = "";
  buildCommand.value = "";
  deployCommand.value = "";
  rootDirectory.value = "";
  triggerName.value = "";
  caching.value = false;
  manualOwner.value = "";
  manualRepo.value = "";
  buildTokenUuid.value = "";
  tokens.value = [];
  triggers.value = [];
  triggersErr.value = "";
  void loadTriggers();
  void loadTokens();
  // 网页模式列不了 GitLab 仓库（无 CORS），打开时统一落到 GitHub；
  // 换平台那一次交给 watch(platform) 去 reset，避免同一份名单读两遍。
  const before = platform.value;
  if (!native && before === "gitlab") platform.value = "github";
  if (platform.value === before) await resetForPlatform();
}

watch(() => props.worker, (w) => {
  if (w) void loadAll();
  else {
    preview.value = null;
    pendingInput.value = null;
    pendingDelete.value = null;
    sheetErr.value = "";
  }
}, { immediate: true });

watch(platform, () => {
  mode.value = "mine";
  void resetForPlatform();
});

/* ---------- 组装输入 ---------- */
function buildInput(repo: GitRepo): WorkerBuildInput {
  return {
    provider: platform.value,
    providerAccountId: repo.accountId,
    providerAccountName: repo.accountName,
    repoId: repo.id,
    repoName: repo.fullName,
    branchIncludes: branchIncludes.value,
    branchExcludes: branchExcludes.value,
    buildCommand: buildCommand.value,
    deployCommand: deployCommand.value,
    rootDirectory: rootDirectory.value,
    buildTokenUuid: buildTokenUuid.value,
    triggerName: triggerName.value || repo.fullName,
    buildCachingEnabled: caching.value,
  };
}

async function askConnect() {
  if (!props.worker) return;
  formErr.value = "";
  note.value = "";
  try {
    let repo: GitRepo | null = null;
    if (mode.value === "manual") {
      const o = manualOwner.value.trim();
      const rn = manualRepo.value.trim();
      if (!o || !rn) throw new GwError("badQuery", 422, null, "手填模式要先写 owner 和 repo");
      const t = savedToken.value;
      if (!t) throw new GwError("auth", 401, null, `手填要靠令牌查数字 id：先保存 ${who.value} 令牌`);
      resolveBusy.value = true;
      repo = await resolveGitRepo(platform.value, t, o, rn);
    } else {
      repo = selectedRepo.value;
      if (!repo) throw new GwError("badQuery", 422, null, "先在列表里选一个仓库，或切到手填 owner/repo");
    }
    if (!repo.id || !repo.accountId) {
      throw new GwError("unknown", 0, null, `${PLATFORM_LABEL[platform.value]} 没给仓库/拥有者的数字 id，连不了 Builds；改用手填（会重新查一次）。`);
    }
    const input = buildInput(repo);
    pendingInput.value = input;
    pendingDelete.value = null;
    preview.value = previewWorkerBuild(props.worker, input);
  } catch (e) {
    formErr.value = errText(e);
  } finally {
    resolveBusy.value = false;
  }
}

async function askDelete(t: WorkerBuildTrigger) {
  if (!props.worker) return;
  if (!optIn.value) {
    formErr.value = "先打开本机写开关：断开触发器会真的发出删除请求。";
    return;
  }
  formErr.value = "";
  pendingDelete.value = t;
  pendingInput.value = null;
  preview.value = previewWorkerBuildDelete(props.worker, t);
}

async function confirmWrite() {
  const w = props.worker;
  if (!w || !preview.value || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    if (pendingDelete.value) {
      const t = pendingDelete.value;
      const id = String(t.trigger_uuid ?? "");
      await api.workerBuildDelete(id);
      const old = getWorkerRepo(props.account, w);
      if (old && (!old.triggerId || old.triggerId === id)) removeWorkerRepo(props.account, w);
      note.value = `已断开触发器 ${String(t.trigger_name ?? id)}：之后推送不再触发构建，已部署的版本保留。`;
    } else if (pendingInput.value) {
      const input = pendingInput.value;
      const res = await api.workerBuildConnect(w, input);
      const full = input.repoName;
      saveWorkerRepo(props.account, w, {
        platform: input.provider,
        owner: full.slice(0, full.lastIndexOf("/")),
        repo: full.slice(full.lastIndexOf("/") + 1),
        branch: branchIncludes.value.trim(),
        connected: true,
        triggerId: String((res as any)?.trigger_uuid ?? ""),
      });
      note.value = input.branchIncludes.trim()
        ? `已建立构建触发器：推送到 ${input.branchIncludes.trim()} 会触发 ${w} 的构建与部署。`
        : `已建立构建触发器：该仓库任何分支推送都会触发 ${w} 的构建与部署。`;
    } else {
      return;
    }
    preview.value = null;
    pendingInput.value = null;
    pendingDelete.value = null;
    emit("changed");
    void loadTriggers();
  } catch (e) {
    sheetErr.value = errText(e);
  } finally {
    busy.value = false;
  }
}

function cancelSheet() {
  preview.value = null;
  pendingInput.value = null;
  pendingDelete.value = null;
  sheetErr.value = "";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="worker" class="wmask" @click.self="emit('close')">
      <div class="wd" role="dialog" aria-modal="true">
        <header class="wh">
          <div>
            <h3>仓库 · 构建</h3>
            <div class="small muted">{{ worker }} · Workers Builds</div>
          </div>
          <button class="wx" type="button" @click="emit('close')">关闭</button>
        </header>

        <div class="warnbox">
          这一组端点按 Cloudflare 官方 API 规格拼成，<b>尚未在真实账号实测</b>。前提：令牌是 user-scoped，
          带 Workers Builds Configuration: Edit，且账号已在 dashboard 装过 GitHub/GitLab App（OAuth 授权只能后台做一次）。
        </div>

        <div v-if="!native" class="warnbox">
          网页模式：GitLab 的 API 没有 CORS，列不出仓库、也查不到数字 id，所以这里只能新建 GitHub 连接；
          已有触发器的读取与断开照常可用。写请求经网关发出，需要网关开着写开关。
        </div>

        <div class="row" style="gap: 4px; align-items: center">
          <span class="small muted">本机写开关</span>
          <WriteGate v-model="optIn" variant="inline" />
        </div>

        <p class="small" style="color: var(--ok)" v-if="note">{{ note }}</p>

        <!-- 现有触发器 -->
        <section class="sec">
          <div class="sec-t">现有构建触发器</div>
          <div class="small muted" v-if="triggersLoading">读取中…</div>
          <p class="small errtext" v-if="triggersErr">{{ triggersErr }}</p>
          <div class="small muted" v-if="!triggersLoading && !triggersErr && !triggers.length">
            还没有触发器。下面的表单会先建立仓库连接，再建触发器。
          </div>
          <div class="trg" v-for="t in triggers" :key="String(t.trigger_uuid ?? t.trigger_name)">
            <div class="trg-main">
              <b class="mono">{{ String(t.trigger_name ?? t.trigger_uuid ?? "—") }}</b>
              <div class="small muted">
                <span v-if="t.repo_name" class="mono">{{ String(t.repo_name) }}</span>
                <span v-if="t.provider_type"> · {{ String(t.provider_type) }}</span>
                <span> · 分支 {{ (t.branch_includes ?? []).join(", ") || "不限" }}</span>
              </div>
              <div class="small muted mono" v-if="t.build_command">build: {{ String(t.build_command) }}</div>
              <div class="small muted mono" v-if="t.deploy_command">deploy: {{ String(t.deploy_command) }}</div>
            </div>
            <button class="ghost sm" type="button" :disabled="!optIn || busy" @click="askDelete(t)">断开</button>
          </div>
        </section>

        <!-- 平台与令牌 -->
        <div class="row" style="gap: 4px; flex-wrap: wrap">
          <button class="chip" :class="{ on: platform === 'github' }" @click="platform = 'github'">GitHub</button>
          <button
            class="chip"
            :class="{ on: platform === 'gitlab' }"
            :disabled="!native"
            :title="native ? '' : '浏览器里 GitLab API 没有 CORS，列不出仓库'"
            @click="platform = 'gitlab'"
          >GitLab</button>
        </div>

        <section class="sec">
          <div class="sec-t">{{ who }} 令牌（只存在这台设备的钥匙串，用于列仓库）</div>
          <template v-if="savedToken">
            <div class="row" style="gap: 8px; align-items: center">
              <span class="mono small">{{ maskToken(savedToken) }}</span>
              <button class="ghost sm" type="button" :disabled="tokenBusy" @click="removeToken">清除</button>
              <button class="ghost sm" type="button" :disabled="tokenBusy" @click="savedToken = null">换一把</button>
            </div>
          </template>
          <template v-else>
            <div class="row" style="gap: 6px">
              <!-- 不用 type=password：Android WebView 的安全键盘会让第三方输入法失效 -->
              <input
                v-model="tokenInput"
                class="field secinput"
                :class="{ plain: reveal }"
                style="flex: 1; min-width: 0"
                type="text"
                :placeholder="platform === 'github' ? 'ghp_… 或 github_pat_…' : 'glpat-…'"
                autocomplete="off"
                spellcheck="false"
                :disabled="tokenBusy"
              />
              <button class="ghost" type="button" :disabled="tokenBusy" @click="reveal = !reveal">{{ reveal ? "隐藏" : "显示" }}</button>
              <button class="chip" type="button" :disabled="tokenBusy || !tokenInput.trim()" @click="saveToken">
                {{ tokenBusy ? "保存中" : "保存并读取" }}
              </button>
            </div>
            <div class="small muted" style="margin-top: 6px">
              GitHub 经典令牌要 <code>repo</code>；细粒度令牌至少 Metadata: Read + Contents: Read。GitLab 要 <code>read_api</code>。
            </div>
          </template>
          <p class="small errtext" v-if="tokenErr">{{ tokenErr }}</p>
        </section>

        <!-- 仓库来源 -->
        <div class="row" style="gap: 4px">
          <button class="chip" :class="{ on: mode === 'mine' }" @click="mode = 'mine'">我的仓库</button>
          <button class="chip" :class="{ on: mode === 'manual' }" @click="mode = 'manual'">手填 owner/repo</button>
        </div>

        <section v-if="mode === 'mine'" class="sec">
          <div class="row" style="gap: 6px; margin-bottom: 6px">
            <input v-model="repoQuery" class="field" style="flex: 1; min-width: 0" placeholder="按 owner/repo 过滤" autocomplete="off" spellcheck="false" />
            <button class="ghost sm" type="button" :disabled="reposLoading || !savedToken" @click="loadRepos">{{ reposLoading ? "读取中" : "重新读取" }}</button>
          </div>
          <select
            class="field sel"
            :value="selected"
            :disabled="reposLoading || !filteredRepos.length"
            @change="pickRepo(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ reposLoading ? "读取仓库名单…" : (savedToken ? (filteredRepos.length ? "选一个仓库" : "没有可选仓库") : "先保存令牌") }}</option>
            <option v-for="r in filteredRepos" :key="r.fullName" :value="r.fullName">
              {{ r.fullName }} · {{ r.private ? "私有" : "公开" }}{{ r.defaultBranch ? " · " + r.defaultBranch : "" }}
            </option>
          </select>
          <p class="small errtext" v-if="reposErr">{{ reposErr }}</p>
        </section>

        <section v-else class="sec">
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">Owner / 命名空间</label>
              <input v-model="manualOwner" class="field" :placeholder="platform === 'gitlab' ? 'group 或 group/subgroup' : 'octocat'" autocomplete="off" spellcheck="false" />
            </div>
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">仓库名</label>
              <input v-model="manualRepo" class="field" placeholder="hello-world" autocomplete="off" spellcheck="false" />
            </div>
          </div>
          <div class="small muted" style="margin-top: 6px">
            手填会在预览前调用一次 {{ who }} 查仓库，拿到数字 id 才继续；查不到就报 404，不会瞎猜。
          </div>
        </section>

        <!-- 构建配置 -->
        <section class="sec">
          <div class="sec-t">构建配置</div>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">触发分支</label>
              <input v-model="branchIncludes" class="field" placeholder="main（留空 = 任意分支）" autocomplete="off" spellcheck="false" />
            </div>
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">排除分支</label>
              <input v-model="branchExcludes" class="field" placeholder="留空 = 不排除" autocomplete="off" spellcheck="false" />
            </div>
          </div>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">构建命令</label>
              <input v-model="buildCommand" class="field" placeholder="npm run build" autocomplete="off" spellcheck="false" />
            </div>
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">部署命令</label>
              <input v-model="deployCommand" class="field" placeholder="npx wrangler deploy" autocomplete="off" spellcheck="false" />
            </div>
          </div>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">根目录（可选）</label>
              <input v-model="rootDirectory" class="field" placeholder="仓库根（留空即可）" autocomplete="off" spellcheck="false" />
            </div>
            <div style="flex: 1; min-width: 140px">
              <label class="lbl">触发器名称（可选）</label>
              <input v-model="triggerName" class="field" placeholder="默认用 owner/repo" autocomplete="off" spellcheck="false" />
            </div>
          </div>

          <label class="lbl">Build token</label>
          <div class="small muted" v-if="tokensLoading">读取 token 列表…</div>
          <p class="small errtext" v-if="tokensErr">{{ tokensErr }}（可直接粘贴 dashboard 里的 token uuid）</p>
          <select v-if="tokens.length" v-model="buildTokenUuid" class="field sel">
            <option value="">选一个 build token</option>
            <option v-for="t in tokens" :key="t.build_token_uuid" :value="t.build_token_uuid">
              {{ t.build_token_name || t.build_token_uuid }}
            </option>
          </select>
          <input
            v-else
            v-model="buildTokenUuid"
            class="field"
            placeholder="dashboard 里的 build token uuid（32 位 hex）"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="small muted" style="margin-top: 4px">
            build token 只能在 Cloudflare dashboard 里创建；这个字段是**必填**。
          </div>

          <label class="row" style="gap: 6px; align-items: center; margin-top: 4px">
            <input v-model="caching" type="checkbox" />
            <span class="small">启用构建缓存（build caching）</span>
          </label>
        </section>

        <p class="small errtext" v-if="formErr">{{ formErr }}</p>

        <footer class="wf">
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn primary" type="button" :disabled="!canConnect" @click="askConnect">
            {{ resolveBusy ? "查仓库…" : "预览并连接" }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>

  <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmWrite" @cancel="cancelSheet" />
</template>

<style scoped>
.wmask { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: flex-end; justify-content: center; z-index: 55; }
.wd {
  width: 100%; max-width: 640px; max-height: 92vh; overflow: auto;
  background: var(--bg-elev, #fff); color: var(--fg, #111);
  border-radius: 14px 14px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 10px;
}
.wh { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.wh h3 { margin: 0; font-size: 16px; }
.wx { background: none; border: 0; color: var(--fg-dim, #3d3d3d); font-size: 14px; padding: 6px 8px; }
.warnbox { font-size: 12.5px; line-height: 1.6; padding: 9px 10px; border-radius: 9px; color: var(--warn, #8a6100); background: rgb(var(--warn-rgb, 138 97 0) / .09); border: 1px solid var(--line); }
.sec { display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
.sec-t { font-size: 12.5px; font-weight: 650; color: var(--fg-2, #3d3d3d); }
.trg { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; padding: 7px 0; border-top: 1px solid var(--line); }
.trg:first-of-type { border-top: 0; }
.trg-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wf { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 2px; }
.btn { padding: 10px 16px; border-radius: 12px; font-size: 14px; border: none; cursor: pointer; }
.btn.ghost { background: var(--panel); color: var(--fg-dim, #3d3d3d); box-shadow: inset 4px 4px 7px var(--neu-dark), inset -4px -4px 7px var(--panel), 0 0 0 1px var(--line); }
.btn.primary { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); color: var(--on-accent); font-weight: 600; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.errtext { color: var(--bad, #c0392b); }
.secinput { -webkit-text-security: disc; }
.secinput.plain { -webkit-text-security: none; }
</style>
