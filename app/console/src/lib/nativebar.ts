/**
 * 原生系统栏（Android / 鸿蒙）跟主题走。
 *
 * 为什么需要它：APK 里 WebView 之外还有一条系统状态栏，颜色由原生主题决定。
 * 主题资源（resources/android/values[-night]/colors.xml）只能覆盖"跟随系统"这一档；
 * 用户在设置里手动选浅/深时，系统栏会和页面差一截（鸿蒙 4 尤其明显：默认灰底 + 白图标）。
 * 所以每次应用主题后再调一次 StatusBar，把底色和图标明暗钉到与页面一致。
 *
 * 顶部让位量（--safe-top）也在这里定，理由见 syncTopInset 的注释：
 * 鸿蒙 4 的 WebView 在"窗口已经把 WebView 放到状态栏下沿"之后，仍然会把状态栏高度
 * 报成 env(safe-area-inset-top)，顶上再叠一次就成了状态栏和标题之间那条大白块。
 *
 * 网页模式下整段是空操作（Capacitor.isNativePlatform() 为 false）。
 */
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

/** 与 main.css 的 --bg 保持同一值：浅色 #f6f8fa / 深色 #0d1117 */
const BAR_BG = { light: "#f6f8fa", dark: "#0d1117" } as const;

/** 当前实际生效的是不是深色档（显式档优先，否则看系统媒体查询） */
function isDarkNow(): boolean {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return !!window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
}

/** Android 主版本号；取不到返回 0（按老系统处理） */
function androidMajor(): number {
  const m = navigator.userAgent.match(/Android (\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 顶栏要给状态栏让多少高度，写进 CSS 变量 --safe-top。
 *
 * 两种情况：
 *  · Android 14 及以下：setOverlaysWebView(false) 生效，WebView 已经在状态栏下沿，
 *    顶上不需要再让 —— 但鸿蒙 4 的 WebView 仍会报 env(safe-area-inset-top)，
 *    照着它让位就会多出一条白块。所以这里直接钉 0。
 *  · Android 15 起：targetSdk 35 的包被系统强制 edge-to-edge，overlay:false 会被忽略，
 *    WebView 真的铺到状态栏底下，这时必须让一个状态栏高度 —— 用原生实测值（dp 即 CSS px），
 *    不依赖 WebView 的 env()（Chrome/安卓 WebView 普遍不把状态栏算进 safe-area）。
 */
async function syncTopInset(): Promise<void> {
  const el = document.documentElement;
  try {
    if (Capacitor.getPlatform() !== "android") return; // iOS 等平台继续用 CSS 里的 env()
    const major = androidMajor();
    // 取不到版本号也按"老系统"处理：让 0 在鸿蒙 4 这类系统上正好（WebView 本来就在状态栏下沿）；
    // 只有真 edge-to-edge 的 Android 15 才需要让，那条路径由 UA 里的版本号明确命中。
    if (major < 15) {
      el.style.setProperty("--safe-top", "0px");
      return;
    }
    const info = await StatusBar.getInfo();
    el.style.setProperty("--safe-top", `${Math.max(0, Math.round(info.height || 0))}px`);
  } catch {
    /* 量不到就保留 CSS 里的 env() 兜底，不至于把顶栏顶到系统栏里 */
  }
}

export async function syncSystemBars(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const dark = isDarkNow();
  await syncTopInset();
  try {
    // 不让 WebView 铺到状态栏底下：内容仍然从系统栏下沿开始（Android 15 上这条会被系统忽略，
    // 顶栏让位改由上面的 syncTopInset 负责）
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setBackgroundColor({ color: dark ? BAR_BG.dark : BAR_BG.light });
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    /* 老 WebView / 插件不可用：原生主题里的 values-night 已经兜底，不因为这条挂掉整屏 */
  }
}
