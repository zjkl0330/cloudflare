<script setup lang="ts">
/**
 * 功能索引（2026-11-20）：一屏列出这个控制台能去哪、能做什么。
 *
 * 为什么加：底栏只有 5 个键，DNS / 缓存 / WAF / 页面详情这些二级能力都藏在站点里面，
 * 新用户不知道有；ghx 的做法是每个入口都有一条带说明的路由。这里用一张可搜索的索引
 * 把「去哪」变成可查的清单，不新增数据请求，也不改各屏的取数逻辑。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Icon from "./Icon.vue";

const emit = defineEmits<{ (e: "close"): void }>();
const nav = useRouter();
const q = ref("");
const input = ref<HTMLInputElement | null>(null);

type Item = { ico: string; title: string; sub: string; to: string; k: string };

const ITEMS: Item[] = [
  { ico: "globe", title: "域名与 DNS", sub: "站点列表 → DNS 记录、Worker / Pages 绑定、路由", to: "/domains", k: "zone dns 记录 解析 域名 站点" },
  { ico: "refresh", title: "缓存清理", sub: "站点 → 缓存页，按 URL 清理边缘缓存", to: "/domains", k: "purge cache 缓存 清理" },
  { ico: "shield", title: "WAF / 防火墙规则", sub: "站点 → WAF 页，只读查看托管规则", to: "/domains", k: "waf 防火墙 安全 规则" },
  { ico: "settings", title: "站点配置向导与测速", sub: "站点 → 工具页，DNS 向导和 itdog 测速", to: "/domains", k: "向导 测速 itdog 工具" },
  { ico: "compute", title: "计算 · Workers", sub: "Worker 列表、版本、域名、变量、绑定、定时器", to: "/compute", k: "worker workers 版本 部署 绑定 secret" },
  { ico: "board", title: "计算 · Pages", sub: "项目详情、部署历史、回滚、环境变量、构建日志", to: "/compute", k: "pages 项目 部署 回滚 构建" },
  { ico: "traffic", title: "看板 · 流量", sub: "请求 / 带宽 / 缓存 / 国家与主机分布", to: "/board", k: "流量 看板 统计 analytics 请求" },
  { ico: "traffic", title: "深度分析", sub: "补充指标与 Top 20 下钻", to: "/board/deep", k: "深度 分析 top 下钻" },
  { ico: "disc", title: "数据库 · D1", sub: "库列表、表结构、只读 SQL 与写闸门", to: "/database", k: "d1 sql 数据库 表 query" },
  { ico: "secrets", title: "数据库 · KV", sub: "命名空间、Key 列表、读值 / 写值 / 删除", to: "/database?store=kv", k: "kv key value 命名空间 存储" },
  { ico: "disc", title: "数据库 · R2", sub: "存储桶列表与桶信息", to: "/database?store=r2", k: "r2 bucket 对象 存储桶" },
  { ico: "shield", title: "Zero Trust", sub: "Access 应用、用户组、策略、组织", to: "/zero-trust", k: "zero trust access 应用 策略 用户组" },
  { ico: "account", title: "API 令牌", sub: "账户级令牌列表与新建（直连模式）", to: "/settings/tokens", k: "token 令牌 api" },
  { ico: "gear", title: "设置", sub: "连接、账号、外观、写操作、请求预算、版本", to: "/settings", k: "设置 主题 账号 连接 版本 更新" },
];

const shown = computed(() => {
  const s = q.value.trim().toLowerCase();
  if (!s) return ITEMS;
  return ITEMS.filter((i) => `${i.title} ${i.sub} ${i.k}`.toLowerCase().includes(s));
});

function go(i: Item) {
  emit("close");
  nav.push(i.to);
}

onMounted(() => input.value?.focus());
</script>

<template>
  <Teleport to="body">
    <div class="qi-mask" @click.self="emit('close')">
      <div class="qi" role="dialog" aria-modal="true" aria-label="功能索引">
        <header class="qi-h">
          <b>功能索引</b>
          <button class="qi-x" @click="emit('close')">关闭</button>
        </header>
        <div class="qi-find">
          <Icon name="search" :size="14" />
          <input
            ref="input" v-model="q" type="search"
            placeholder="搜索功能：DNS、WAF、缓存、D1、令牌…"
            spellcheck="false" autocomplete="off"
            @keydown.esc="emit('close')"
          />
        </div>
        <div class="qi-list">
          <button v-for="i in shown" :key="i.title" class="qi-row" @click="go(i)">
            <span class="qi-ic"><Icon :name="i.ico" :size="15" /></span>
            <span class="qi-tx">
              <span class="qi-t">{{ i.title }}</span>
              <span class="qi-s">{{ i.sub }}</span>
            </span>
            <Icon class="qi-chev" name="chevron" :size="12" />
          </button>
          <div class="qi-empty" v-if="!shown.length">没有匹配的功能，换个词试试。</div>
        </div>
        <p class="qi-foot">条目只负责导航；能不能写、能不能读，仍由各屏自己的权限与写闸门决定。</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qi-mask {
  position: fixed; inset: 0; z-index: 70;
  background: var(--scrim);
  display: flex; align-items: flex-start; justify-content: center;
  padding: calc(16px + var(--safe-top)) 12px 12px;
}
.qi {
  width: 100%; max-width: 560px; max-height: 86dvh;
  display: flex; flex-direction: column;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--r-lg);
  overflow: hidden;
}
.qi-h {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 8px; font-size: 15px; font-weight: 650;
}
.qi-x {
  border: 0; background: none; color: var(--brand-ink); font-size: var(--t-xs); cursor: pointer;
}
.qi-find {
  display: flex; align-items: center; gap: 7px;
  margin: 0 14px 8px; padding: 0 10px; height: 36px;
  background: var(--inset); border: 1px solid var(--line); border-radius: var(--r-sm);
  color: var(--muted);
}
.qi-find input {
  flex: 1; min-width: 0; border: 0; outline: none; background: none;
  color: var(--fg); font-family: inherit; font-size: var(--t-sm);
}
.qi-find input::-webkit-search-cancel-button { display: none; }
.qi-list { flex: 1; overflow-y: auto; border-top: 1px solid var(--line-soft); }
.qi-row {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border: 0; border-bottom: 1px solid var(--line-soft);
  background: none; color: inherit; text-align: left; cursor: pointer;
}
.qi-row:hover { background: var(--panel-2); }
.qi-ic {
  flex: none; width: 30px; height: 30px; display: grid; place-items: center;
  border-radius: var(--r-sm); background: rgb(var(--accent-rgb) / .1); color: var(--brand-ink);
}
.qi-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.qi-t { font-size: 13px; font-weight: 600; }
.qi-s { font-size: var(--t-2xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qi-chev { flex: none; color: var(--muted); transform: rotate(-90deg); }
.qi-empty { padding: 18px 14px; color: var(--muted); font-size: var(--t-sm); }
.qi-foot {
  margin: 0; padding: 9px 14px calc(11px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line-soft); color: var(--muted); font-size: var(--t-2xs); line-height: 1.5;
}
</style>
