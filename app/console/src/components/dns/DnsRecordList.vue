<script lang="ts">
/**
 * DNS 记录列表（docs/13 §5.3 的行字段范式）。
 * 行 = 记录名 / 类型 / 内容 / TTL / 「仅 DNS」或「已代理」；**整行点击 = 编辑**（竞品是整行点编辑、无长按）。
 * 「已代理」按接口返回的 proxied 上色；能代理但当前灰云的，给一个「可代理」的暗标记，
 * 这样列表里就能看出「代理开关会不会在这条上出现」，和表单显隐规则一致。
 */
export default { name: "DnsRecordList" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import { PROXIABLE_TYPES } from "../../lib/api";
import { useFold } from "../../lib/lists";

const props = defineProps<{ records: any[] }>();
const emit = defineEmits<{ (e: "edit", r: any): void; (e: "del", r: any): void }>();

/** 长列表默认收起、可展开：条数读全局偏好（设置页那条旋钮），DNS 只是其中一处 */
const fold = useFold(() => props.records);

/** 列表里判断「这条能不能开代理」：优先读接口的 proxiable，缺字段才按类型硬判 */
function canProxy(r: any): boolean {
  if (typeof r?.proxiable === "boolean") return r.proxiable;
  return PROXIABLE_TYPES.has(String(r?.type ?? ""));
}

/**
 * 长内容默认两行收起来（DKIM/SPF 那种 TXT 一条就是六七百字符，整页被它撑满）。
 * 阈值 90 字符 ≈ 两行；点开才全文，且展开状态按记录 id 记，翻页/刷新不残留。
 */
const LONG = 90;
const openIds = ref<Record<string, boolean>>({});
const isLong = (r: any) => String(r?.content ?? "").length > LONG;
function toggle(r: any) {
  const k = String(r.id);
  openIds.value = { ...openIds.value, [k]: !openIds.value[k] };
}
</script>

<template>
  <div class="dl">
    <div v-for="r in fold.shown" :key="r.id" class="drow" @click="emit('edit', r)">
      <div class="lead">
        <div class="name">{{ r.name }}</div>
        <div class="content mono" :class="{ clamp: isLong(r) && !openIds[String(r.id)] }" :title="String(r.content)">{{ r.content }}</div>
        <button v-if="isLong(r)" type="button" class="unfold" @click.stop="toggle(r)">
          {{ openIds[String(r.id)] ? "收起" : "展开全文" }}
        </button>
        <div class="flags">
          <span class="badge">{{ r.type }}</span>
          <span class="badge">TTL {{ r.ttl === 1 ? "自动" : r.ttl + "s" }}</span>
          <span class="badge" :class="r.proxied ? 'prox' : 'dnsonly'">{{ r.proxied ? "已代理" : "仅 DNS" }}</span>
          <span v-if="r.priority !== undefined && r.priority !== null" class="badge">prio {{ r.priority }}</span>
          <span v-if="!r.proxied && canProxy(r)" class="badge dimmable" title="这条可代理，当前是灰云">可代理</span>
        </div>
      </div>
      <div class="acts">
        <button class="act" type="button" @click.stop="emit('edit', r)">编辑</button>
        <button class="act del" type="button" @click.stop="emit('del', r)">删除</button>
      </div>
    </div>
    <div v-if="!records.length" class="empty">这个站点还没有 DNS 记录。</div>
    <button v-if="fold.rest" type="button" class="fold" @click="fold.open = !fold.open">{{ fold.label }}</button>
  </div>
</template>

<style scoped>
/* 记录列表 = 连续行 + 发丝线；行本身就是编辑入口，不再每行套一只圆角卡 */
.dl { display: flex; flex-direction: column; gap: 0; border-top: 1px solid var(--line-soft); }
.drow { background: transparent; border: 0; border-bottom: 1px solid var(--line-soft); border-radius: 0;
  padding: 10px 2px; display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; cursor: pointer; }
.drow:hover { background: var(--panel-2); }
.drow:last-of-type { border-bottom: 0; }
.lead { min-width: 0; flex: 1; }
.name { font-size: var(--t-sm); font-weight: 650; word-break: break-all; }
.content { color: var(--muted); font-size: var(--t-xs); margin-top: 3px; word-break: break-all; }
.content.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.unfold { align-self: flex-start; margin-top: 4px; background: none; border: 0; padding: 2px 0; color: var(--accent); font-size: var(--t-2xs); font-family: inherit; cursor: pointer; }
.mono { font-family: var(--font-num); }
.flags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.badge.prox { color: var(--accent); border-color: rgb(var(--accent-rgb) / .45); }
.badge.dnsonly { color: var(--muted); }
.badge.dimmable { color: var(--ok); border-color: rgb(var(--ok-rgb) / .35); }
.acts { display: flex; flex-direction: column; gap: 6px; flex: none; }
/* 行内动作 = 28 高的描边小键，扁平，不再用柔光投影 */
.act {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm);
  color: var(--fg-2); height: 26px; padding: 0 9px; font-size: var(--t-2xs); cursor: pointer; font-family: inherit;
}
.act:hover { color: var(--accent); border-color: var(--accent-dim); }
.act.del { color: var(--bad); border-color: rgb(var(--bad-rgb) / .4); }
.act.del:hover { border-color: var(--bad); }
.fold {
  align-self: center; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm);
  color: var(--muted); height: 28px; padding: 0 12px; font-size: var(--t-2xs); cursor: pointer; margin: 8px 0;
}
.fold:hover { color: var(--accent); border-color: var(--accent-dim); }
</style>
