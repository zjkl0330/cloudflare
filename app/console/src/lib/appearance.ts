/**
 * 外观偏好（2026-11-21 按 unslop 的"克制 chrome"重排）：底栏形态 / 文字 / 动效 /
 * 密度 / 字号 / 顶栏副题。全部落在 `<html data-*>` 上，CSS 只认属性；
 * 首屏由 index.html 的内联脚本在打包 JS 之前应用一次，避免闪烁。
 */
const KEY = "cfconsole.appearance.v1";

export type TabbarStyle = "solid" | "float";
export type TabbarLabel = "text" | "icon";
export type MotionPref = "full" | "lite";
export type DensityPref = "cozy" | "compact";
export type SizePref = "normal" | "large";
export type SubPref = "on" | "off";

export interface Appearance {
  tabbar: TabbarStyle;
  label: TabbarLabel;
  motion: MotionPref;
  density: DensityPref;
  size: SizePref;
  sub: SubPref;
}

export const DEFAULT_APPEARANCE: Appearance = {
  tabbar: "solid",
  label: "text",
  motion: "full",
  density: "cozy",
  size: "normal",
  sub: "on",
};

export const TABBAR_OPTIONS: { value: TabbarStyle; label: string }[] = [
  { value: "solid", label: "贴底通栏" },
  { value: "float", label: "悬浮胶囊" },
];
export const LABEL_OPTIONS: { value: TabbarLabel; label: string }[] = [
  { value: "text", label: "图标 + 文字" },
  { value: "icon", label: "仅图标" },
];
export const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: "full", label: "标准" },
  { value: "lite", label: "精简" },
];
export const DENSITY_OPTIONS: { value: DensityPref; label: string }[] = [
  { value: "cozy", label: "舒适" },
  { value: "compact", label: "紧凑" },
];
export const SIZE_OPTIONS: { value: SizePref; label: string }[] = [
  { value: "normal", label: "标准" },
  { value: "large", label: "大号" },
];
export const SUB_OPTIONS: { value: SubPref; label: string }[] = [
  { value: "on", label: "显示" },
  { value: "off", label: "隐藏" },
];

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Appearance>) : {};
    return {
      tabbar: p.tabbar === "float" ? "float" : "solid",
      label: p.label === "icon" ? "icon" : "text",
      motion: p.motion === "lite" ? "lite" : "full",
      density: p.density === "compact" ? "compact" : "cozy",
      size: p.size === "large" ? "large" : "normal",
      sub: p.sub === "off" ? "off" : "on",
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(next: Appearance): Appearance {
  const v: Appearance = {
    tabbar: next.tabbar === "float" ? "float" : "solid",
    label: next.label === "icon" ? "icon" : "text",
    motion: next.motion === "lite" ? "lite" : "full",
    density: next.density === "compact" ? "compact" : "cozy",
    size: next.size === "large" ? "large" : "normal",
    sub: next.sub === "off" ? "off" : "on",
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式：内存里仍生效 */
  }
  applyAppearance(v);
  return v;
}

/** 属性名固定，值就是枚举：CSS 只认 `[data-tabbar="float"]` 这类精确匹配 */
export function applyAppearance(a: Appearance): void {
  const el = document.documentElement;
  el.dataset.tabbar = a.tabbar;
  el.dataset.tablabel = a.label;
  el.dataset.motion = a.motion;
  el.dataset.density = a.density;
  el.dataset.size = a.size;
  el.dataset.sub = a.sub;
  // 旧的"微光"背景档已移除，清掉残留属性，避免老配置继续生效
  delete el.dataset.bg;
}
