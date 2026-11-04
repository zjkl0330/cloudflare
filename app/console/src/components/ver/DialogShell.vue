<script lang="ts">
export default { name: "VerDialogShell" };
</script>

<script setup lang="ts">
/**
 * 弹窗外壳（docs/13 §1.1 / §2.3：竞品的「版本」不是列表屏而是弹窗）。
 *
 * 只解决三件事：遮罩点击关闭、内容区自己滚动、底部动作条常驻。
 * 三态（loading / error / content）交给里面的 AsyncBlock —— 竞品做得好的那条是
 * 「先弹加载态、数据回来后原地替换」（§7.3），所以外壳不提供"空壳弹窗"的可能。
 */
import { computed, useSlots } from "vue";

const props = defineProps<{ title: string; sub?: string; wide?: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();
const slots = useSlots();
const hasFoot = computed(() => !!slots.foot);
</script>

<template>
  <Teleport to="body">
    <div class="ds-mask" @click.self="emit('close')">
      <div class="ds" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="ds-head">
          <div class="ds-t">
            <h3>{{ title }}</h3>
            <p v-if="sub" class="ds-sub">{{ sub }}</p>
          </div>
          <button class="ds-x" type="button" @click="emit('close')">关闭</button>
        </header>
        <div class="ds-body"><slot /></div>
        <footer v-if="hasFoot" class="ds-foot"><slot name="foot" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-mask {
  position: fixed; inset: 0; z-index: 55; background: rgba(0, 0, 0, .5);
  display: flex; align-items: flex-end; justify-content: center;
}
/* 底部抽屉：10 圆角 + 发丝线 + grab 条；扁平，不用投影 */
.ds {
  width: 100%; max-width: 640px; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--r-lg) var(--r-lg) 0 0; overflow: hidden;
}
.ds::before {
  content: ""; width: 36px; height: 4px; border-radius: 2px; background: var(--line);
  margin: 8px auto 0; flex: none;
}
.ds.wide { max-width: 760px; }
.ds-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  padding: 10px 14px 8px; border-bottom: 1px solid var(--line-soft); flex: none;
}
.ds-head h3 { margin: 0; font-size: var(--t-md); font-weight: 650; letter-spacing: -.01em; }
.ds-sub { margin: 4px 0 0; font-size: var(--t-2xs); color: var(--muted); line-height: 1.5; }
.ds-x {
  flex: none; height: 28px; padding: 0 9px; background: var(--panel-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); color: var(--muted); font-size: var(--t-2xs); cursor: pointer;
}
.ds-x:hover { color: var(--fg); border-color: var(--accent-dim); }
.ds-body { padding: 12px 14px 16px; overflow: auto; -webkit-overflow-scrolling: touch; }
.ds-foot {
  flex: none; display: flex; gap: 8px; justify-content: flex-end;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line);
  background: var(--panel-2);
}
@media (min-width: 720px) {
  .ds-mask { align-items: center; padding: 24px; }
  .ds { border-radius: var(--r-lg); border: 1px solid var(--line); max-height: 84vh; }
  .ds::before { display: none; }
}
</style>
