<script setup lang="ts">
/**
 * R2 那一块：骨架和 D1 / KV 完全一样（左桶 / 右对象），差别只在**两层现在都读不到**，
 * 而且原因不同，必须分开写（docs/09 §E16）：
 *   左栏（桶清单）：2026-10-11 直连 CF 实测 `GET /accounts/{a}/r2/bucket` → 404 `10015 No route matches this url`，
 *     GraphQL 的 `r2Buckets` 也是 `unknown field` —— 这个账号没开通 R2（或令牌没给 R2 读权限）。
 *   右栏（桶内对象）：就算开了通，网关也**还没有这条路由**（`/r2/bucket/{name}/objects` 没注册），
 *     所以这一栏永远是"没接"，不是"空"。
 * 开通并加权限后左栏不用改代码就出数；右栏要等那条路由。
 */
import { computed, onMounted, ref } from "vue";
import ErrorNote from "../ErrorNote.vue";
import RowCard from "../RowCard.vue";
import FoldNote from "../FoldNote.vue";
import { useFold } from "../../lib/lists";
import StoreSplit from "./StoreSplit.vue";
import { Browser } from "@capacitor/browser";
import { api, forceFreshWindow, GwError, isNativeApp, type R2Bucket } from "../../lib/api";
import { dt } from "../../lib/fmt";

const buckets = ref<{ data: R2Bucket[] | null; err: GwError | null; loading: boolean }>({
  data: null, err: null, loading: false,
});
const selected = ref("");
const pane = ref<"list" | "detail">("list");
const q = ref("");

async function load() {
  buckets.value = { ...buckets.value, loading: true, err: null };
  try {
    const r = await api.r2Buckets();
    buckets.value = { data: Array.isArray(r.result) ? r.result : [], err: null, loading: false };
  } catch (e) {
    buckets.value = {
      data: buckets.value.data, loading: false,
      err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)),
    };
  }
}
onMounted(load);
function refresh() { forceFreshWindow(); load(); }

const listState = computed(() =>
  buckets.value.loading && !buckets.value.data ? "st-pending"
  : buckets.value.err ? "st-error"
  : (buckets.value.data?.length ?? 0) ? "st-data" : "st-empty" as const);

function pick(b: R2Bucket) { selected.value = b.name; pane.value = "detail"; }
const current = computed(() => (buckets.value.data ?? []).find((b) => b.name === selected.value) ?? null);
const region = (b: R2Bucket | null): string => b?.jurisdiction || b?.location || "默认区域（自动）";
async function openDash() {
  if (!selected.value) return;
  const url = `https://dash.cloudflare.com/?to=/:account/r2/default/buckets/${encodeURIComponent(selected.value)}`;
  if (!isNativeApp()) { window.open(url, "_blank", "noopener"); return; }
  try { await Browser.open({ url }); } catch { window.open(url, "_blank", "noopener"); }
}

const shownBuckets = computed(() => {
  const arr = buckets.value.data ?? [];
  const s = q.value.trim().toLowerCase();
  return s ? arr.filter((b) => b.name.toLowerCase().includes(s)) : arr;
});
/** 左栏折叠条数读全局偏好；筛选先、折叠后 */
const bucketFold = useFold(() => shownBuckets.value);
</script>

<template>
  <StoreSplit
    list-title="R2 存储桶"
    :detail-title="selected ? `存储桶（${selected}）` : '未选择存储桶'"
    :pane="pane" :list-state="listState" detail-state="st-empty"
    v-model:search="q" search-placeholder="搜索存储桶名"
    @back="pane = 'list'"
  >
    <template #list-tools>
      <span class="small muted">
        <template v-if="buckets.data === null">{{ buckets.err ? '没取到' : '取数中' }}</template>
        <template v-else-if="q.trim()">筛出 {{ shownBuckets.length }} / {{ buckets.data.length }} 个</template>
        <template v-else>{{ buckets.data.length }} 个</template>
      </span>
      <button class="ghost" :disabled="buckets.loading" @click="refresh">{{ buckets.loading ? "加载中" : "刷新" }}</button>
    </template>

    <ErrorNote :err="buckets.err" tone="warn" />
    <template v-if="buckets.err">
      <div class="small muted" style="margin-top:2px">
        上面这行是 CF 原样传回来的。<strong>读不到 ≠ 有 0 个桶</strong>：这个账号当前没开通 R2，或令牌没带 <code>R2 Read</code>。
      </div>
      <FoldNote label="怎么让它出数">
        后台开通 R2 并给令牌加上读权限后点「刷新」就出数，这一栏代码不用改。
        第一次实测的形状是 <code>404 10015 No route matches this url</code>，GraphQL 的 <code>r2Buckets</code> 也是
        <code>unknown field</code>（docs/09 §E16），所以判"没开通"而不是"没取到"是有依据的。
      </FoldNote>
    </template>
    <div class="empty" v-else-if="buckets.loading && !buckets.data">取数中…</div>
    <div class="rows" v-else-if="bucketFold.shown.length">
      <RowCard
        v-for="b in bucketFold.shown" :key="b.name"
        :title="b.name" :meta="dt(b.creation_date, false)"
        :badges="[{ text: b.jurisdiction || b.location || '默认区域' },
                  ...(b.name === selected ? [{ text: '当前', cls: 'roll' }] : [])]"
        @open="pick(b)"
      />
    </div>
    <div v-else-if="buckets.data?.length && q.trim()" class="empty">
      筛完 {{ buckets.data.length }} 个里没有匹配的（是筛不到，不是账号里没有）。
    </div>
    <div v-else-if="!buckets.err && buckets.data" class="empty">这个账号里没有 R2 存储桶（不是没取到）</div>
    <button class="ghost sm" style="margin-top: 8px" v-if="bucketFold.rest" @click="bucketFold.open = !bucketFold.open">
      {{ bucketFold.label }}
    </button>

    <template #detail>
      <div class="card" v-if="current">
        <h3>桶信息</h3>
        <div class="kv">
          <dt>创建时间</dt><dd>{{ dt(current.creation_date, false) }}</dd>
          <dt>区域</dt><dd>{{ region(current) }}</dd>
          <dt>桶名</dt><dd class="mono">{{ current.name }}</dd>
        </div>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="primary sm" @click="openDash">在 Cloudflare 控制台打开</button>
        </div>
        <p class="small muted" style="margin-top:9px">
          桶内对象的增删查需要 R2 的 S3 Access Key（CF API Token 走不了对象列表），
          所以这里只展示桶本身；对象管理请从上方入口进控制台。
        </p>
      </div>
      <div class="empty" v-else>左边选一个桶（前提是这个账号能读到桶）。</div>
    </template>
  </StoreSplit>
</template>

<style scoped>
/* 详情栏本身就是一块面板：里面不再套第二层卡，标题走眉题；读数轨只留 pane 一条 */
.card { background: transparent; border: 0; border-radius: 0; padding: 0; margin: 0; box-shadow: none; }
.card::before { display: none; }
.card > h3 { font-size: var(--t-2xs); letter-spacing: 0; text-transform: none;
  color: var(--muted); font-weight: 600; margin: 0 0 8px; }
button.sm { height: 28px; padding: 0 10px; font-size: var(--t-2xs); }
</style>
