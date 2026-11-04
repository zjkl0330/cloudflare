<script lang="ts">
/**
 * 写操作的确认抽屉。它是**公共件**，放在 console-data 分支上，因为 Workers / 域名 / 看板三个包
 * 都要用，谁先建谁就会把另外两个的改动盖掉（docs/13 §7.5 的「点名对象 + 说明后果 + 按钮用动词」）。
 *
 * 为什么非要有它：docs/09 §B5 实测过 CF 对 purge 的非法 payload 是**照收并执行**，
 * 所以「我们以为会被拒」不能当成安全依据，唯一可靠的闸门是让人在发出去之前看见真要发的东西。
 * 这里显示的路径与请求体就是 gwWrite() 要用的同一个对象，不是第二套文案。
 */
export default { name: "ConfirmSheet" };
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { WritePreview } from "../lib/api";

const props = defineProps<{
  preview: WritePreview | null;
  /** 已经发出去了：按钮变成转圈并禁用，避免连点变成两次真写 */
  busy?: boolean;
  /** 上一次尝试的失败原因；成功后由调用方关掉本抽屉 */
  error?: string;
}>();
const emit = defineEmits<{ (e: "confirm"): void; (e: "cancel"): void }>();

/** 不可撤销的动作要人把对象名再敲一遍，敲错就不给确认（竞品删记录不带名字，是反面教材） */
const NAME_TARGET = "要删除的记录";
const typed = ref("");
const needTyping = computed(() => props.preview?.danger === "irreversible");
const targetName = computed(() => props.preview?.lines.find((l) => l.k === NAME_TARGET)?.v ?? "");
const canConfirm = computed(() => !props.busy && (!needTyping.value || (targetName.value.length > 0 && typed.value.trim() === targetName.value)));

watch(() => props.preview, () => { typed.value = ""; });

const consequence = computed(() => {
  if (!props.preview) return "";
  if (props.preview.danger === "irreversible") return "此操作不可撤销：记录删掉后只能重新添加，已生效的解析会立刻失效。";
  if (props.preview.method === "POST" && props.preview.path.endsWith("purge_cache")) return "缓存清掉后访客要回源站取，短时间内的命中率会下降，不影响站点可用性。";
  return "改动立即生效，Cloudflare 全球节点会在几十秒内同步。";
});
</script>

<template>
  <Teleport to="body">
    <div v-if="preview" class="sheet-mask" @click.self="emit('cancel')">
      <div class="sheet" role="dialog" aria-modal="true">
        <header class="sheet-head">
          <h3>{{ preview.title }}</h3>
          <button class="sheet-x" type="button" @click="emit('cancel')">取消</button>
        </header>

        <p class="sheet-target">
          即将对
          <b>{{ preview.lines.find((l) => l.k === 'Zone')?.v || preview.path }}</b>
          执行下面这条请求，发送前请核对每一个字段：
        </p>

        <div class="sheet-cmd mono">{{ preview.method }} {{ preview.path }}</div>

        <dl class="sheet-fields">
          <template v-for="l in preview.lines.filter((x) => x.k !== 'Zone')" :key="l.k">
            <dt>{{ l.k }}</dt>
            <dd class="mono">{{ l.v }}</dd>
          </template>
          <template v-if="preview.body">
            <dt>请求体</dt>
            <dd class="mono wrap">{{ JSON.stringify(preview.body) }}</dd>
          </template>
        </dl>

        <p class="sheet-warn">{{ consequence }}</p>

        <label v-if="needTyping" class="sheet-type">
          <span>请输入记录名 <b class="mono">{{ targetName }}</b> 以确认删除</span>
          <input v-model="typed" :placeholder="targetName" autocomplete="off" spellcheck="false" />
        </label>

        <p v-if="error" class="sheet-err">{{ error }}</p>

        <footer class="sheet-foot">
          <button class="btn ghost" type="button" :disabled="busy" @click="emit('cancel')">先不发</button>
          <button class="btn danger" type="button" :disabled="!canConfirm" @click="emit('confirm')">
            {{ busy ? '发送中…' : (preview.danger === 'irreversible' ? '删除这条记录' : (preview.path.endsWith('purge_cache') ? '清理这些 URL' : '提交这次改动')) }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .45);
  display: flex; align-items: flex-end; justify-content: center; z-index: 60;
}
/* 底部抽屉：ghx 口径 —— 10 圆角、发丝线、86vh 上限、顶部 grab 条；不用投影把层抬起来 */
.sheet {
  width: 100%; max-width: 640px; max-height: 86vh; overflow: auto;
  background: var(--panel); color: var(--fg);
  border: 1px solid var(--line); border-bottom: 0; border-radius: var(--r-lg) var(--r-lg) 0 0;
  padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 10px;
}
.sheet::before {
  content: ""; width: 36px; height: 4px; border-radius: 2px; background: var(--line);
  margin: 0 auto 2px; flex: none;
}
.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sheet-head h3 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.sheet-x {
  flex: none; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--panel-2); color: var(--muted); font-size: var(--t-2xs); cursor: pointer;
}
.sheet-x:hover { color: var(--fg); border-color: var(--accent-dim); }
.sheet-target { margin: 0; font-size: var(--t-xs); line-height: 1.6; color: var(--muted); }
.sheet-cmd {
  font-size: var(--t-2xs); padding: 8px 10px; border-radius: var(--r-sm);
  background: var(--panel-2); border: 1px solid var(--line-soft); word-break: break-all;
}
.sheet-fields { display: grid; grid-template-columns: 88px 1fr; gap: 0 10px; margin: 0; font-size: var(--t-xs); }
.sheet-fields dt { color: var(--muted); padding: 6px 0; border-top: 1px solid var(--line-soft); }
.sheet-fields dd { margin: 0; padding: 6px 0; border-top: 1px solid var(--line-soft); word-break: break-all; }
.sheet-fields > :first-child, .sheet-fields > :nth-child(2) { border-top: 0; padding-top: 2px; }
.sheet-fields dd.wrap { font-size: var(--t-2xs); white-space: normal; }
.mono { font-family: var(--font-num); }
/* 后果用左轨提示，别整段染成暖色 */
.sheet-warn {
  margin: 0; font-size: var(--t-xs); color: var(--warn); line-height: 1.6;
  padding: 8px 10px; border-left: 3px solid var(--warn); background: rgb(var(--warn-rgb) / .08);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.sheet-type { display: flex; flex-direction: column; gap: 6px; font-size: var(--t-xs); color: var(--muted); }
.sheet-type input {
  height: 36px; padding: 0 10px; border-radius: var(--r-sm); font-size: var(--t-sm);
  border: 1px solid var(--line); background: var(--panel-2); color: inherit; font-family: inherit;
}
.sheet-type input:focus { outline: none; border-color: var(--accent); }
.sheet-err {
  margin: 0; font-size: var(--t-xs); line-height: 1.6; color: var(--bad);
  padding: 8px 10px; border-radius: 0 var(--r-sm) var(--r-sm) 0;
  border-left: 3px solid var(--bad); background: rgb(var(--bad-rgb) / .08);
}
.sheet-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 2px; }
.btn {
  height: 36px; padding: 0 14px; border-radius: var(--r-sm); font-size: var(--t-sm); border: 1px solid transparent;
  cursor: pointer; font-family: inherit;
}
.btn.ghost { background: var(--panel-2); color: var(--fg-2); border-color: var(--line); }
.btn.ghost:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--fg); }
.btn.danger { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.btn.danger:hover:not(:disabled) { background: var(--accent-hi); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
