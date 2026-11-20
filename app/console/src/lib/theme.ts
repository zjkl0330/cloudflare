/**
 * 外观档位（MASTER.md §7）。单独一个文件是因为 main.ts 要在挂载前就落好档（避免深色下闪一屏白），
 * 而设置页要读写同一份。存 localStorage 的只有一个枚举值，不涉及任何令牌。
 *
 * 三态优先级：手动（light|dark）> 跟随系统 > 兜底。pref=system 时**不写 data-theme 属性**，
 * 交给 main.css 里 `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }` 那段兜底接管，
 * 这样没有 JS 也会跟着系统走；一旦用户显式选浅/深，就写死 data-theme 覆盖掉。
 */
import { syncSystemBars } from "./nativebar";

const KEY = "cfconsole.theme.v1";

export type ThemePref = "system" | "light" | "dark";

export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function saveThemePref(pref: ThemePref): ThemePref {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 隐私模式抛错，内存里仍生效，只是不持久 */
  }
  applyTheme(pref);
  return pref;
}

/** 把档位落到 documentElement：显式浅/深写属性，system 删属性让媒体查询接管 */
export function applyTheme(pref: ThemePref): void {
  const el = document.documentElement;
  if (pref === "light" || pref === "dark") el.dataset.theme = pref;
  else el.removeAttribute("data-theme");
  // 原生壳里把系统状态栏/导航栏也切到同一档（网页模式是空操作）
  void syncSystemBars();
}

/* ============================================================================
 * 强调色档（10-11 新增）：控件/选中/主行动的颜色，独立于深浅。默认 CF 橙（不写属性），
 * 选"蓝"写 data-accent="blue"，main.css 里那族 [data-accent] 只改 --accent，不动 --data-rgb，
 * 所以读数轨的"有数=橙 / 取数中=蓝"四态编码在换色后仍成立。存 cfconsole.accent.v1，同样不涉及令牌。
 * ========================================================================== */
const ACCENT_KEY = "cfconsole.accent.v1";

export type AccentPref = "orange" | "blue" | "purple" | "teal" | "green" | "pink";

export const ACCENT_OPTIONS: { value: AccentPref; label: string }[] = [
  { value: "orange", label: "橙" },
  { value: "blue", label: "蓝" },
  { value: "purple", label: "紫" },
  { value: "teal", label: "青" },
  { value: "green", label: "绿" },
  { value: "pink", label: "粉" },
];

export function loadAccentPref(): AccentPref {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return (ACCENT_OPTIONS.some((o) => o.value === v) ? v : "orange") as AccentPref;
  } catch {
    return "orange";
  }
}

export function saveAccentPref(pref: AccentPref): AccentPref {
  try {
    localStorage.setItem(ACCENT_KEY, pref);
  } catch {
    /* 隐私模式抛错，内存里仍生效，只是不持久 */
  }
  applyAccent(pref);
  return pref;
}

/** 橙是默认档（不写属性）；蓝/紫/青/绿/粉显式写 data-accent */
export function applyAccent(pref: AccentPref): void {
  const el = document.documentElement;
  if (pref === "orange") el.removeAttribute("data-accent");
  else el.dataset.accent = pref;
}

/**
 * 开机调用一次 + 订阅系统变化。只在 pref=system 时系统切换才需要重算，
 * 但删/写属性是幂等的，这里不区分也能正确跟随。
 */
export function watchSystemTheme(): void {
  applyTheme(loadThemePref());
  applyAccent(loadAccentPref());
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return;
  const onChange = () => {
    if (loadThemePref() === "system") applyTheme("system");
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof (mq as any).addListener === "function") (mq as any).addListener(onChange);
}
