/**
 * 外观偏好（2026-11-20，按 ghx 的设置口径补）：底栏形态 / 底栏文字 / 背景 / 动效。
 *
 * 和 theme.ts 分开是因为语义不同：theme 决定"亮还是暗、主色是什么"，这里决定
 * "导航长什么样、底有没有微光、动效快不快"。全部落在 `<html data-*>` 上，
 * CSS 只认属性；首屏由 main.ts 在挂载前应用一次，避免闪烁。
 */
const KEY = "cfconsole.appearance.v1";

export type TabbarStyle = "solid" | "float";
export type TabbarLabel = "text" | "icon";
export type BgStyle = "plain" | "glow";
export type MotionPref = "full" | "lite";

export interface Appearance {
  tabbar: TabbarStyle;
  label: TabbarLabel;
  bg: BgStyle;
  motion: MotionPref;
}

export const DEFAULT_APPEARANCE: Appearance = { tabbar: "solid", label: "text", bg: "plain", motion: "full" };

export const TABBAR_OPTIONS: { value: TabbarStyle; label: string }[] = [
  { value: "solid", label: "贴底通栏" },
  { value: "float", label: "悬浮胶囊" },
];
export const LABEL_OPTIONS: { value: TabbarLabel; label: string }[] = [
  { value: "text", label: "图标 + 文字" },
  { value: "icon", label: "仅图标" },
];
export const BG_OPTIONS: { value: BgStyle; label: string }[] = [
  { value: "plain", label: "纯色" },
  { value: "glow", label: "微光" },
];
export const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: "full", label: "标准" },
  { value: "lite", label: "精简" },
];

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Appearance>) : {};
    return {
      tabbar: p.tabbar === "float" ? "float" : "solid",
      label: p.label === "icon" ? "icon" : "text",
      bg: p.bg === "glow" ? "glow" : "plain",
      motion: p.motion === "lite" ? "lite" : "full",
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(next: Appearance): Appearance {
  const v: Appearance = {
    tabbar: next.tabbar === "float" ? "float" : "solid",
    label: next.label === "icon" ? "icon" : "text",
    bg: next.bg === "glow" ? "glow" : "plain",
    motion: next.motion === "lite" ? "lite" : "full",
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
  el.dataset.bg = a.bg;
  el.dataset.motion = a.motion;
}
