/**
 * Git 仓库（GitHub / GitLab）—— 只负责「列我的仓库」和「令牌存本机钥匙串」。
 *
 * 为什么会单独一层：这两个请求打的是 github.com / gitlab.com，不是 Cloudflare，
 * 令牌也是用户自备的 PAT（只读仓库清单用），跟 CF 的 API Token 完全不是一回事：
 *  - 存法不同：Git 令牌一律走系统钥匙串（secure-store.ts），不进 vault、不进网关；
 *  - 报错口径不同：401/403 是"这把 GitHub/GitLab 令牌不行"，不能照抄 CF 令牌的提示；
 *  - 网页模式不可用：GitLab 的 API 没有 CORS 头，浏览器里列仓库必失败；
 *    所以入口在网页模式直接灰掉（由界面负责），这里不静默降级。
 *
 * 仓库名单只列前 100（CF 面板本身也只让人从列表里选一个），多出来的手填 owner/repo 兜底。
 */
import { GwError } from "./api";
import { secureGet, secureRemove, secureSet } from "./secure-store";

export type GitPlatform = "github" | "gitlab";

export const PLATFORM_LABEL: Record<GitPlatform, string> = { github: "GitHub", gitlab: "GitLab" };

/** 钥匙串键：一把平台一把，互不覆盖 */
const TOKEN_KEYS: Record<GitPlatform, string> = {
  github: "git.github.token",
  gitlab: "git.gitlab.token",
};

export async function getGitToken(p: GitPlatform): Promise<string | null> {
  return secureGet(TOKEN_KEYS[p]);
}

export async function setGitToken(p: GitPlatform, token: string): Promise<void> {
  const t = token.trim();
  if (!t) throw new GwError("badQuery", 422, null, "令牌不能为空（要清除请用「清除令牌」）");
  if (/\s/.test(t)) throw new GwError("badQuery", 422, null, "令牌里不能有空格或换行，检查是不是只粘了一半");
  await secureSet(TOKEN_KEYS[p], t);
}

export async function clearGitToken(p: GitPlatform): Promise<void> {
  await secureRemove(TOKEN_KEYS[p]);
}

/** 只回末尾 4 位：界面上永远显示掩码，不给人截图带走的机会 */
export function maskToken(t: string): string {
  const s = t.trim();
  if (!s) return "";
  if (s.length <= 6) return "••••";
  return "•••••••• " + s.slice(-4);
}

export interface GitRepo {
  platform: GitPlatform;
  /** GitHub: 用户/组织；GitLab: 命名空间（可能是 group/subgroup） */
  owner: string;
  /** 仓库名（不带 owner） */
  name: string;
  /** owner/name，界面上点名用 */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

/** 平台 API 失败 → 同形错误，但文案写清是哪个平台、下一步怎么办 */
function gitHttpError(platform: GitPlatform, res: Response, text: string): GwError {
  const who = PLATFORM_LABEL[platform];
  if (res.status === 401) {
    return new GwError("auth", 401, null, `${who} 令牌无效或已过期（HTTP 401）。换一把再试。`);
  }
  if (res.status === 403) {
    // GitHub 的限流也是 403，只能靠剩余额度头判断，不能一律说成"没权限"
    if (platform === "github" && res.headers.get("x-ratelimit-remaining") === "0") {
      return new GwError("rate", 403, "RATE", "GitHub 接口限流了（403 且剩余额度 0），等几分钟再列。");
    }
    return new GwError(
      "permission",
      403,
      null,
      `${who} 令牌没给读仓库的权限（HTTP 403）。GitHub 经典令牌要 \`repo\`，细粒度令牌至少要 Metadata: Read + Contents: Read。`,
    );
  }
  if (res.status === 429) {
    return new GwError("rate", 429, null, `${who} 接口限流了（HTTP 429），等几分钟再列。`);
  }
  if (res.status === 404) {
    return new GwError("notFound", 404, null, `${who} 接口路径不存在（HTTP 404），可能是自建 GitLab 用了别的 API 根路径。`);
  }
  return new GwError("unknown", res.status, null, `${who} 列仓库失败（HTTP ${res.status}）：${text.slice(0, 160)}`);
}

function asGitError(e: unknown): GwError {
  if (e instanceof GwError) return e;
  return new GwError("network", 0, null, String((e as Error)?.message || e));
}

/**
 * 超时自己控，不用 `AbortSignal.timeout`：APK 里 fetch 被 CapacitorHttp 代理到原生网络栈，
 * 对 AbortSignal 的支持有限，靠它会在真机上静默不超时（direct.ts 顶部同一课）。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new GwError("timeout", 0, null, `${label}超时（${Math.round(ms / 1000)} 秒没返回），多半是网络到不了这个 Git 平台。`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * 列当前令牌看得见的仓库（按最近更新排序，最多 100 个）。
 * GitHub 用 Bearer + 官方推荐的 Accept 头；GitLab 用 PRIVATE-TOKEN（它不认 Bearer）。
 */
export async function listGitRepos(platform: GitPlatform, token: string): Promise<GitRepo[]> {
  if (!token.trim()) throw new GwError("auth", 401, null, `还没填 ${PLATFORM_LABEL[platform]} 令牌。`);
  const isGh = platform === "github";
  const url = isGh
    ? "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
    : "https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at&sort=desc";
  let res: Response;
  try {
    res = await withTimeout(fetch(url, {
      headers: isGh
        ? { Authorization: "Bearer " + token.trim(), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
        : { "PRIVATE-TOKEN": token.trim() },
    }), 15_000, "列仓库");
  } catch (e) {
    throw asGitError(e);
  }
  const text = await res.text();
  if (!res.ok) throw gitHttpError(platform, res, text);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GwError("unknown", res.status, null, `${PLATFORM_LABEL[platform]} 返回了非 JSON 内容`);
  }
  if (!Array.isArray(json)) {
    throw new GwError("unknown", res.status, null, `${PLATFORM_LABEL[platform]} 返回的不是仓库数组`);
  }
  if (isGh) {
    return json.map((r: any) => {
      const full = String(r.full_name ?? "");
      const owner = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : String(r.owner?.login ?? "");
      return {
        platform,
        owner,
        name: String(r.name ?? ""),
        fullName: full || `${owner}/${String(r.name ?? "")}`,
        defaultBranch: String(r.default_branch ?? ""),
        private: !!r.private,
        updatedAt: String(r.updated_at ?? ""),
      };
    });
  }
  return json.map((r: any) => {
    const full = String(r.path_with_namespace ?? "");
    const owner = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
    const name = String(r.name ?? full.split("/").pop() ?? "");
    return {
      platform,
      owner,
      name,
      fullName: full || `${owner}/${name}`,
      defaultBranch: String(r.default_branch ?? ""),
      private: String(r.visibility ?? "") !== "public",
      updatedAt: String(r.last_activity_at ?? ""),
    };
  });
}

/* ============================================================================
 * Workers 的「仓库」：Workers Builds 没有官方 API（文档 404，只有 dashboard 路径），
 * 所以这一块只做本机记录 —— 记下 owner/repo/分支，跳 dashboard 真连。不构建、不冒充已连接。
 * ========================================================================== */

export interface WorkerRepoLink {
  platform: GitPlatform;
  owner: string;
  repo: string;
  branch: string;
  savedAt: number;
}

const WORKER_REPO_KEY = "cfconsole.worker.repos.v1";
const workerRepoKey = (account: string, worker: string) => `${account}|${worker}`;

/** 读整表：localStorage 里只有「账号|Worker → 记录」，没有代码/令牌，丢了也只是重新填一次 */
function readWorkerRepos(): Record<string, WorkerRepoLink> {
  try {
    const raw = localStorage.getItem(WORKER_REPO_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function getWorkerRepo(account: string, worker: string): WorkerRepoLink | null {
  return readWorkerRepos()[workerRepoKey(account, worker)] ?? null;
}

export function saveWorkerRepo(account: string, worker: string, link: Omit<WorkerRepoLink, "savedAt">): void {
  const all = readWorkerRepos();
  all[workerRepoKey(account, worker)] = { ...link, savedAt: Date.now() };
  localStorage.setItem(WORKER_REPO_KEY, JSON.stringify(all));
}

export function removeWorkerRepo(account: string, worker: string): void {
  const all = readWorkerRepos();
  delete all[workerRepoKey(account, worker)];
  localStorage.setItem(WORKER_REPO_KEY, JSON.stringify(all));
}

/** Workers 的 dashboard 入口：API 没这条，只能把人送到设置页自己去连 */
export function workerDashboardUrl(account: string, worker: string): string {
  return `https://dash.cloudflare.com/${encodeURIComponent(account)}/workers/services/view/${encodeURIComponent(worker)}/production`;
}
