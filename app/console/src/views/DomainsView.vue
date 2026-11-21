<script setup lang="ts">
import { Browser } from "@capacitor/browser";
import { useRoute, useRouter } from "vue-router";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { reloadTick, requestReload, setPageSub } from "../lib/bus";
import ErrorNote from "../components/ErrorNote.vue";
import Icon from "../components/Icon.vue";
import ConfirmSheet from "../components/ConfirmSheet.vue";
import DnsRecordForm from "../components/dns/DnsRecordForm.vue";
import DnsPurgeForm from "../components/dns/DnsPurgeForm.vue";
import DnsSetupWizard from "../components/dns/DnsSetupWizard.vue";
import ZoneStatusCard from "../components/dns/ZoneStatusCard.vue";
import WriteGate from "../components/WriteGate.vue";
import {
  api,
  apiAs,
  dropMem,
  forceFreshWindow,
  GwError,
  isNativeApp,
  previewDnsDelete,
  previewZoneRoute,
  writesOptIn,
  type RouteInput,
  type Waf,
  type WritePreview,
} from "../lib/api";
import { dt } from "../lib/fmt";
import { labelOf } from "../lib/accounts";
import { agg, aggAccounts, aggSkipped, focusAccount, mapLimit } from "../lib/aggregate";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const domains = ref<Slot<any[]>>(mk());
const zones = ref<Slot<any[]>>(mk());
const records = ref<Slot<any[]>>(mk());
const routes = ref<Slot<any[]>>(mk());
const waf = ref<Slot<Waf>>(mk());
/** 账户级 workers.dev 前缀（域名页那行 `*.前缀.workers.dev`）；CF 只返回前缀，不返回开关 */
const sub = ref<Slot<{ subdomain?: string }>>(mk());
/** Pages 自定义域名：按项目分组。GET /v1/pages 拿到项目，再逐个 GET …/domains（上游没有账户级聚合口） */
type PageDomainsGroup = { project: string; domains: any[]; err?: GwError };
const pageDomains = ref<Slot<PageDomainsGroup[]>>(mk());

/* ---------- 多账号合一（只读）：每个账号一份「站点 + 记录 + 路由 + 绑定」 ---------- */
type AggZone = { id: string; zone: any; records: any[]; routes: any[] };
type AggBundle = {
  acc: string;
  accName: string;
  pending: boolean;
  zones: AggZone[];
  domains: any[];
  pageDomains: PageDomainsGroup[];
  errs: Array<{ label: string; err: GwError }>;
};
const aggData = ref<AggBundle[]>([]);
const aggLoading = ref(false);
const aggDone = ref(0);
const zoneId = ref("");
/** 当前选中 zone 的名称（用于写侧 preview* 回显） */
const currentZoneName = computed(() => {
  const arr = zones.value.data ?? [];
  const z = arr.find((x: any) => String(x.id) === String(zoneId.value));
  return z?.name || "";
});

/* ---------- 合并模式的站点筛选：切换器不消失，改成「跨账号站点清单」 ----------
 * 合并视图没有"当前站点"，但把所有站点一把铺平会很难找；这里给「全部站点」+ 按账号分组的站点。
 * 选中后只看那个账号的那个站点 —— 键里带账号 id，两个账号有同名站点也不会串。 */
const aggZoneKey = ref(""); // "" = 全部；否则 acc|zoneId
const aggZoneGroups = computed(() =>
  aggData.value
    .filter((b) => b.zones.length)
    .map((b) => ({
      acc: b.acc,
      accName: b.accName,
      zones: b.zones.map((z) => ({ id: z.id, name: String(z.zone?.name ?? ""), status: String(z.zone?.status ?? "") })),
    })),
);
const aggZoneCount = computed(() => aggZoneGroups.value.reduce((n, g) => n + g.zones.length, 0));
const aggZoneSel = computed(() => {
  const k = aggZoneKey.value;
  if (!k) return null;
  const [acc, id] = k.split("|");
  for (const g of aggZoneGroups.value) {
    if (g.acc !== acc) continue;
    const z = g.zones.find((x) => x.id === id);
    if (z) return { acc, accName: g.accName, id, name: z.name, status: z.status };
  }
  return null;
});

/* ---------- 站点检索：站点一多，下拉里一条条翻比记名字还慢 ----------
 * 只筛切换器里的清单，不动已选站点、不发请求；匹配站点名 / zone id / 账号名。 */
const zoneQuery = ref("");
/**
 * 域名页是真正的两级路由（2026-11-20）：
 *   /domains          → 站点列表
 *   /domains/:zone    → 站点详情，pane 写在 ?pane= 里
 * 这样 Android 返回键、浏览器后退、刷新、分享链接都落在同一个位置；
 * 之前用本地 ref 切列表/详情，返回键会直接把整屏退掉。
 */
type Pane = "dns" | "cache" | "waf" | "tools" | "status";
const PANES: Pane[] = ["dns", "cache", "waf", "tools", "status"];
const route = useRoute();
const nav = useRouter();
const isDetail = computed(() => !!route.params.zone);
function paneFromUrl(): Pane {
  const p = String(route.query.pane ?? "");
  return (PANES as string[]).includes(p) ? (p as Pane) : "dns";
}
const pane = ref<Pane>(paneFromUrl());
function setPane(p: Pane) {
  pane.value = p;
  nav.replace({ query: p === "dns" ? {} : { pane: p } });
}
watch(() => route.query.pane, () => { const p = paneFromUrl(); if (p !== pane.value) pane.value = p; });

/** 列表点进详情：压一层历史，返回键正好回列表 */
function openZone(z: any) {
  zopen.value = false;
  zoneQuery.value = "";
  nav.push("/domains/" + encodeURIComponent(String(z.id)));
}
/** 详情里换站点：换掉当前这一层，不要留一长串同构历史 */
function switchZone(z: any) {
  zopen.value = false;
  nav.replace("/domains/" + encodeURIComponent(String(z.id)));
}
watch(() => agg.on, (on) => { if (on) nav.replace("/domains"); });
/** 深链里的 zone id 不属于当前账号（或已被删）就退回列表，不把空详情留在屏幕上 */
watch([() => zones.value.data, isDetail], () => {
  const arr = zones.value.data;
  if (!arr || !isDetail.value) return;
  if (!arr.some((z: any) => String(z.id) === zoneId.value)) nav.replace("/domains");
});
const zoneQ = computed(() => zoneQuery.value.trim().toLowerCase());
const zonesFiltered = computed(() => {
  const q = zoneQ.value;
  const arr = zones.value.data ?? [];
  if (!q) return arr;
  return arr.filter((z: any) => `${z.name ?? ""} ${z.id ?? ""}`.toLowerCase().includes(q));
});

/** 面板开合：写侧三块（新增/编辑、清缓存、向导）默认收起，一屏不塞满 */
const editorOpen = ref(false);
const purgeOpen = ref(false);
const wizardOpen = ref(false);

/* ---------- 测速（itdog）：App 只负责拼参数跳转，节点与结果都在 itdog 那边 ---------- */
/** 输入框值：跟着站点走，用户改过就不再跟着变（= 旧值不再等于站点名） */
const speedTarget = ref("");
watch(currentZoneName, (v, old) => {
  if (!speedTarget.value || speedTarget.value === old) speedTarget.value = v;
}, { immediate: true });
/** 允许直接粘整条 URL，这里只取主机部分；itdog 的 ping 页只认主机/IP */
function speedHost(): string {
  return speedTarget.value.trim()
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#]/)[0]
    .trim();
}
async function openSpeedTest(target?: string) {
  const host = String(target ?? speedHost()).trim()
    .replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].trim();
  if (!host) return;
  const url = `https://www.itdog.cn/ping/${encodeURIComponent(host)}/?auto_submit=1`;
  // 网页模式开新标签；APK 里 window.open 会被 WebView 吞掉，用 Capacitor Browser 打开系统浏览器
  if (!isNativeApp()) { window.open(url, "_blank", "noopener"); return; }
  try { await Browser.open({ url }); }
  catch { window.open(url, "_blank", "noopener"); }
}
/** 编辑器的当前对象：record=编辑、preset=向导带过来的新增预填、都空=空白新增 */
const editorRecord = ref<Record<string, any> | null>(null);
const editorPreset = ref<{ type?: string; name?: string } | null>(null);
/** 路由编辑器：声明必须在下面的 immediate 路由 watcher 之前，否则切站点时会踩 TDZ */
const routeOpen = ref(false);
const routeEditing = ref<any | null>(null);

/** 本机写开关：关了根本不出网（api 里 gwWrite 先查它）。默认关，符合 docs/13 §7.5「别摆没放行的入口」。
 *  开关的读写与文案统一在 WriteGate 组件里；这里只留状态给按钮的 disabled 判断用。 */
const writesOn = ref(writesOptIn());

/** 确认抽屉状态 + 确认后要执行的那一次真写 */
const sheet = ref<{ preview: WritePreview | null; busy: boolean; error: string }>({ preview: null, busy: false, error: "" });
let runWrite: (() => Promise<unknown>) | null = null;
const doneMsg = ref("");

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try { slot.value = { data: await fn(), err: null, loading: false }; }
  catch (e) { slot.value = { data: slot.value.data, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) }; }
}

const arrOf = (r: any): any[] => (Array.isArray(r?.result) ? r.result : []);
const asGw = (e: unknown): GwError => (e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e)));

/**
 * 合并模式取数：一个账号一个 bundle，账号之间并发 2、同账号里 zone 之间并发 3。
 * 每类请求各自 catch —— 一个 zone 的 DNS 403 不该让这个账号的其它 zone 一起消失，
 * 更不该让另一个账号整屏没了。
 */
async function loadAgg() {
  aggLoading.value = true;
  aggDone.value = 0;
  const accs = aggAccounts();
  aggData.value = accs.map((a) => ({
    acc: a.id, accName: labelOf(a), pending: true, zones: [], domains: [], pageDomains: [], errs: [],
  }));
  await mapLimit(accs, 2, async (a) => {
    const b = aggData.value.find((x) => x.acc === a.id);
    if (!b) return;
    const e = apiAs(a.id);

    try {
      const zs = arrOf(await e.zones());
      b.zones = await mapLimit(zs, 3, async (z: any) => {
        const [rec, rt] = await Promise.allSettled([e.dnsRecords(String(z.id)), e.zoneRoutes(String(z.id))]);
        if (rec.status === "rejected") b.errs.push({ label: `${z?.name || z?.id} · DNS`, err: asGw(rec.reason) });
        if (rt.status === "rejected") b.errs.push({ label: `${z?.name || z?.id} · 路由`, err: asGw(rt.reason) });
        return {
          id: String(z?.id ?? ""),
          zone: z,
          records: rec.status === "fulfilled" ? arrOf(rec.value) : [],
          routes: rt.status === "fulfilled" ? arrOf(rt.value) : [],
        };
      });
    } catch (e2) {
      b.errs.push({ label: "站点列表", err: asGw(e2) });
    }

    try { b.domains = arrOf(await e.domains()); }
    catch (e2) { b.errs.push({ label: "Worker 自定义域名", err: asGw(e2) }); }

    try {
      const list = arrOf(await e.pages());
      b.pageDomains = await mapLimit(list, 3, async (p: any) => {
        const project = String(p?.name ?? "");
        if (!project) return { project: "", domains: [] };
        try { return { project, domains: arrOf(await e.pageDomains(project)) }; }
        catch (e2) {
          const err = asGw(e2);
          // 单个项目读不到域名（403/404）不该静默吞掉，也不该影响同账号其它项目
          b.errs.push({ label: `${project} · Pages 域名`, err });
          return { project, domains: [], err };
        }
      });
    } catch (e2) {
      b.errs.push({ label: "Pages 域名", err: asGw(e2) });
    }

    b.pending = false;
    aggDone.value++;
  });
  aggLoading.value = false;
}

async function loadTop() {
  if (agg.on) { await loadAgg(); return; }
  await Promise.allSettled([
    grab(domains, async () => { const r: any = await api.domains(); return Array.isArray(r.result) ? r.result : (r.result ?? []); }),
    grab(zones, async () => { const r = await api.zones(); return Array.isArray(r.result) ? r.result : []; }),
    grab(sub, async () => (await api.accountSubdomain()).result ?? null),
    grab(pageDomains, async () => {
      const r = await api.pages();
      const list = Array.isArray(r.result) ? r.result : [];
      // 每个项目一条 domains 请求；单项目 403/404 不影响其它项目（分组里留 err 如实显示）
      const groups = await Promise.all(
        list.map(async (p: any): Promise<PageDomainsGroup> => {
          const project = String(p?.name ?? "");
          if (!project) return { project: "", domains: [] };
          try {
            const d = await api.pageDomains(project);
            return { project, domains: Array.isArray(d.result) ? d.result : [] };
          } catch (e) {
            return { project, domains: [], err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
          }
        }),
      );
      return groups.filter((g) => g.project);
    }),
  ]);
}

async function loadZone() {
  if (agg.on) return; // 合并模式没有"当前站点"，记录随 bundle 一起取
  if (!zoneId.value) return;
  await Promise.allSettled([
    grab(records, async () => { const x = await api.dnsRecords(zoneId.value); return Array.isArray(x.result) ? x.result : []; }),
    grab(routes, async () => { const x = await api.zoneRoutes(zoneId.value); return Array.isArray(x.result) ? x.result : []; }),
    grab(waf, () => api.zoneWaf(zoneId.value)),
  ]);
}

onMounted(async () => { await loadTop(); });

/* ---------- 站点下拉：展开/收起 + 点外面关闭 ---------- */
const zopen = ref(false);
const zddEl = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (zopen.value && zddEl.value && !zddEl.value.contains(e.target as Node)) zopen.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

/** 「刷新」= 这一屏全部绕过两层缓存重来；平时进这屏只发命中的那几条 */
/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
async function refresh() { forceFreshWindow(); if (agg.on) { await loadAgg(); } else { await loadTop(); await loadZone(); } }
/**
 * 站点 id 的唯一来源是路由（2026-11-21）：深链、前进后退、下拉切换都走这里。
 * 刷新进来时 zoneId 还是空串，必须在 immediate 里直接 loadZone，不能等 zoneId 的 watcher
 * （那个 watcher 注册得比这里晚，首次赋值会被漏掉，表现为"详情页 0 条 DNS 记录"）。
 */
watch(() => route.params.zone, (id) => {
  const next = String(id ?? "");
  if (!next) { zoneId.value = ""; return; }
  pane.value = paneFromUrl();
  zoneId.value = next;
  editorOpen.value = false;
  editorRecord.value = null;
  editorPreset.value = null;
  routeOpen.value = false;
  routeEditing.value = null;
  loadZone();
}, { immediate: true });

const zoneName = computed(() => (zones.value.data ?? []).find((z: any) => String(z.id) === zoneId.value)?.name ?? "");
const currentZone = computed(() => (zones.value.data ?? []).find((z: any) => String(z.id) === zoneId.value) ?? null);
/** 站点列表里每条状态的展示：状态、套餐、NS 条数都是列表接口原样给的字段，不猜 */
const nsOf = (z: any): string[] => (Array.isArray(z?.vanity_name_servers) && z.vanity_name_servers.length
  ? z.vanity_name_servers : z?.name_servers) ?? [];
const planOf = (z: any): string => z?.plan?.name || z?.plan?.legacy_id || "套餐未知";
const ZONE_STATE: Record<string, string> = {
  active: "已生效", pending: "待激活", initializing: "初始化中", paused: "已暂停",
  deactivated: "已停用", moved: "已迁移", pending_deletion: "待删除", deleted: "已删除",
};
const zoneState = (s: unknown): string => ZONE_STATE[String(s ?? "").toLowerCase()] || String(s ?? "未知");
const wafCount = computed(() => waf.value.data?.ruleCount ?? 0);

/** 顶栏副题：列表页说站点数，详情页说当前站点的套餐与 NS */
watch([() => zones.value.data, isDetail, currentZoneName, pane], () => {
  if (agg.on) { setPageSub(`${aggAccounts().length} 个账号 · 只读合并`); return; }
  const arr = zones.value.data ?? [];
  if (isDetail.value && currentZone.value) {
    // 详情页自己的头已经写了站点名与状态，顶栏不再加副题
    setPageSub("");
  } else {
    setPageSub(arr.length ? `${arr.length} 个站点 · ${arr.filter((z: any) => z.status === "active").length} 个已生效` : "站点与 DNS");
  }
}, { immediate: true });

/** 站点状态折叠条上的摘要：只放状态/套餐/NS 条数，不再重复站点名（切换器已经显示了） */
const zoneSummary = computed(() => {
  const z: any = currentZone.value;
  if (!z) return "";
  const ns = (Array.isArray(z.vanity_name_servers) && z.vanity_name_servers.length ? z.vanity_name_servers : z.name_servers) ?? [];
  return `${zoneState(z.status)} · ${planOf(z)} · NS ${ns.length} 条`;
});
const router = useRouter();

/** 把 DNS 记录、Worker / Pages 自定义域名、Workers 路由按主机名合成一行 —— 同一个域名只出现一次。
 *  合并模式下键里再加账号 id：两个账号都有 example.com 时谁都不该覆盖谁。 */
type HostRow = {
  key: string;
  host: string;
  acc: string;
  accName: string;
  records: any[];
  workers: any[];
  pages: any[];
  routes: any[];
};

function hostUnder(h: string, zone: string): boolean {
  const z = zone.toLowerCase();
  if (!z) return true;
  const s = h.toLowerCase().replace(/^\*\./, "");
  return s === z || s.endsWith("." + z);
}
function hostInZone(h: string): boolean {
  const z = zoneName.value.toLowerCase();
  return !z || hostUnder(h, z);
}

const mergedRows = computed<HostRow[]>(() => {
  const map = new Map<string, HostRow>();
  const get = (acc: string, accName: string, host: string): HostRow => {
    const key = (acc ? acc + "|" : "") + host.trim().toLowerCase();
    let row = map.get(key);
    if (!row) {
      row = { key, host: host.trim(), acc, accName, records: [], workers: [], pages: [], routes: [] };
      map.set(key, row);
    }
    return row;
  };

  if (agg.on) {
    const sel = aggZoneSel.value;
    for (const b of aggData.value) {
      if (sel && sel.acc !== b.acc) continue; // 已筛到某个账号的某个站点：其它账号整份不参与
      const zones = sel ? b.zones.filter((z) => z.id === sel.id) : b.zones;
      const zNames = zones.map((z) => String(z.zone?.name ?? ""));
      const inAny = (h: string) => !zNames.length || zNames.some((z) => hostUnder(h, z));
      for (const z of zones) {
        for (const r of z.records) {
          const name = String(r?.name ?? "").trim();
          if (name) get(b.acc, b.accName, name).records.push(r);
        }
        for (const rt of z.routes) {
          const pattern = String(rt?.pattern ?? "").trim();
          if (pattern) get(b.acc, b.accName, pattern.replace(/\/\*$/, "")).routes.push(rt);
        }
      }
      for (const d of b.domains) {
        const host = String(d?.hostname ?? "").trim();
        if (host && inAny(host)) get(b.acc, b.accName, host).workers.push(d);
      }
      for (const g of b.pageDomains) {
        for (const d of g.domains) {
          const host = String(d?.name ?? d?.domain ?? d?.hostname ?? "").trim();
          if (host && inAny(host)) get(b.acc, b.accName, host).pages.push({ ...d, project: g.project });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.host.localeCompare(b.host) || a.accName.localeCompare(b.accName));
  }

  for (const r of records.value.data ?? []) {
    const name = String(r?.name ?? "").trim();
    if (name) get("", "", name).records.push(r);
  }
  for (const d of domains.value.data ?? []) {
    const host = String(d?.hostname ?? "").trim();
    if (host && hostInZone(host)) get("", "", host).workers.push(d);
  }
  for (const g of pageDomains.value.data ?? []) {
    for (const d of g.domains ?? []) {
      const host = String(d?.name ?? d?.domain ?? d?.hostname ?? "").trim();
      if (host && hostInZone(host)) get("", "", host).pages.push({ ...d, project: g.project });
    }
  }
  for (const rt of routes.value.data ?? []) {
    const pattern = String(rt?.pattern ?? "").trim();
    if (!pattern) continue;
    get("", "", pattern.replace(/\/\*$/, "")).routes.push(rt);
  }
  return [...map.values()].sort((a, b) => a.host.localeCompare(b.host));
});

/* ---------- 长记录折叠：只折"真的长"的值，短值不摆展开按钮 ---------- */
const LONG_CHARS = 60;
const openVals = ref<Set<string>>(new Set());
function isLongValue(v: unknown): boolean {
  const s = String(v ?? "");
  return s.length > LONG_CHARS || s.includes("\n");
}
function valKey(row: HostRow, r: any): string {
  return row.key + ":" + String(r?.id ?? "");
}
function isValOpen(row: HostRow, r: any): boolean {
  return openVals.value.has(valKey(row, r));
}
function toggleVal(row: HostRow, r: any): void {
  const k = valKey(row, r);
  const s = new Set(openVals.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  openVals.value = s;
}

const hostSearch = ref("");
const hostQ = computed(() => hostSearch.value.trim().toLowerCase());
/** 类型 / 代理两个快筛：不用记语法，点一下就收窄 */
const DNS_TYPES = ["ALL", "A", "AAAA", "CNAME", "TXT", "MX", "NS", "其他"] as const;
const DNS_LABEL: Record<string, string> = { ALL: "全部", "其他": "其他" };
const dnsType = ref<string>("ALL");
const onlyProxied = ref(false);
const COMMON_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "HTTPS"]);
const filterOn = computed(() => !!hostQ.value || dnsType.value !== "ALL" || onlyProxied.value);

function typeHit(r: any): boolean {
  if (dnsType.value === "ALL") return true;
  const t = String(r?.type ?? "").toUpperCase();
  if (dnsType.value === "其他") return !COMMON_TYPES.has(t);
  return t === dnsType.value;
}

/** 行内记录：先吃类型/代理，再看搜索词；域名本身命中时保留整行 */
function recsOf(row: HostRow): any[] {
  let recs = row.records;
  if (dnsType.value !== "ALL") recs = recs.filter(typeHit);
  if (onlyProxied.value) recs = recs.filter((r) => !!r.proxied);
  const q = hostQ.value;
  if (q && !row.host.toLowerCase().includes(q) && !row.accName.toLowerCase().includes(q)) {
    const hit = recs.filter((r) => `${r.name ?? ""} ${r.type ?? ""} ${r.content ?? ""}`.toLowerCase().includes(q));
    if (hit.length) recs = hit;
  }
  return recs;
}

const filteredRows = computed(() => {
  if (!filterOn.value) return mergedRows.value;
  const q = hostQ.value;
  return mergedRows.value.filter((row) => {
    if (recsOf(row).length) return true;
    // 类型/代理筛选开着时，没有匹配记录的行就收起来；搜索词命中域名或绑定才保留
    if (q && (row.host.toLowerCase().includes(q) || row.accName.toLowerCase().includes(q))) return true;
    if (!q) return false;
    return row.workers.some((w) => String(w.service ?? "").toLowerCase().includes(q))
      || row.pages.some((p) => String(p.project ?? "").toLowerCase().includes(q))
      || row.routes.some((rt) => String(rt.pattern ?? "").toLowerCase().includes(q) || String(rt.script ?? "").toLowerCase().includes(q));
  });
});

const visibleRecordCount = computed(() => filteredRows.value.reduce((n, row) => n + recsOf(row).length, 0));

function resetDnsFilters() {
  hostSearch.value = "";
  dnsType.value = "ALL";
  onlyProxied.value = false;
}

/** 卡片头那行统计：单账号与合并模式各自的口径，不混着写 */
const statsLine = computed(() => {
  if (agg.on) {
    const sel = aggZoneSel.value;
    const bundles = sel ? aggData.value.filter((b) => b.acc === sel.acc) : aggData.value;
    const scoped = (b: AggBundle) => (sel ? b.zones.filter((z) => z.id === sel.id) : b.zones);
    const zs = bundles.reduce((n, b) => n + scoped(b).length, 0);
    const dns = bundles.reduce((n, b) => n + scoped(b).reduce((m, z) => m + z.records.length, 0), 0);
    const rt = bundles.reduce((n, b) => n + scoped(b).reduce((m, z) => m + z.routes.length, 0), 0);
    const head = sel ? `${sel.accName} · ${sel.name} · ` : `${aggData.value.length} 个账号 · `;
    return `${head}${zs} 个站点 · ${mergedRows.value.length} 个域名 · ${dns} 条 DNS 记录 · ${rt} 条 Workers 路由`;
  }
  return `${mergedRows.value.length} 个域名 · ${records.value.data?.length ?? 0} 条 DNS 记录 · ${routes.value.data?.length ?? 0} 条 Workers 路由`;
});

const aggErrList = computed(() =>
  aggData.value.flatMap((b) => b.errs.map((x) => ({ ...x, accName: b.accName }))),
);
/** 单账号模式下 Pages 项目域名读失败的项目：按项目独立说明，不静默吞掉（合并模式的错误汇进 aggErrList） */
const pageDomainErrs = computed(() =>
  (pageDomains.value.data ?? [])
    .filter((g) => !!g.err)
    .map((g) => ({ project: g.project, err: g.err as GwError })),
);
const aggPending = computed(() => aggData.value.filter((b) => b.pending).map((b) => b.accName));
/** 列表加载态：合并模式看聚合进度，单账号看当前站的记录 */
const listLoading = computed(() => (agg.on ? aggLoading.value : records.value.loading));

/** 退出合并视图：回到当前账号的单账号视图（顶栏下拉里也有同一个开关） */
function exitAgg() {
  agg.on = false;
  aggZoneKey.value = "";
  requestReload();
}

function goWorker(service: string, acc = "") {
  const s = String(service ?? "").trim();
  if (!s) return;
  if (agg.on && acc) focusAccount(acc);
  router.push(`/workers/${encodeURIComponent(s)}?c=domains`);
}
function goProject(project: string, acc = "") {
  const p = String(project ?? "").trim();
  if (!p) return;
  if (agg.on && acc) focusAccount(acc);
  router.push(`/pages/${encodeURIComponent(p)}?c=domains`);
}
function recTtl(r: any): string {
  return r?.ttl === 1 ? "自动" : `${r?.ttl ?? "?"}s`;
}

/** 三种"没有规则"的文案必须分开，这是实测出来的形状（docs/04 §8）：没配过 ≠ 没权限 ≠ 套餐不认 */
const WAF_STATE: Record<string, { text: string; live: boolean }> = {
  ok: { text: "有规则集", live: true },
  empty: { text: "没配过规则", live: false },
  unsupported: { text: "本套餐不认这个 phase", live: false },
  denied: { text: "缺权限", live: false },
  error: { text: "读取失败", live: false },
};
const wafPhases = computed(() => waf.value.data?.phases ?? []);

/* ---------- 写侧：表单/清缓存 → 预览 → ConfirmSheet → api → dropMem + 重取 ---------- */

function openCreate() { editorRecord.value = null; editorPreset.value = null; editorOpen.value = true; purgeOpen.value = false; doneMsg.value = ""; }
function openEdit(r: any) { editorRecord.value = r; editorPreset.value = null; editorOpen.value = true; doneMsg.value = ""; }

/** 表单/清缓存交来的预览：先开抽屉给人逐字段核对，run 闭包留到确认时真发 */
function onFormPreview(p: { preview: WritePreview; action: { kind: "create" | "update"; input: any; id?: string } }) {
  editorOpen.value = false;
  openSheet(p.preview, () =>
    p.action.kind === "create"
      ? api.createDnsRecord(zoneId.value, p.action.input)
      : api.updateDnsRecord(zoneId.value, p.action.id!, p.action.input),
  );
}
function onPurgePreview(p: { preview: WritePreview; action: { kind: "purge"; files: string[] } }) {
  openSheet(p.preview, () => api.purgeUrls(zoneId.value, p.action.files));
}
/** 删除：从列表直接生成不可撤销预览，ConfirmSheet 会要求手打记录名 */
function onDelete(r: any) {
  doneMsg.value = "";
  try {
    openSheet(previewDnsDelete(zoneId.value, currentZoneName.value, String(r.id), String(r.name)), () => api.deleteDnsRecord(zoneId.value, String(r.id)));
  } catch (e) {
    doneMsg.value = e instanceof GwError ? e.hint : String((e as Error)?.message || e);
  }
}
/** 向导「照此新增」：切到该记录所属 Zone，带类型/名称打开新增表单（内容仍要人填、发送仍要确认） */
function onWizardSuggest(s: { zoneId: string; type: string; name: string }) {
  wizardOpen.value = false;
  if (s.zoneId && s.zoneId !== zoneId.value) {
    // 换到记录所属站点；路由 watcher 会 loadZone 并把编辑器关掉，所以下一步用 microtask 再开
    nav.replace(`/domains/${encodeURIComponent(s.zoneId)}?pane=dns`);
    setTimeout(() => { editorRecord.value = null; editorPreset.value = { type: s.type, name: s.name }; editorOpen.value = true; }, 0);
  } else {
    editorRecord.value = null; editorPreset.value = { type: s.type, name: s.name }; editorOpen.value = true;
  }
}

/* ---------- 站点 Workers 路由：新增 / 改 / 删 ----------
 * 上游 POST/PUT/DELETE `/zones/{z}/workers/routes`，body {pattern, script|null}。
 * 这条写需要令牌带 Workers Routes Write（docs/05）；缺权限时 CF 回 403，错误原样留在抽屉里。 */
const routePattern = ref("");
const routeScript = ref("");
const routeErr = ref("");

function openRouteCreate() {
  routeEditing.value = null;
  routePattern.value = "";
  routeScript.value = "";
  routeErr.value = "";
  routeOpen.value = true;
  doneMsg.value = "";
}
function openRouteEdit(r: any) {
  routeEditing.value = r;
  routePattern.value = String(r?.pattern ?? "");
  routeScript.value = String(r?.script ?? "");
  routeErr.value = "";
  routeOpen.value = true;
  doneMsg.value = "";
}
function routeInput(): RouteInput {
  return { pattern: routePattern.value.trim(), script: routeScript.value.trim() ? routeScript.value.trim() : null };
}
function askSaveRoute() {
  routeErr.value = "";
  doneMsg.value = "";
  try {
    const input = routeInput();
    const editing = routeEditing.value;
    const pv = previewZoneRoute(zoneId.value, currentZoneName.value, editing ? "update" : "create", editing ? { ...input, id: String(editing.id) } : input);
    openSheet(pv, () =>
      editing ? api.zoneRouteUpdate(zoneId.value, String(editing.id), input) : api.zoneRouteCreate(zoneId.value, input),
    );
  } catch (e) {
    routeErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}
function askDeleteRoute(r: any) {
  routeErr.value = "";
  doneMsg.value = "";
  try {
    openSheet(previewZoneRoute(zoneId.value, currentZoneName.value, "delete", r), () => api.zoneRouteDelete(zoneId.value, String(r.id)));
  } catch (e) {
    routeErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}

function openSheet(preview: WritePreview, run: () => Promise<unknown>) {
  runWrite = run;
  sheet.value = { preview, busy: false, error: "" };
}
function cancelSheet() { sheet.value = { preview: null, busy: false, error: "" }; runWrite = null; }
async function confirmSheet() {
  if (!runWrite || sheet.value.busy) return;
  sheet.value = { ...sheet.value, busy: true, error: "" };
  try {
    await runWrite();
    const kind = sheet.value.preview?.path.endsWith("purge_cache") ? "缓存" : sheet.value.preview?.path.includes("/routes") ? "路由" : "记录";
    sheet.value = { preview: null, busy: false, error: "" };
    runWrite = null;
    routeOpen.value = false;
    routeEditing.value = null;
    dropMem("/v1/zones/" + zoneId.value);
    await loadZone();
    doneMsg.value = kind + "写请求已成功返回，列表已重取。";
  } catch (e) {
    const err = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
    // 不谎报成功：把网关/本地的拒绝原因如实留在抽屉里，让人看清 501 / 权限 / 校验各是什么
    sheet.value = { ...sheet.value, busy: false, error: `[${err.kind} · HTTP ${err.http}] ${err.message} —— ${err.hint}` };
  }
}
</script>

<template>
  <div>
    <!-- 合并视图（只读）：站点切换器仍在（跨账号清单），这里补账号数 / 进度 / 逐账号错误 -->
    <div v-if="agg.on" class="aggbar">
      <div class="aggtop">
        <span class="aggt">合并视图 · {{ aggAccounts().length }} 个账号 · 只读</span>
        <button class="ghost sm" @click="exitAgg">退出合并</button>
      </div>
      <div class="small muted" v-if="aggLoading">
        正在取数：{{ aggDone }}/{{ aggAccounts().length }} 个账号已就绪{{ aggPending.length ? " · 等待 " + aggPending.join("、") : "" }}
      </div>
      <div class="small muted" v-else>点条目会先切到它所属账号再进详情；写操作请在单账号下进行。</div>
      <div class="small muted" v-if="aggSkipped().length">网页模式跳过 {{ aggSkipped().length }} 个 OAuth 账号（拿不到令牌）。</div>
      <div v-for="(x, i) in aggErrList" :key="i" class="small agg-err">
        {{ x.accName }} · {{ x.label }}：{{ x.err.hint }}
      </div>
    </div>

    <!-- ========== 一级：站点列表 ========== -->
    <template v-if="!agg.on && !isDetail">
      <div class="list-head">
        <span class="lh-t">站点 <b>{{ zonesFiltered.length }}</b><span class="lh-s" v-if="zoneQuery.trim() && zones.data">/ 共 {{ zones.data.length }} 个</span></span>
        <button class="ghost sm" :disabled="zones.loading" @click="refresh">{{ zones.loading ? "刷新中…" : "刷新" }}</button>
      </div>
      <input
        v-model="zoneQuery" class="field zsearch-full" type="search"
        placeholder="搜索站点名 / Zone ID" spellcheck="false" autocomplete="off"
      />
      <ErrorNote :err="zones.err" />
      <div class="empty" v-if="zones.loading && !zones.data">正在读取站点…</div>
      <div class="zlist" v-else-if="zonesFiltered.length">
        <button v-for="z in zonesFiltered" :key="String(z.id)" class="zrow" @click="openZone(z)">
          <i class="zdot" :data-s="z.status || 'unknown'" />
          <span class="zrow-main">
            <span class="zrow-name">{{ z.name }}</span>
            <span class="zrow-meta">{{ planOf(z) }} · NS {{ nsOf(z).length }} 条 · {{ z.type === "partial" ? "CNAME 接入" : "完整接入" }}</span>
          </span>
          <span class="badge" :class="{ live: z.status === 'active', roll: z.status === 'pending' }">{{ zoneState(z.status) }}</span>
          <Icon class="zchev" name="chevron" :size="12" />
        </button>
      </div>
      <div class="empty" v-else-if="zones.data && !zones.err">没有匹配的站点</div>
    </template>

    <!-- ========== 二级：站点详情（或合并视图） ========== -->
    <template v-else>
      <div class="dtop" v-if="!agg.on">
        <div class="dtt">
          <div class="dname">{{ currentZoneName || "站点" }}</div>
          <div class="dsub">{{ zoneSummary }}</div>
        </div>
        <button class="ghost sm zspeed" :disabled="!currentZoneName" @click="openSpeedTest()">测速</button>
        <div class="zdd" ref="zddEl">
          <button class="zbtn" :aria-expanded="zopen" aria-haspopup="listbox" @click.stop="zopen = !zopen">
            切换<i class="chev" :class="{ up: zopen }">▾</i>
          </button>
          <div class="zpanel" v-if="zopen" role="listbox" aria-label="切换站点">
            <button
              v-for="z in zonesFiltered" :key="z.id"
              class="zopt" :class="{ on: String(z.id) === zoneId }"
              role="option" :aria-selected="String(z.id) === zoneId"
              @click="switchZone(z)"
            >
              <i class="zdot" :data-s="z.status || 'unknown'" />
              <span class="zopt-name">{{ z.name }}</span>
              <span class="zopt-st">{{ zoneState(z.status) }}</span>
            </button>
            <div v-if="!zonesFiltered.length" class="small muted" style="padding: 8px 9px">没有匹配的站点</div>
          </div>
        </div>
      </div>

      <div class="seg panes" v-if="!agg.on" role="tablist" aria-label="站点功能">
        <button class="seg-b" :class="{ on: pane === 'dns' }" @click="setPane('dns')">DNS</button>
        <button class="seg-b" :class="{ on: pane === 'cache' }" @click="setPane('cache')">缓存</button>
        <button class="seg-b" :class="{ on: pane === 'waf' }" @click="setPane('waf')">WAF</button>
        <button class="seg-b" :class="{ on: pane === 'tools' }" @click="setPane('tools')">工具</button>
        <button class="seg-b" :class="{ on: pane === 'status' }" @click="setPane('status')">状态</button>
      </div>

      <!-- DNS / 绑定 -->
      <div class="card plain" v-if="agg.on || pane === 'dns'">
        <div class="hd">
          <h3 style="margin: 0">{{ agg.on ? "域名与 DNS（合并 · 只读）" : "域名与 DNS" }}</h3>
          <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap" v-if="!agg.on">
            <WriteGate v-model="writesOn" variant="inline" />
            <button class="primary sm" :disabled="!zoneId" @click="openCreate">新增 DNS 记录</button>
            <button class="ghost sm" :disabled="!zoneId || !writesOn" @click="openRouteCreate">新增路由</button>
          </div>
          <span v-else class="small muted">合并模式不摆写入口</span>
        </div>

        <div class="small muted" style="margin-bottom: 8px" v-if="mergedRows.length || agg.on">
          {{ statsLine }}
        </div>

        <ErrorNote :err="records.err || domains.err || routes.err" v-if="!agg.on" />
        <div v-for="g in pageDomainErrs" :key="'pd-' + g.project" class="small agg-err">
          {{ g.project }} · Pages 自定义域名读取失败：{{ g.err.hint }}
        </div>

        <div class="dns-filters" v-if="mergedRows.length || agg.on">
          <div class="cfind">
            <Icon name="search" :size="14" />
            <input v-model="hostSearch" placeholder="搜索域名 / 记录值 / Worker / Pages" spellcheck="false" autocomplete="off" />
            <button v-if="hostSearch" class="clr" aria-label="清空搜索" @click="hostSearch = ''">×</button>
          </div>
          <div class="dchips">
            <button
              v-for="t in DNS_TYPES" :key="t" class="chip"
              :class="{ on: dnsType === t }" @click="dnsType = t"
            >{{ DNS_LABEL[t] || t }}</button>
            <button class="chip" :class="{ on: onlyProxied }" @click="onlyProxied = !onlyProxied">仅代理</button>
            <button v-if="filterOn" class="chip clear" @click="resetDnsFilters">清除</button>
          </div>
          <div class="small muted dns-count" v-if="filterOn">
            {{ filteredRows.length }} 个域名 · {{ visibleRecordCount }} 条记录
          </div>
        </div>

        <div v-if="editorOpen" class="editor">
          <h4>{{ editorRecord ? '编辑记录' : '新增记录' }}</h4>
          <DnsRecordForm
            :key="String(editorRecord?.id || editorPreset?.name || 'new')"
            :zone-id="zoneId"
            :zone-name="currentZoneName"
            :record="editorRecord"
            :preset="editorPreset"
            @preview="onFormPreview"
            @cancel="editorOpen = false"
          />
        </div>

        <div v-if="routeOpen" class="editor">
          <h4>{{ routeEditing ? "修改路由" : "新增路由" }}</h4>
          <div class="row gen">
            <input v-model="routePattern" class="field" placeholder="example.com/*" spellcheck="false" autocomplete="off" />
            <input v-model="routeScript" class="field" placeholder="Worker 名（留空 = 仅记录，不跑 Worker）" spellcheck="false" autocomplete="off" />
          </div>
          <p class="small muted">
            pattern 必须属于 {{ zoneName }}，并以 <code>*</code> 结尾；上游 POST/PUT/DELETE 三条同一路径。
            这条写需要令牌带 Workers Routes Write，缺权限时 CF 回 403，会原样显示。
          </p>
          <p class="small errtext" v-if="routeErr">{{ routeErr }}</p>
          <div class="row" style="gap: 8px">
            <button class="ghost sm" :disabled="!writesOn" @click="askSaveRoute">预览并确认</button>
            <button class="ghost sm" @click="routeOpen = false">取消</button>
          </div>
        </div>

        <div class="hlist" v-if="filteredRows.length">
          <div v-for="row in filteredRows" :key="row.key" class="hrow">
            <div class="hhead">
              <div class="hname">{{ row.host }}</div>
              <span v-if="agg.on && row.accName" class="badge acctag" :title="row.acc">{{ row.accName }}</span>
              <span v-if="row.records.some((r) => r.proxied)" class="badge prox">已代理</span>
              <span v-if="row.workers.length" class="badge blue">Worker</span>
              <span v-if="row.pages.length" class="badge blue">Pages</span>
              <span v-if="row.routes.length" class="badge">路由</span>
              <button class="linkbtn hspeed" type="button" @click="openSpeedTest(row.host)">测速</button>
            </div>

            <div v-for="r in recsOf(row)" :key="'dns-' + r.id" class="hline two">
              <div class="hl-top">
                <span class="badge">{{ r.type }}</span>
                <span
                  class="hcontent mono"
                  :class="{ clamp: isLongValue(r.content) && !isValOpen(row, r) }"
                  :title="String(r.content)"
                >{{ r.content }}</span>
              </div>
              <div class="hl-bot">
                <span class="small muted">{{ recTtl(r) }} · {{ r.proxied ? "已代理" : "仅 DNS" }}</span>
                <button
                  v-if="isLongValue(r.content)" class="linkbtn foldbtn" type="button"
                  @click="toggleVal(row, r)"
                >{{ isValOpen(row, r) ? "收起" : "展开" }}</button>
                <span class="ha" v-if="!agg.on">
                  <button class="ghost sm" @click="openEdit(r)">编辑</button>
                  <button class="ghost sm danger" @click="onDelete(r)">删除</button>
                </span>
              </div>
            </div>

            <div v-for="w in row.workers" :key="'w-' + (w.id || w.hostname)" class="hline">
              <span class="harrow">→ Worker</span>
              <button class="linkbtn" type="button" @click="goWorker(w.service, row.acc)">{{ w.service }}</button>
              <span class="small muted">{{ w.environment || "production" }}<template v-if="w.cert_id"> · 有证书</template></span>
            </div>

            <div v-for="(d, i) in row.pages" :key="'p-' + row.host + i" class="hline">
              <span class="harrow">→ Pages</span>
              <button class="linkbtn" type="button" @click="goProject(d.project, row.acc)">{{ d.project }}</button>
              <span v-if="d.status" class="badge" :class="{ live: d.status === 'active' }">{{ d.status === "active" ? "已生效" : d.status }}</span>
            </div>

            <div v-for="rt in row.routes" :key="'rt-' + rt.id" class="hline">
              <span class="harrow">→ 路由</span>
              <span class="mono">{{ rt.pattern }}</span>
              <span class="small muted">{{ rt.script || "仅记录" }}</span>
              <span class="ha" v-if="!agg.on">
                <button class="ghost sm" :disabled="!writesOn" @click="openRouteEdit(rt)">编辑</button>
                <button class="ghost sm danger" :disabled="!writesOn" @click="askDeleteRoute(rt)">删除</button>
              </span>
            </div>

            <div v-if="!row.records.length" class="hline small muted">没有 DNS 记录（仅靠路由 / 外部解析生效）</div>
          </div>
        </div>
        <div v-else-if="!listLoading" class="empty">
          {{ filterOn ? "没有匹配的 DNS 记录或绑定" : agg.on ? "这些账号里还没有 DNS 记录或绑定" : "这个站点还没有 DNS 记录或绑定" }}
        </div>
        <div v-else class="empty">加载中…</div>
        <div class="whyline" v-if="doneMsg">{{ doneMsg }}</div>
        <p class="small muted" style="margin-top: 8px" v-if="!writesOn && !agg.on">标题行右侧的本机写开关没打开，增删改按钮是灰的。</p>
      </div>

      <!-- 缓存 -->
      <div class="card" v-if="!agg.on && pane === 'cache'">
        <h3>按 URL 清理缓存</h3>
        <DnsPurgeForm :zone-id="zoneId" :zone-name="currentZoneName" @preview="onPurgePreview" />
        <p class="small muted" style="margin-top: 8px">上限 30 条 URL，逐条回显后再发；默认不预填任何 URL。</p>
      </div>

      <!-- WAF -->
      <div class="card" v-if="!agg.on && pane === 'waf'">
        <h3>WAF / 防火墙规则（只读，共 {{ wafCount }} 条）</h3>
        <ErrorNote :err="waf.err" />
        <div class="list" v-if="wafPhases.length">
          <div v-for="p in wafPhases" :key="p.phase" class="item" style="align-items: flex-start">
            <div style="min-width: 0">
              <div class="k">{{ p.label }}</div>
              <div class="small muted">{{ p.note || (p.rules.length ? `规则集 ${p.name} · 版本 ${p.version} · 最后修改于 ${dt(p.last_updated)}` : "规则集为空") }}</div>
              <div v-for="r in p.rules" :key="String(r.id)" style="margin-top: 6px">
                <div class="small">
                  <span class="badge" :class="{ live: r.enabled }">{{ r.action }}{{ r.enabled ? "" : " · 已停用" }}</span>
                  {{ r.description || "无描述" }}
                </div>
                <div class="small" style="word-break: break-all"><code>{{ r.expression }}</code></div>
              </div>
            </div>
            <div class="v">
              <span class="badge" :class="{ live: WAF_STATE[p.state]?.live }">{{ WAF_STATE[p.state]?.text || p.state }}</span>
              <div class="small">{{ p.rules.length }} 条</div>
            </div>
          </div>
        </div>
        <div class="empty" v-else-if="waf.loading">取数中…</div>
        <div class="empty" v-else>这个站点没有可读的 WAF 规则集</div>
        <p class="small muted" style="margin-top: 8px">只读展示，不含命中次数（原因见 docs/14 §8）。</p>
      </div>

      <!-- 工具 -->
      <template v-if="!agg.on && pane === 'tools'">
        <div class="card">
          <h3>DNS 配置向导</h3>
          <DnsSetupWizard :domains="domains.data || []" :zones="zones.data || []" @suggest="onWizardSuggest" />
          <p class="small muted" style="margin-top: 8px">给自定义域名验证提示该填什么记录；判定规则是本控制台自研，界面上会写清。</p>
        </div>
        <div class="card">
          <h3>测速（itdog）</h3>
          <div class="gen">
            <input v-model="speedTarget" class="field" placeholder="example.com 或 IP" spellcheck="false" autocomplete="off" />
            <button class="primary" :disabled="!speedHost()" @click="openSpeedTest()">打开 itdog 测速</button>
          </div>
          <p class="small muted" style="margin-top: 6px">
            默认填当前站点，可改成任意域名 / IP。打开后 itdog 自动开始 ping，节点与线路由 itdog 决定，结果只在那个页面里，本机不回显。
          </p>
        </div>
        <div class="card">
          <h3>Workers.dev 子域</h3>
          <p class="small muted" v-if="sub.data?.subdomain">这个账号的 Worker 默认挂在 <code>*.{{ sub.data.subdomain }}.workers.dev</code> 下；自定义域名见 DNS 页的绑定行。</p>
          <p class="small muted" v-else>这条接口没返回账号级 workers.dev 前缀，先不给结论。</p>
        </div>
      </template>

      <!-- 状态 -->
      <div class="card" v-if="!agg.on && pane === 'status'">
        <h3>站点状态与 nameserver</h3>
        <ZoneStatusCard v-if="currentZone" :zone="currentZone" />
        <p class="small muted" style="margin-top: 8px">
          状态、套餐、NS 都来自 <code>GET /zones</code> 原字段；接入方式为 CNAME 时，NS 可能不在这里。
        </p>
      </div>
    </template>

    <ConfirmSheet :preview="sheet.preview" :busy="sheet.busy" :error="sheet.error" @confirm="confirmSheet" @cancel="cancelSheet" />
  </div>
</template>

<style scoped>
/* 站点切换器：ghx 的下拉 —— 收起是一个 34 高的描边按钮，展开是扁平浮层（无软投影） */
.zdd { position: relative; min-width: 0; }
.zbtn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border-radius: var(--r-sm);
  border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: var(--t-2xs); cursor: pointer;
  max-width: 72vw; }
.zbtn:hover, .zbtn[aria-expanded="true"] { color: var(--fg); background: var(--panel-2); }
.zbtn:hover, .zbtn[aria-expanded="true"] { border-color: var(--accent); }
.zname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.chev { font-style: normal; font-size: var(--t-2xs); color: var(--muted); transition: transform .15s ease; }
.chev.up { transform: rotate(180deg); }
.zpanel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: min(300px, 82vw);
  max-height: 60vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 5px; }
/* 站点检索：粘在清单顶部，滚很远也不丢输入框 */
.zsearch { position: sticky; top: -5px; z-index: 1; display: flex; align-items: center; gap: 8px;
  padding: 6px 5px 8px; margin: -5px -5px 4px; background: var(--panel); border-bottom: 1px solid var(--line-soft); }
.zsearch .field { flex: 1; min-width: 0; height: 32px; padding: 0 10px; font-size: var(--t-sm);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); color: inherit; }
.zsearch .field:focus-visible { outline: 2px solid rgb(var(--accent-rgb)); outline-offset: 1px; }
.zsearch .muted { flex: none; white-space: nowrap; }
.zopt { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 9px; border: 0;
  border-radius: var(--r-sm); background: none; color: inherit; font-size: var(--t-sm); cursor: pointer; text-align: left; }
.zopt:hover { background: var(--panel-2); }
.zopt.on { background: var(--panel-2); font-weight: 600; color: var(--accent); }
/* 合并模式的站点清单按账号分组：组头是账号名，小一号、不抢站点名 */
.zgrp { margin-top: 4px; }
.zgrp-h { padding: 6px 9px 2px; font-size: var(--t-2xs); color: var(--muted); letter-spacing: .04em; }
.zopt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zopt-st { font-size: var(--t-2xs); color: var(--muted); flex: none; }
.zdot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.zdot[data-s="active"] { background: var(--ok); }
.zdot[data-s="pending"] { background: var(--warn); }

/* 卡片内头行：标题落到与其它详情页同一档眉题 */
.hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px;
  flex-wrap: wrap; }
.hd h3 { margin: 0; font-size: var(--t-2xs); color: var(--muted); font-weight: 600;
  letter-spacing: 0; text-transform: none; }
/* 窄屏：眉题独占一行，写开关和两个主行动掉到下一行，避免按钮贴着卡片边缘 */
@media (max-width: 430px) {
  .hd { align-items: flex-start; }
  .hd > .row { width: 100%; justify-content: flex-start; }
}

/* 表单区不另起一只圆角盒子，用一条发丝线把它跟列表切开 */
.editor { border: 0; border-top: 1px solid var(--line-soft); border-radius: 0; padding: 10px 0 4px; margin: 10px 0; background: transparent; }
.editor h4 { margin: 0 0 8px; font-size: var(--t-2xs); color: var(--muted); font-weight: 600;
  letter-spacing: 0; text-transform: none; }
.whyline.ok { color: var(--ok); background: rgb(var(--ok-rgb) / .08); border-left-color: var(--ok); }
.errtext { color: var(--bad); }
button.sm { height: 28px; padding: 0 10px; font-size: var(--t-2xs); }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 280px; }

/* 折叠区里的工具卡不再各自套一只描边盒：展开后是连续的节，节与节之间一条发丝线 */
details.grp > .card { margin: 0; padding: 10px 2px; border: 0; border-radius: 0; background: transparent; }
details.grp > .card::before { display: none; }
details.grp > .card + .card { border-top: 1px solid var(--line-soft); }
details.grp > .card:last-of-type { padding-bottom: 12px; }
/* 折叠区里的名单也拉平：只留发丝线，不再是一个内嵌的圆角列表盒 */
details.grp .list { border: 0; border-radius: 0; background: transparent; overflow: visible; }
details.grp .list .item { padding-left: 2px; padding-right: 2px; }
details.grp .list .item:first-child { border-top: 1px solid var(--line-soft); }

/* 一个域名一行：DNS / Worker / Pages / 路由都收在同一行里，不再分三个 tab 重复列。
   行与行之间只留发丝线（不再是每行一只圆角小卡，纸上叠纸） */
.hlist { display: flex; flex-direction: column; gap: 0; margin-top: 6px; border-top: 1px solid var(--line-soft); }
.hrow { background: transparent; border: 0; border-bottom: 1px solid var(--line-soft); border-radius: 0; padding: 10px 2px; }
.hrow:last-child { border-bottom: 0; }
.hhead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hname { font-size: var(--t-sm); font-weight: 600; word-break: break-all; margin-right: 2px; }
.hline { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 7px;
  padding-top: 7px; border-top: 1px solid var(--line-soft); font-size: var(--t-xs); }
.hrow > .hline:first-of-type { border-top: 0; padding-top: 4px; }
/* 记录行两段式：上行类型 + 值，下行 TTL / 代理 + 动作。长值折两行，卡片高度才一致 */
.hline.two { flex-direction: column; align-items: stretch; gap: 4px; }
.hl-top { display: flex; align-items: flex-start; gap: 7px; min-width: 0; }
.hl-top .hcontent { flex: 1; }
.hl-bot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.foldbtn { flex: none; font-size: var(--t-2xs); }
.hcontent { color: var(--fg-2); min-width: 0; word-break: break-all; max-width: 100%; }
/* 只折"真的长"的值（默认两行）；短值不加这个类，也不会摆展开按钮 */
.hcontent.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* 合并视图状态条：与看板/计算页同一条强调色左轨，不再包一整只描边盒 */
.aggbar { border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 9px 11px; margin-bottom: 10px; background: var(--panel); }
.aggtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.aggt { font-size: var(--t-sm); font-weight: 600; color: var(--accent); }
.agg-err { color: var(--bad); margin-top: 3px; }
.badge.acctag { color: var(--fg-2); border-color: var(--line); font-family: var(--font-num);
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha { margin-left: auto; display: flex; gap: 5px; flex: none; }
.harrow { color: var(--muted); font-size: var(--t-2xs); flex: none; }
.linkbtn { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.linkbtn:hover { color: var(--fg); }
.badge.prox { color: var(--accent); border-color: rgb(var(--accent-rgb) / .45); }
.badge.blue { color: var(--pending-ink); border-color: rgb(var(--pending-rgb) / .45); background: rgb(var(--pending-rgb) / .1); }
.badge.live { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }

/* ---------- 站点列表（一级页） ---------- */
.list-head { display: flex; align-items: center; justify-content: space-between; margin: 2px 0 9px; gap: 8px; }
.lh-t { font-size: 12.5px; font-weight: 600; color: var(--fg); }
.lh-t b { font-family: var(--font-num); }
.lh-s { margin-left: 6px; font-weight: 400; font-size: var(--t-2xs); color: var(--muted); }
.zsearch-full { height: 34px; margin-bottom: 9px; }
.zlist { border-top: 1px solid var(--line-soft); }
.zrow {
  width: 100%; display: flex; align-items: center; gap: 9px;
  padding: 11px 2px; border: 0; border-bottom: 1px solid var(--line-soft);
  background: none; color: inherit; text-align: left; cursor: pointer;
}
.zrow:hover { background: var(--panel-2); }
.zrow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.zrow-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zrow-meta { font-size: var(--t-2xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zchev { flex: none; color: var(--muted); transform: rotate(-90deg); }
.hintline {
  margin-top: 12px; padding: 9px 11px; border: 1px solid var(--line-soft);
  background: var(--panel); color: var(--muted); font-size: var(--t-2xs); line-height: 1.5;
  border-radius: var(--r-sm);
}

/* ---------- DNS 搜索与快筛 ---------- */
.dns-filters { display: flex; flex-direction: column; gap: 7px; margin: 2px 0 9px; }
.cfind {
  display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 9px;
  background: var(--inset); border: 1px solid var(--line); border-radius: var(--r-sm); color: var(--muted);
}
.cfind input { flex: 1; min-width: 0; border: 0; outline: none; background: none; color: var(--fg); font: inherit; font-size: var(--t-sm); }
.cfind input::-webkit-search-cancel-button { display: none; }
.cfind .clr { border: 0; background: none; color: var(--muted); font-size: 15px; line-height: 1; padding: 0 2px; cursor: pointer; }
.cfind .clr:hover { color: var(--fg); }
.dchips { display: flex; gap: 5px; flex-wrap: wrap; }
.dchips .chip { flex: none; }
.dchips .chip.clear { color: var(--brand-ink); border-color: var(--accent); }
.dns-count { margin-top: -1px; }
.hspeed { margin-left: auto; flex: none; font-size: var(--t-2xs); }

/* ---------- 站点详情头 + 功能分段 ---------- */
.dtop { display: flex; align-items: center; gap: 9px; margin: 2px 0 10px; }
.zback {
  flex: none; display: inline-flex; align-items: center; gap: 1px;
  height: 28px; padding: 0 8px 0 5px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--panel); color: var(--muted); font-size: var(--t-2xs); cursor: pointer;
}
.zback:hover { color: var(--fg); background: var(--panel-2); }
.dtt { flex: 1; min-width: 0; }
.dname { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsub { margin-top: 1px; font-size: var(--t-2xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panes { display: flex; width: 100%; margin-bottom: 12px; }
.panes .seg-b { flex: 1; padding: 6px 2px; text-align: center; }
.zsearch-row { gap: 8px; margin: 2px 0 9px; }
.zsearch-row .field { flex: 1; min-width: 0; }
</style>
