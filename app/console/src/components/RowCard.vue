<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";

/** 一个动作。有 why 就表示这个动作现在做不了，点了要把原因说出来（不能只灰着不解释） */
interface RowAction {
  /** Icon.vue 里的语义键（versions/settings/…），不再是 emoji 字符 */
  ico: string;
  label: string;
  /** 父级决定去哪：路由路径，或自定义动作名 */
  go: string;
  why?: string;
}

withDefaults(
  defineProps<{
    title: string;
    /** 灰字元信息串，用「 • 」分隔，字段缺失就整段不显示 */
    meta?: string;
    /** 徽章可以有 title：界面写中文，来源字段/CF 原名放这里，别把专有名词丢掉 */
    badges?: { text: string; cls?: string; title?: string }[];
    actions?: RowAction[];
    /** 没有下钻的行（只读清单）不画右侧箭头，免得看起来能点 */
    openable?: boolean;
  }>(),
  { meta: "", badges: () => [], actions: () => [], openable: true },
);

const emit = defineEmits<{ (e: "go", a: RowAction): void; (e: "open"): void }>();

/** 动作默认收起：一行里摆十个迷你键，等于没有入口。点「操作 N」才铺开，标签仍然是全的。 */
const actsOpen = ref(false);
const why = ref<RowAction | null>(null);

function tap(a: RowAction) {
  if (a.why) {
    why.value = why.value?.go === a.go ? null : a;
    return;
  }
  why.value = null;
  emit("go", a);
}
</script>

<template>
  <div class="lrow">
    <div class="main" @click="emit('open')">
      <div class="tcol">
        <div class="title">{{ title }}</div>
        <div class="meta" v-if="meta">{{ meta }}</div>
      </div>
      <div class="right">
        <span v-for="b in badges" :key="b.text" class="badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
        <Icon v-if="openable" class="row-chev" name="chevron" :size="12" />
      </div>
    </div>
    <button
      v-if="actions.length"
      class="acts-toggle"
      :aria-expanded="actsOpen"
      @click.stop="actsOpen = !actsOpen"
    >
      操作 {{ actions.length }}
      <Icon class="chev" name="chevron" :size="10" :class="{ up: actsOpen }" />
    </button>
    <div class="acts" v-if="actsOpen && actions.length">
      <button v-for="a in actions" :key="a.go" class="act" :class="{ off: a.why }" @click.stop="tap(a)">
        <Icon class="ai" :name="a.ico" />
        <span>{{ a.label }}</span>
      </button>
    </div>
    <div class="whyline" v-if="why">{{ why.why }}</div>
  </div>
</template>
