<script setup lang="ts">
/**
 * 「把已有 Pages 项目连接到已有 Git 仓库」的对话框（2026-11-01）。
 *
 * 为什么是这个形状：
 *  - 仓库来源默认「我的仓库」：令牌存在本机钥匙串，App 直接打 GitHub / GitLab 列仓库；
 *  - 手填 owner/repo 是兜底：令牌权限不够、或仓库是别人的（协作者）时仍能连；
 *  - 最终写的是 PATCH Pages 项目对象（source + build_config + production_branch），
 *    与仪表盘同一个动作，不是"新建项目"，也不会碰仓库里的代码。
 *
 * 这条写路由只给 APK 直连：网页模式会把整张表单灰掉并写明原因（CORS + 网关未放行），
 * 绝不出现"看起来点了、其实没发出去"。
 */
import { computed, ref, watch } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import WriteGate from "../WriteGate.vue";
import {
  GwError,
  isNativeApp,
  pageConnectGit,
  previewPageGit,
  writesOptIn,
  type PageGitInput,
  type WritePreview,
} from "../../lib/api";
import {
  clearGitToken,
  getGitToken,
  listGitRepos,
  maskToken,
  PLATFORM_LABEL,
  setGitToken,
  type GitPlatform,
  type GitRepo,
} from "../../lib/git";

const props = defineProps<{
  /** 要连接的项目名；null = 对话框关闭 */
  project: string | null;
  /** 项目现在已连的仓库（详情接口给了 source 才有），用于提醒"再提交是覆盖" */
  existing?: { platform: GitPlatform; owner: string; repo: string; branch: string } | null;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "connected", v: { owner: string; repo: string; branch: string }): void;
}>();

const native = isNativeApp();
const optIn = ref(writesOptIn());

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
const branch = ref("");

/** 我的仓库 / 手填 owner-repo：默认前者，手填是高级兜底 */
const mode = ref<"mine" | "manual">("mine");
const manualOwner = ref("");
const manualRepo = ref("");
const manualBranch = ref("");

const buildCommand = ref("");
const destDir = ref("");
const rootDir = ref("");

const formErr = ref("");
const busy = ref(false);
const preview = ref<WritePreview | null>(null);
const sheetErr = ref("");

const who = computed(() => PLATFORM_LABEL[platform.value]);
const filteredRepos = computed(() => {
  const q = repoQuery.value.trim().toLowerCase();
  return q ? repos.value.filter((r) => r.fullName.toLowerCase().includes(q)) : repos.value;
});
const selectedRepo = computed(() => repos.value.find((r) => r.fullName === selected.value) ?? null);

function errText(e: unknown): string {
  return e instanceof GwError ? e.message : String((e as Error)?.message || e);
}

/** 换平台 / 打开对话框时都重来一遍：令牌和仓库名单都属于"那个平台"，不能串用 */
async function resetForPlatform() {
  repos.value = [];
  repoQuery.value = "";
  selected.value = "";
  branch.value = "";
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
    if (!repos.value.length) reposErr.value = `这把令牌看得见的 ${who.value} 仓库是空的（不是接口失败：返回了 0 条）。`;
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
  branch.value = "";
}

function pickRepo(full: string) {
  selected.value = full;
  const r = repos.value.find((x) => x.fullName === full);
  branch.value = r?.defaultBranch || "";
}

watch(platform, () => { mode.value = "mine"; void resetForPlatform(); });

/** 打开对话框时只重置一次；关闭后再打开要拿到最新的令牌状态 */
watch(
  () => props.project,
  (p) => {
    if (!p) return;
    formErr.value = "";
    preview.value = null;
    sheetErr.value = "";
    busy.value = false;
    buildCommand.value = "";
    destDir.value = "";
    rootDir.value = "";
    manualOwner.value = "";
    manualRepo.value = "";
    manualBranch.value = "";
    mode.value = "mine";
    const want: GitPlatform = props.existing?.platform === "gitlab" ? "gitlab" : "github";
    // 换平台时交给 watch(platform) 去 reset（它会重新读那一把令牌），避免同一份名单读两遍
    if (want !== platform.value) platform.value = want;
    else void resetForPlatform();
  },
);

/** 表单 → 真正要发的输入。手填模式下 owner/repo 就是用户写的，不做任何"猜" */
function currentInput(): PageGitInput {
  const manual = mode.value === "manual";
  const r = selectedRepo.value;
  return {
    platform: platform.value,
    owner: manual ? manualOwner.value.trim() : r?.owner ?? "",
    repo: manual ? manualRepo.value.trim() : r?.name ?? "",
    productionBranch: (manual ? manualBranch.value : branch.value).trim(),
    buildCommand: buildCommand.value,
    destinationDir: destDir.value,
    rootDir: rootDir.value,
  };
}

function askConnect() {
  formErr.value = "";
  if (!props.project) return;
  const input = currentInput();
  if (!input.owner || !input.repo) {
    formErr.value = mode.value === "manual" ? "手填模式要先写 owner 和 repo" : "先在列表里选一个仓库，或切到手填";
    return;
  }
  if (!input.productionBranch) {
    formErr.value = "生产分支不能为空（选好仓库后会自动填默认分支，没有就手填）";
    return;
  }
  try {
    preview.value = previewPageGit(props.project, input);
  } catch (e) {
    formErr.value = errText(e);
  }
}

async function confirmConnect() {
  if (!props.project || !preview.value || busy.value) return;
  const input = currentInput();
  busy.value = true;
  sheetErr.value = "";
  try {
    await pageConnectGit(props.project, input);
    preview.value = null;
    emit("connected", { owner: input.owner, repo: input.repo, branch: input.productionBranch });
    emit("close");
  } catch (e) {
    sheetErr.value = errText(e);
  } finally {
    busy.value = false;
  }
}

function cancelSheet() {
  preview.value = null;
  sheetErr.value = "";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="project" class="gitmask" @click.self="emit('close')">
      <div class="gitdlg" role="dialog" aria-modal="true">
        <header class="ghead">
          <div>
            <h3>连接 Git 仓库</h3>
            <div class="small muted">{{ project }}</div>
          </div>
          <button class="gx" type="button" @click="emit('close')">关闭</button>
        </header>

        <div v-if="!native" class="gapexp">
          网页模式不能连接仓库：GitHub / GitLab 的 API 和 Cloudflare 的写接口都没有 CORS，
          这条写路由也没进网关白名单（这一版刻意不放行，避免 Git 令牌经过中间服务器）。
          请在 Android App（APK 直连模式）里操作。
        </div>

        <div v-if="existing" class="gawarn">
          这个项目现在连的是 {{ PLATFORM_LABEL[existing.platform] }} 仓库
          <b class="mono">{{ existing.owner }}/{{ existing.repo }}</b>
          · 分支 <b class="mono">{{ existing.branch }}</b>。再提交会把来源改成下面的仓库（旧部署记录仍在）。
        </div>

        <div class="row gtop">
          <span class="small muted">本机写开关</span>
          <WriteGate v-model="optIn" variant="inline" />
        </div>

        <!-- 平台 -->
        <div class="row gchips">
          <button class="chip" :class="{ on: platform === 'github' }" :disabled="!native" @click="platform = 'github'">GitHub</button>
          <button class="chip" :class="{ on: platform === 'gitlab' }" :disabled="!native" @click="platform = 'gitlab'">GitLab</button>
        </div>

        <!-- 令牌 -->
        <section class="gsec">
          <div class="gsec-t">{{ who }} 令牌（只存在这台手机的钥匙串）</div>
          <template v-if="savedToken">
            <div class="row" style="gap: 8px; align-items: center">
              <span class="mono small">{{ maskToken(savedToken) }}</span>
              <button class="ghost sm" type="button" :disabled="!native || tokenBusy" @click="removeToken">清除</button>
              <button class="ghost sm" type="button" :disabled="!native || tokenBusy" @click="savedToken = null">换一把</button>
            </div>
          </template>
          <template v-else>
            <div class="row" style="gap: 6px">
              <!-- 不用 type=password：Android WebView 会唤起安全键盘，第三方输入法直接失效（设置页同一课） -->
              <input
                v-model="tokenInput"
                class="field sec"
                :class="{ plain: reveal }"
                style="flex: 1; min-width: 0"
                type="text"
                :placeholder="platform === 'github' ? 'ghp_… 或 github_pat_…' : 'glpat-…'"
                autocomplete="off"
                spellcheck="false"
                :disabled="!native || tokenBusy"
              />
              <button class="ghost" type="button" :disabled="!native || tokenBusy" @click="reveal = !reveal">{{ reveal ? "隐藏" : "显示" }}</button>
              <button class="chip" type="button" :disabled="!native || tokenBusy || !tokenInput.trim()" @click="saveToken">
                {{ tokenBusy ? "保存中" : "保存并读取" }}
              </button>
            </div>
            <div class="small muted" style="margin-top: 6px">
              GitHub 经典令牌要 <code>repo</code>；细粒度令牌至少给 Metadata: Read + Contents: Read。
              GitLab 令牌要 <code>read_api</code>。令牌不写日志、不进仓库，只用于列仓库。
            </div>
          </template>
          <p class="small errtext" v-if="tokenErr">{{ tokenErr }}</p>
        </section>

        <!-- 仓库来源 -->
        <div class="row gchips">
          <button class="chip" :class="{ on: mode === 'mine' }" :disabled="!native" @click="mode = 'mine'">我的仓库</button>
          <button class="chip" :class="{ on: mode === 'manual' }" :disabled="!native" @click="mode = 'manual'">手填 owner/repo（高级）</button>
        </div>

        <section v-if="mode === 'mine'" class="gsec">
          <div class="row" style="gap: 6px; margin-bottom: 6px">
            <input v-model="repoQuery" class="field" style="flex: 1; min-width: 0" placeholder="按 owner/repo 过滤" autocomplete="off" spellcheck="false" :disabled="!native" />
            <button class="ghost sm" type="button" :disabled="!native || reposLoading || !savedToken" @click="loadRepos">{{ reposLoading ? "读取中" : "重新读取" }}</button>
          </div>
          <select
            class="field sel"
            :value="selected"
            :disabled="!native || reposLoading || !filteredRepos.length"
            @change="pickRepo(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ reposLoading ? "读取仓库名单…" : (savedToken ? (filteredRepos.length ? "选一个仓库" : "没有可选仓库") : "先保存令牌") }}</option>
            <option v-for="r in filteredRepos" :key="r.fullName" :value="r.fullName">
              {{ r.fullName }} · {{ r.private ? "私有" : "公开" }}{{ r.defaultBranch ? " · " + r.defaultBranch : "" }}
            </option>
          </select>
          <div class="small muted" style="margin-top: 6px">
            最多列出最近更新的 100 个仓库。看不到想要的，切「手填」直接写 owner/repo。
          </div>
          <p class="small errtext" v-if="reposErr">{{ reposErr }}</p>
        </section>

        <section v-else class="gsec">
          <div class="row gform">
            <div class="gf">
              <label class="lbl">Owner / 命名空间</label>
              <input v-model="manualOwner" class="field" :placeholder="platform === 'gitlab' ? 'group 或 group/subgroup' : 'octocat'" autocomplete="off" spellcheck="false" :disabled="!native" />
            </div>
            <div class="gf">
              <label class="lbl">仓库名</label>
              <input v-model="manualRepo" class="field" placeholder="hello-world" autocomplete="off" spellcheck="false" :disabled="!native" />
            </div>
          </div>
          <label class="lbl">生产分支</label>
          <input v-model="manualBranch" class="field" placeholder="main" autocomplete="off" spellcheck="false" :disabled="!native" />
          <div class="small muted" style="margin-top: 6px">
            手填不会去读仓库：分支写错上游会 400，原样上屏。GitLab 子组写成 <code>group/subgroup</code>。
          </div>
        </section>

        <!-- 分支（选仓库模式） -->
        <template v-if="mode === 'mine'">
          <label class="lbl">生产分支</label>
          <input v-model="branch" class="field" placeholder="选仓库后自动填默认分支，可改" autocomplete="off" spellcheck="false" :disabled="!native" />
        </template>

        <!-- 构建配置 -->
        <section class="gsec">
          <div class="gsec-t">构建配置（留空 = 沿用项目现有配置）</div>
          <div class="row gform">
            <div class="gf">
              <label class="lbl">构建命令</label>
              <input v-model="buildCommand" class="field" placeholder="npm run build" autocomplete="off" spellcheck="false" :disabled="!native" />
            </div>
            <div class="gf">
              <label class="lbl">输出目录</label>
              <input v-model="destDir" class="field" placeholder="dist" autocomplete="off" spellcheck="false" :disabled="!native" />
            </div>
            <div class="gf">
              <label class="lbl">根目录</label>
              <input v-model="rootDir" class="field" placeholder="仓库根（留空即可）" autocomplete="off" spellcheck="false" :disabled="!native" />
            </div>
          </div>
        </section>

        <div class="small muted gnote">
          前提：这个 Cloudflare 账号要已在 dashboard 里装过 {{ who }} 集成（OAuth 授权只能由管理员在网页后台做一次，API 做不到）。
          这是「项目连接已有仓库」，不会新建项目、不会动仓库里的代码。
        </div>

        <p class="small errtext" v-if="formErr">{{ formErr }}</p>

        <footer class="gfoot">
          <button class="btn ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn primary" type="button" :disabled="!native || !optIn || busy" @click="askConnect">预览并确认</button>
        </footer>
      </div>
    </div>
  </Teleport>

  <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmConnect" @cancel="cancelSheet" />
</template>

<style scoped>
.gitmask { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: flex-end; justify-content: center; z-index: 55; }
.gitdlg {
  width: 100%; max-width: 640px; max-height: 92vh; overflow: auto;
  background: var(--bg-elev, #fff); color: var(--fg, #111);
  border-radius: 14px 14px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 10px;
}
.ghead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ghead h3 { margin: 0; font-size: 16px; }
.gx { background: none; border: 0; color: var(--fg-dim, #3d3d3d); font-size: 14px; padding: 6px 8px; }
.gapexp, .gawarn { margin: 0; font-size: 12.5px; line-height: 1.6; padding: 9px 10px; border-radius: 9px; }
.gapexp { color: var(--warn, #8a6100); background: rgb(var(--warn-rgb, 138 97 0) / .09); border: 1px solid var(--line); }
.gawarn { color: var(--fg-dim, #3d3d3d); background: var(--panel-2); border: 1px solid var(--line); }
.gtop { justify-content: space-between; align-items: center; }
.gchips { gap: 4px; flex-wrap: wrap; }
.gsec { display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
.gsec-t { font-size: 12.5px; font-weight: 650; color: var(--fg-2, #3d3d3d); }
.gform { flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.gf { flex: 1; min-width: 140px; }
.gf .lbl { margin: 0 0 4px; }
.gnote { line-height: 1.6; }
.gfoot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }
.btn { padding: 10px 16px; border-radius: 12px; font-size: 14px; border: none; cursor: pointer; }
.btn.ghost { background: var(--panel); color: var(--fg-dim, #3d3d3d); box-shadow: inset 4px 4px 7px var(--neu-dark), inset -4px -4px 7px var(--panel), 0 0 0 1px var(--line); }
.btn.primary { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); color: var(--on-accent); font-weight: 600; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.errtext { color: var(--bad, #c0392b); }
.sec { -webkit-text-security: disc; }
.sec.plain { -webkit-text-security: none; }
</style>
