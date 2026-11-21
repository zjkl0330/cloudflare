/**
 * 交互偏好：启动页 + 两个分段页的默认档（2026-11-21）。
 *
 * 和 appearance 分开存：外观只影响 CSS 属性，这里影响"打开 App 落在哪一屏"和
 * "计算/数据库默认选哪一段"。URL query 永远优先 —— 分享链接、深链进来时
 * 用户明确指定的那一档不能被本机默认值覆盖。
 */
const KEY = "cfconsole.views.v1";

export type Landing = "board" | "domains" | "compute" | "database";
export type ComputeSeg = "all" | "workers" | "pages";
export type DbSeg = "d1" | "kv" | "r2";

export interface ViewPrefs {
  landing: Landing;
  compute: ComputeSeg;
  db: DbSeg;
}

export const DEFAULT_VIEWS: ViewPrefs = { landing: "board", compute: "all", db: "d1" };

export const LANDING_OPTIONS: { value: Landing; label: string; to: string }[] = [
  { value: "board", label: "看板", to: "/board" },
  { value: "domains", label: "域名", to: "/domains" },
  { value: "compute", label: "计算", to: "/compute" },
  { value: "database", label: "数据库", to: "/database" },
];
export const COMPUTE_OPTIONS: { value: ComputeSeg; label: string }[] = [
  { value: "all", label: "看板" },
  { value: "workers", label: "Workers" },
  { value: "pages", label: "Pages" },
];
export const DB_OPTIONS: { value: DbSeg; label: string }[] = [
  { value: "d1", label: "D1" },
  { value: "kv", label: "KV" },
  { value: "r2", label: "R2" },
];

export function loadViewPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<ViewPrefs>) : {};
    return {
      landing: p.landing === "domains" || p.landing === "compute" || p.landing === "database" ? p.landing : "board",
      compute: p.compute === "workers" || p.compute === "pages" ? p.compute : "all",
      db: p.db === "kv" || p.db === "r2" ? p.db : "d1",
    };
  } catch {
    return { ...DEFAULT_VIEWS };
  }
}

export function saveViewPrefs(next: ViewPrefs): ViewPrefs {
  const v: ViewPrefs = {
    landing: next.landing === "domains" || next.landing === "compute" || next.landing === "database" ? next.landing : "board",
    compute: next.compute === "workers" || next.compute === "pages" ? next.compute : "all",
    db: next.db === "kv" || next.db === "r2" ? next.db : "d1",
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式：本次会话仍然按内存里的值走 */
  }
  return v;
}

/** `/` 的重定向目标：每次冷启动重新读，改完设置下一次进 App 就生效 */
export function landingPath(): string {
  return LANDING_OPTIONS.find((o) => o.value === loadViewPrefs().landing)?.to ?? "/board";
}
