<script setup lang="ts">
/**
 * Workers 的「仓库」面板（2026-11-01）。
 *
 * 为什么只做本机记录：Workers Builds 没有可用的官方 API
 * （https://developers.cloudflare.com/api/resources/workers/subresources/builds/ 是 404），
 * 真连只能在 dashboard 里做。所以这里**不写任何"已连接"的假话**：
 * 只把 owner/repo/分支记在本机方便下次找，真连通过 dashboard 地址跳过去，
 * 界面上明写「仅记录 · 不构建」。
 */
import { ref, watch } from "vue";
import { Browser } from "@capacitor/browser";
import { isNativeApp } from "../../lib/api";
import {
  getWorkerRepo,
  removeWorkerRepo,
  saveWorkerRepo,
  workerDashboardUrl,
  type GitPlatform,
  type WorkerRepoLink,
} from "../../lib/git";

const props = defineProps<{ worker: string | null; account: string }>();
const emit = defineEmits<{ (e: "close"): void; (e: "changed"): void }>();

const platform = ref<GitPlatform>("github");
const owner = ref("");
const repo = ref("");
const branch = ref("");
const saved = ref<WorkerRepoLink | null>(null);
const note = ref("");
const err = ref("");

function load() {
  note.value = "";
  err.value = "";
  const r = props.worker ? getWorkerRepo(props.account, props.worker) : null;
  saved.value = r;
  platform.value = r?.platform ?? "github";
  owner.value = r?.owner ?? "";
  repo.value = r?.repo ?? "";
  branch.value = r?.branch ?? "";
}

watch(() => props.worker, (w) => { if (w) load(); });

function save() {
  err.value = "";
  note.value = "";
  if (!props.worker) return;
  const o = owner.value.trim();
  const r = repo.value.trim();
  const b = branch.value.trim();
  if (!o || !r) { err.value = "owner 和 repo 都要填"; return; }
  saveWorkerRepo(props.account, props.worker, { platform: platform.value, owner: o, repo: r, branch: b });
  saved.value = getWorkerRepo(props.account, props.worker);
  note.value = "已记到这台设备。它不会触发任何构建 —— 真连接请去 dashboard。";
  emit("changed");
}

function clear() {
  if (!props.worker) return;
  removeWorkerRepo(props.account, props.worker);
  saved.value = null;
  note.value = "本机记录已清除（dashboard 那侧的连接不受影响）。";
  emit("changed");
}

async function openDash() {
  if (!props.worker) return;
  const url = workerDashboardUrl(props.account, props.worker);
  // 网页模式开新标签；APK 里 window.open 会被 WebView 吞掉，用 Capacitor Browser 打开系统浏览器
  if (!isNativeApp()) { window.open(url, "_blank", "noopener"); return; }
  try { await Browser.open({ url }); }
  catch { window.open(url, "_blank", "noopener"); }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="worker" class="wmask" @click.self="emit('close')">
      <div class="wd" role="dialog" aria-modal="true">
        <header class="wh">
          <div>
            <h3>仓库</h3>
            <div class="small muted">{{ worker }} · 仅记录 · 不构建</div>
          </div>
          <button class="wx" type="button" @click="emit('close')">关闭</button>
        </header>

        <div class="wnote">
          Workers Builds 没有官方 API，这里只能把仓库信息记在本机；真正的 Git 连接请在
          Cloudflare dashboard 的 Worker 设置里做。App 不会拿这条记录去触发构建。
        </div>

        <div class="row" style="gap: 4px">
          <button class="chip" :class="{ on: platform === 'github' }" @click="platform = 'github'">GitHub</button>
          <button class="chip" :class="{ on: platform === 'gitlab' }" @click="platform = 'gitlab'">GitLab</button>
        </div>

        <label class="lbl">Owner / 命名空间</label>
        <input v-model="owner" class="field" placeholder="octocat" autocomplete="off" spellcheck="false" />

        <label class="lbl">仓库名</label>
        <input v-model="repo" class="field" placeholder="hello-world" autocomplete="off" spellcheck="false" />

        <label class="lbl">分支</label>
        <input v-model="branch" class="field" placeholder="main" autocomplete="off" spellcheck="false" />

        <p class="small errtext" v-if="err">{{ err }}</p>
        <p class="small" style="color: var(--ok)" v-if="note">{{ note }}</p>
        <p class="small muted" v-if="saved">
          本机已记：{{ saved.platform === "gitlab" ? "GitLab" : "GitHub" }}
          <b class="mono">{{ saved.owner }}/{{ saved.repo }}</b>
          <span v-if="saved.branch"> · {{ saved.branch }}</span>
        </p>

        <footer class="wf">
          <button class="btn ghost" type="button" @click="openDash">去 dashboard 连接</button>
          <button class="btn ghost" type="button" :disabled="!saved" @click="clear">清除记录</button>
          <button class="btn primary" type="button" @click="save">记到本机</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.wmask { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: flex-end; justify-content: center; z-index: 55; }
.wd {
  width: 100%; max-width: 640px; max-height: 88vh; overflow: auto;
  background: var(--bg-elev, #fff); color: var(--fg, #111);
  border-radius: 14px 14px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 8px;
}
.wh { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 2px; }
.wh h3 { margin: 0; font-size: 16px; }
.wx { background: none; border: 0; color: var(--fg-dim, #3d3d3d); font-size: 14px; padding: 6px 8px; }
.wnote { font-size: 12.5px; line-height: 1.6; padding: 9px 10px; border-radius: 9px; color: var(--fg-dim, #3d3d3d); background: var(--panel-2); border: 1px solid var(--line); }
.wf { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; }
.btn { padding: 10px 14px; border-radius: 12px; font-size: 13.5px; border: none; cursor: pointer; }
.btn.ghost { background: var(--panel); color: var(--fg-dim, #3d3d3d); box-shadow: inset 4px 4px 7px var(--neu-dark), inset -4px -4px 7px var(--panel), 0 0 0 1px var(--line); }
.btn.primary { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); color: var(--on-accent); font-weight: 600; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.errtext { color: var(--bad, #c0392b); }
</style>
