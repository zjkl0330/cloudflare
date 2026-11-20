<script setup lang="ts">
/**
 * KV 那一块：左栏命名空间，右栏它的 Key（和 D1 用同一个 StoreSplit 骨架，两段的位置一致）。
 *
 * 竞品每行都写着一个总数，这里**故意不写**：CF 的命名空间列表接口不返回 key 数量，
 * 只有 `…/keys?limit=100` 回来才知道这一页有几条，而且它带 cursor、不给总数。
 * 所以右栏说的是「本页 N 条 · 还有下一页」，不是「N 个 Key」（docs/09 §E16 那条口径）。
 */
import { computed, onMounted, ref, watch } from "vue";
import AsyncBlock from "../board/AsyncBlock.vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import ErrorNote from "../ErrorNote.vue";
import RowCard from "../RowCard.vue";
import FoldNote from "../FoldNote.vue";
import { useFold } from "../../lib/lists";
import StoreSplit from "./StoreSplit.vue";
import WriteGate from "../WriteGate.vue";
import { api, dropMem, forceFreshWindow, GwError, writesOptIn, type KvNamespace, type KvKeysResult, type WritePreview } from "../../lib/api";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const nss = ref<Slot<KvNamespace[]>>(mk());
const selectedId = ref("");
/** 两个筛选词都只动界面上的数组，不碰取数：命名空间这条接口本来就不接受关键字 */
const q = ref("");
const kq = ref("");
const pane = ref<"list" | "detail">("list");
const keys = ref<Slot<KvKeysResult>>(mk());
/** 翻页是"接着这一页往下"，所以只记游标，不清掉已渲染的列表 */
const paged = ref<{ cursor?: string; all: any[] }>({ all: [] });
const hasMore = ref(false);
const copied = ref("");
/** 展开某个 Key 的值（只能读文本；二进制会在界面上如实说明） */
const openKey = ref("");
const openVal = ref<Slot<string>>(mk());

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try { slot.value = { data: await fn(), err: null, loading: false }; }
  catch (e) { slot.value = { data: slot.value.data, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) }; }
}

async function loadNss() {
  await grab(nss, () => api.kvNamespaces().then((r) => Array.isArray(r.result) ? r.result : []));
  if (!selectedId.value && nss.value.data?.length) selectedId.value = nss.value.data[0].id;
}

async function loadKeys(append = false) {
  if (!selectedId.value) return;
  if (!append) { keys.value = { data: null, err: null, loading: true }; paged.value = { all: [] }; }
  else { keys.value = { ...keys.value, loading: true }; }
  try {
    const r = await api.kvKeys(selectedId.value, 100, append ? paged.value.cursor : undefined);
    paged.value = { cursor: r.cursor, all: append ? [...paged.value.all, ...(r.result ?? [])] : (r.result ?? []) };
    keys.value = { data: r, err: null, loading: false };
    hasMore.value = !!r.cursor;
  } catch (e) {
    keys.value = { data: append ? keys.value.data : null, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
  }
}

async function loadMore() {
  if (!selectedId.value || !hasMore.value || keys.value.loading) return;
  await loadKeys(true);
}

onMounted(loadNss);
/** 切命名空间 = 右栏整个换血，绝不留着上一个 ns 的 key 列表（竞品截图就串过这个号） */
watch(selectedId, () => {
  keys.value = mk(); paged.value = { all: [] }; hasMore.value = false; openKey.value = ""; openVal.value = mk(); loadKeys();
});

async function readKey(name: string) {
  if (!selectedId.value) return;
  if (openKey.value === name) { openKey.value = ""; return; }
  openKey.value = name;
  await grab(openVal, () => api.kvValue(selectedId.value, name));
}

function pick(ns: KvNamespace) { selectedId.value = ns.id; pane.value = "detail"; }
function refresh() { forceFreshWindow(); loadNss(); if (selectedId.value) loadKeys(); }

const selectedNs = computed(() => (nss.value.data ?? []).find((n) => n.id === selectedId.value));
const shownNs = computed(() => {
  const arr = nss.value.data ?? [];
  const s = q.value.trim().toLowerCase();
  return s ? arr.filter((n) => `${n.title} ${n.id}`.toLowerCase().includes(s)) : arr;
});
const rows = computed(() => paged.value.all);
/** Key 这条只能筛"已经取回来的这几页"：CF 的 keys 接口按 cursor 往下翻页，不支持关键字查询 */
const shownKeys = computed(() => {
  const s = kq.value.trim().toLowerCase();
  return s ? rows.value.filter((k: any) => String(k.name).toLowerCase().includes(s)) : rows.value;
});
/** 两条列表的折叠条数都读全局偏好（设置页那条旋钮），筛选先、折叠后 */
const nsFold = useFold(() => shownNs.value);
const keyFold = useFold(() => shownKeys.value);
const listState = computed(() =>
  nss.value.loading && !nss.value.data ? "st-pending"
  : nss.value.err ? "st-error"
  : (nss.value.data?.length ?? 0) ? "st-data" : "st-empty" as const);
const detailState = computed(() =>
  !selectedId.value ? "st-empty"
  : keys.value.loading && !keys.value.data ? "st-pending"
  : keys.value.err ? "st-error"
  : rows.value.length ? "st-data" : "st-empty" as const);

async function copyContent(text: string) {
  try { await navigator.clipboard.writeText(text); copied.value = "已复制 " + text.slice(0, 30); }
  catch { copied.value = "剪贴板被拒绝"; }
  setTimeout(() => { copied.value = ""; }, 2000);
}

/* ---------- 写侧：写键值 / 删键（2026-10-20 实测：上游 PUT values/{key} 要裸文本 body，
 * 两层把客户端 {value} 转成裸文本；DELETE 200、删后 GET 404。归写闸门/本机写开关管） ---------- */
/** 写开关状态只留给写按钮的 disabled 判断；读写与文案在 WriteGate 里 */
const optIn = ref(writesOptIn());

const showWrite = ref(false);
const wKey = ref("");
const wVal = ref("");
const writing = ref(false);
const wErr = ref<GwError | null>(null);
const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");

function askWrite() {
  if (!selectedId.value || writing.value) return;
  wErr.value = null;
  const key = wKey.value.trim();
  if (!key) { wErr.value = new GwError("badQuery", 422, null, "key 不能为空"); return; }
  if (new TextEncoder().encode(key).length > 512) { wErr.value = new GwError("badQuery", 422, null, "key 超过 512 字节（CF 硬上限）"); return; }
  if (!wVal.value) { wErr.value = new GwError("badQuery", 422, null, "value 不能为空（要清掉这个键请用删除）"); return; }
  if (new TextEncoder().encode(wVal.value).length > 65536) { wErr.value = new GwError("badQuery", 422, null, "value 超过 64KB（这条通道的上限）"); return; }
  sheetErr.value = "";
  const kEnc = encodeURIComponent(key);
  preview.value = {
    method: "PUT",
    path: `/v1/kv/${selectedId.value}/values/${kEnc}`,
    // 值确实要发出去，ConfirmSheet 原样显示完整 value
    body: { value: wVal.value },
    title: `写入 Key「${key}」`,
    lines: [
      { k: "命名空间", v: selectedNs.value?.title ?? selectedId.value },
      { k: "Key", v: key },
      { k: "Value", v: wVal.value.length > 200 ? wVal.value.slice(0, 200) + `…（共 ${wVal.value.length} 字符，完整值见下方请求体）` : wVal.value },
      { k: "语义", v: "同名 Key 直接覆盖，没有类型/过期时间（这条通道只存文本；要 TTL 请用 wrangler）" },
      { k: "路由状态", v: "上游形状 2026-10-20 实测（临时命名空间自清理）：PUT values/{key} 上游要裸文本 body，两层做转换；写后 GET 读回逐字节一致" },
    ],
    danger: "normal",
  };
}

async function confirmWrite() {
  const key = wKey.value.trim();
  if (!selectedId.value || !key || !wVal.value || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    await api.kvPutValue(selectedId.value, key, wVal.value);
    dropMem("/v1/kv/" + selectedId.value);
    await loadKeys();
    showWrite.value = false;
    wKey.value = "";
    wVal.value = "";
    preview.value = null;
  } catch (e) {
    sheetErr.value = `${e instanceof GwError ? e.message : String(e)}${e instanceof GwError && e.hint ? "\n" + e.hint : ""}`;
  } finally {
    busy.value = false;
  }
}

function askDeleteKey(k: any) {
  const key = String(k?.name ?? "");
  if (!selectedId.value || !key) return;
  sheetErr.value = "";
  preview.value = {
    method: "DELETE",
    path: `/v1/kv/${selectedId.value}/values/${encodeURIComponent(key)}`,
    body: undefined,
    title: `删除 Key「${key}」`,
    lines: [
      { k: "命名空间", v: selectedNs.value?.title ?? selectedId.value },
      { k: "要删除的 Key", v: key },
      { k: "后果", v: "删除不可恢复：读到这个 Key 的 Worker 会拿不到值（get 返回 null），可能引发运行时错误" },
      { k: "路由状态", v: "上游形状 2026-10-20 实测：DELETE values/{key} → 200，删后 GET 404" },
    ],
    danger: "irreversible",
  };
  pendingDelete.value = key;
}
const pendingDelete = ref("");

async function confirmDeleteKey() {
  const key = pendingDelete.value;
  if (!selectedId.value || !key || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    await api.kvDeleteKey(selectedId.value, key);
    dropMem("/v1/kv/" + selectedId.value);
    await loadKeys();
    preview.value = null;
  } catch (e) {
    sheetErr.value = `${e instanceof GwError ? e.message : String(e)}${e instanceof GwError && e.hint ? "\n" + e.hint : ""}`;
  } finally {
    busy.value = false;
  }
}

function cancelSheet() { preview.value = null; sheetErr.value = ""; }
</script>

<template>
  <StoreSplit
    list-title="KV 命名空间"
    :detail-title="selectedNs ? `Key（${selectedNs.title}）· 本页 ${rows.length} 条` : '未选择命名空间'"
    :pane="pane" :list-state="listState" :detail-state="detailState"
    v-model:search="q" search-placeholder="搜索命名空间名或 ID"
    @back="pane = 'list'"
  >
    <template #list-tools>
      <span class="small muted">
        <template v-if="nss.err">没取到</template>
        <template v-else-if="!nss.data">取数中</template>
        <template v-else-if="q.trim()">筛出 {{ shownNs.length }} / {{ nss.data.length }} 个</template>
        <template v-else>{{ nss.data.length }} 个</template>
      </span>
      <button class="ghost" :disabled="nss.loading" @click="refresh">{{ nss.loading ? "加载中" : "刷新" }}</button>
    </template>

    <ErrorNote :err="nss.err" />
    <div class="empty" v-if="nss.loading && !nss.data?.length">取数中…</div>
    <div class="rows" v-if="nsFold.shown.length">
      <RowCard
        v-for="ns in nsFold.shown" :key="ns.id"
        :title="ns.title" :meta="ns.id.slice(0, 8) + '…'"
        :badges="[{ text: ns.supports_url_encoding ? 'URL编码' : '—' },
                  ...(ns.id === selectedId ? [{ text: '当前', cls: 'roll' }] : [])]"
        @open="pick(ns)"
      />
    </div>
    <div v-else-if="nss.data?.length && q.trim()" class="empty">
      筛完 {{ nss.data.length }} 个里没有匹配的（是筛不到，不是账号里没有）。清空搜索词就全回来了。
    </div>
    <div v-else-if="!nss.loading && !nss.err" class="empty">这个账号里没有 KV 命名空间（不是没取到）</div>
    <button class="ghost sm" style="margin-top: 8px" v-if="nsFold.rest" @click="nsFold.open = !nsFold.open">
      {{ nsFold.label }}
    </button>

    <template #detail>
      <div v-if="!selectedId" class="empty">左边选一个命名空间，这里就出它的 Key。</div>
      <div v-else class="card">
        <div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:8px">
          <WriteGate v-model="optIn" variant="inline" />
          <button class="ghost sm" @click="showWrite = !showWrite">{{ showWrite ? "收起" : "写入键值" }}</button>
          <button class="ghost sm" :disabled="keys.loading || !hasMore" @click="loadMore">
            {{ keys.loading ? "加载中" : hasMore ? "加载下一页" : "到底了" }}
          </button>
        </div>
        <div v-if="showWrite" class="card wbox">
          <div class="row" style="gap:6px;align-items:center;margin-bottom:6px">
            <input v-model="wKey" class="field mono" placeholder="Key（≤512 字节）" style="flex:1;min-width:0" />
          </div>
          <textarea v-model="wVal" class="field mono" rows="4" placeholder="Value（文本，≤64KB）"></textarea>
          <div class="row" style="gap:6px;margin-top:6px">
            <button class="primary" :disabled="!wKey.trim() || !wVal" @click="askWrite">生成请求预览</button>
            <ErrorNote v-if="wErr" :err="wErr" style="flex:1" />
          </div>
        </div>
        <div class="kfind">
          <input v-model="kq" type="search" class="field" placeholder="搜索 Key 名" />
          <span class="small muted" v-if="kq.trim()">筛出 {{ shownKeys.length }} / 已加载 {{ rows.length }} 条</span>
          <button class="ghost sm" v-if="kq" @click="kq = ''">清空</button>
        </div>
        <div v-if="openKey" class="valbox">
          <div class="val-h">
            <span class="mono ell">{{ openKey }}</span>
            <button class="ghost xs" v-if="openVal.data !== null" @click="copyContent(String(openVal.data))">复制值</button>
            <button class="ghost xs" @click="openKey = ''">收起</button>
          </div>
          <div class="small muted" v-if="openVal.loading">读取中…</div>
          <ErrorNote v-else-if="openVal.err" :err="openVal.err" />
          <pre v-else>{{ openVal.data }}</pre>
        </div>
        <AsyncBlock :loading="keys.loading && !keys.data" :err="keys.err" :has="rows.length > 0"
          :can-retry="!!keys.err" empty-text="这个命名空间里确实没有 Key（不是没取到）" @retry="loadKeys()">
          <div class="small muted" v-if="kq.trim() && !shownKeys.length" style="margin-bottom:4px">
            已加载的 {{ rows.length }} 条里没有匹配「{{ kq.trim() }}」的 Key（是筛不到，不是这个命名空间空）。
          </div>
          <div class="tblwrap">
            <table>
              <thead><tr><th>Key</th><th>过期时间</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="k in keyFold.shown" :key="k.name">
                  <td style="word-break:break-all;max-width:200px">{{ k.name }}</td>
                  <td style="white-space:nowrap">
                    <span v-if="k.expiration">{{ new Date(k.expiration * 1000).toLocaleString('zh-CN') }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td style="white-space:nowrap">
                    <button class="ghost xs" @click="readKey(k.name)">{{ openKey === k.name ? "收起" : "查看" }}</button>
                    <button class="ghost xs" @click="copyContent(k.name)">复制</button>
                    <button class="ghost xs danger" @click="askDeleteKey(k)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <button class="ghost sm" style="margin-top: 6px" v-if="keyFold.rest" @click="keyFold.open = !keyFold.open">
            {{ keyFold.label }}
          </button>
          <div v-if="hasMore" class="small muted" style="margin-top:4px">还有下一页（已显示 {{ rows.length }} 条，CF 不返回总数）</div>
        </AsyncBlock>
        <FoldNote label="这一栏是怎么取数的">
          走 <code>GET /accounts/{a}/storage/kv/namespaces/{id}/keys?limit=100</code>，所需权限
          <code>Workers KV Storage Read</code>。每页 100 条；CF 这个接口<strong>不给总数、也不接受关键字</strong>，
          所以上面那个框筛的是<strong>已经加载到这一屏</strong>的 Key，要往后找就点「加载下一页」。
        </FoldNote>
        <div v-if="copied" class="small" style="margin-top:6px;color:var(--ok)">{{ copied }}</div>
      </div>
    </template>
  </StoreSplit>
  <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="preview?.method === 'PUT' ? confirmWrite() : confirmDeleteKey()" @cancel="cancelSheet" />
</template>

<style scoped>
.switchline { display: flex; flex-direction: column; gap: 3px; font-size: var(--t-xs);
  padding: 8px 0; border: 0; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft);
  border-radius: 0; background: transparent; margin-bottom: 8px; }
.kfind { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.valbox { margin-bottom: 9px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--inset); overflow: hidden; }
.val-h { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--line-soft);
  background: var(--panel-2); font-size: var(--t-2xs); }
.val-h .ell { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.valbox pre { margin: 0; padding: 9px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  font-family: var(--font-num); font-size: var(--t-xs); line-height: 1.55; color: var(--fg-2); }
.valbox > .small, .valbox > .err { margin: 9px; }
.kfind input {
  max-width: 260px; padding: 7px 10px; border-radius: var(--r-sm); font-size: var(--t-xs);
  appearance: none; -webkit-appearance: none;
}
.kfind input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; display: none; }
table { width: 100%; font-size: var(--t-xs); border-collapse: collapse; }
table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
table td { padding: 6px 8px; border-bottom: 1px solid var(--line-soft); }
.tblwrap { overflow-x: auto; border: 1px solid var(--line-soft); border-radius: var(--r-sm); }
button.sm { height: 28px; padding: 0 10px; font-size: var(--t-2xs); }
button.xs { height: 24px; padding: 0 8px; font-size: var(--t-2xs); }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .4); }

/* 详情栏已是一块面板：外层 .card 只当容器用，不再套第二层卡；舞台上的读数轨只留 pane 那一条 */
.card { background: transparent; border: 0; border-radius: 0; padding: 0; margin: 0; box-shadow: none; }
.card::before { display: none; }
.card.wbox { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px; margin-top: 8px; }
.mono { font-family: var(--font-num); font-size: var(--t-xs); }
</style>
