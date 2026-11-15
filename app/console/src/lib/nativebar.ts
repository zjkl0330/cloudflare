/**
 * 原生系统栏（Android / 鸿蒙）跟主题走。
 *
 * 为什么需要它：APK 里 WebView 之外还有一条系统状态栏，颜色由原生主题决定。
 * 主题资源（resources/android/values[-night]/colors.xml）只能覆盖"跟随系统"这一档；
 * 用户在设置里手动选浅/深时，系统栏会和页面差一截（鸿蒙 4 尤其明显：默认灰底 + 白图标）。
 * 所以每次应用主题后再调一次 StatusBar，把底色和图标明暗钉到与页面一致。
 *
 * 网页模式下整段是空操作（Capacitor.isNativePlatform() 为 false）。
 */
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

/** 与 main.css 的 --bg 保持同一值：浅色 #ffffff / 深色 #0d1117 */
const BAR_BG = { light: "#ffffff", dark: "#0d1117" } as const;

/** 当前实际生效的是不是深色档（显式档优先，否则看系统媒体查询） */
function isDarkNow(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return !!window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
}

export async function syncSystemBars(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const dark = isDarkNow();
  try {
    // 不让 WebView 铺到状态栏底下：内容仍然从系统栏下沿开始，safe-area 那套不用改
    await StatusBar.setOverlaysWebView({ overlay: false });
    // Android 15 起该调用在新系统上会被忽略（强制 edge-to-edge，状态栏透明露出页面底色，效果一致）
    await StatusBar.setBackgroundColor({ color: dark ? BAR_BG.dark : BAR_BG.light });
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    /* 老 WebView / 插件不可用：原生主题里的 values-night 已经兜底，不因为这条挂掉整屏 */
  }
}
