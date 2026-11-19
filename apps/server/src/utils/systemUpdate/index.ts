import { resolve } from "node:path";
import type { Request } from "express";
import { stat } from "@toonflow/file";
import { msg, type MessageDescriptor } from "@toonflow/i18n";
import { translateMessage } from "@/lib/i18n";
import { getRuntimePlatform } from "@/lib/platform";

const timeouts = {
  fetch: 120000,
  pull: 300000,
  install: 900000,
  build: 1800000,
};

type CommitInfo = { shortHash: string; date: string; subject: string };
type ReasonCode = "notLocal" | "notGitRepo" | "notConfigured";

let appRoot: string | undefined;
let restartApp: (() => Promise<void>) | undefined;
let currentCommit: CommitInfo | undefined;
let currentBranch: string | undefined;
let latestCommit: CommitInfo | undefined;
let behind = 0;
let checkedAt = 0;
let applying = false;
let failure: MessageDescriptor | string = "";
let failureDetail = "";
let restartRequired = false;

export function setSystemUpdateRoot(directory: string) {
  appRoot = resolve(directory);
}

// ACT: 桌面宿主注册应用内重启；独立服务保持构建后手动重启提示。
export function setSystemUpdateRestart(handler: () => Promise<void>) {
  restartApp = handler;
}

function fail(message: MessageDescriptor, status: number) {
  return Object.assign(new Error(translateMessage(message)), { status, i18nMessage: message });
}

// ACT: 更新会执行 git 与构建命令，只允许服务所在机器的页面触发；经反向代理或跨站发起的请求一律拒绝。
function isLocalRequest(req: Request) {
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (!req.headers.host || new URL(origin).host !== req.headers.host) return false; }
    catch { return false; }
  }
  const address = req.socket.remoteAddress ?? "";
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

async function hasGitDirectory() {
  if (!appRoot) return false;
  const info = await stat(resolve(appRoot, ".git")).catch(() => null);
  return Boolean(info?.isDirectory() || info?.isFile());
}

async function run(command: string[], timeout: number) {
  if (!appRoot) throw fail(msg`当前部署无法自动更新，请参考部署文档手动更新。`, 409);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, {
      cwd: appRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw fail(msg`未找到 ${command[0]} 命令，请先安装后重试。`, 500);
    throw error;
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    const detail = (stderr.trim() || stdout.trim()).slice(-2000);
    throw Object.assign(fail(msg`命令退出码 ${code}`, 500), { detail });
  }
  return stdout.trim();
}

function git(args: string[], timeout: number) {
  return run(["git", ...args], timeout);
}

async function assertRepository() {
  if (!(await hasGitDirectory())) throw fail(msg`当前部署无法自动更新，请参考部署文档手动更新。`, 409);
}

async function readCurrent() {
  if (!currentBranch) {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], 30000);
    if (!branch || branch === "HEAD" || !/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) throw fail(msg`当前代码处于游离 HEAD 状态，无法自动更新。`, 409);
    currentBranch = branch;
  }
  if (!currentCommit) currentCommit = await readCommit("HEAD");
  return currentBranch;
}

async function readCommit(ref: string): Promise<CommitInfo> {
  const [shortHash, date, subject = ""] = (await git(["log", "-1", "--format=%h%n%cI%n%s", ref], 30000)).split("\n");
  return { shortHash, date, subject };
}

export async function getSystemUpdateStatus(req: Request) {
  const supported = Boolean(appRoot) && isLocalRequest(req) && await hasGitDirectory();
  const reasonCode: ReasonCode | undefined = supported ? undefined : !appRoot ? "notConfigured" : !isLocalRequest(req) ? "notLocal" : "notGitRepo";
  if (supported && !currentCommit) {
    await readCurrent().catch(() => {
      // ACT: 状态查询不因版本读取失败而中断，检查更新时会再次给出具体原因。
    });
  }
  return {
    supported,
    reasonCode,
    branch: supported ? currentBranch : undefined,
    current: supported ? currentCommit : undefined,
    latest: supported ? latestCommit : undefined,
    behind: supported ? behind : 0,
    updateAvailable: supported && behind > 0,
    applying: supported && applying,
    error: failure && supported ? [translateMessage(failure), failureDetail].filter(Boolean).join("\n") : "",
    restartRequired: supported && restartRequired,
    checkedAt: supported && checkedAt ? checkedAt : undefined,
  };
}

export async function checkSystemUpdate(req: Request) {
  if (!isLocalRequest(req)) throw fail(msg`请从服务所在机器打开本页面后操作。`, 403);
  await assertRepository();
  if (applying) throw fail(msg`更新正在进行，请稍候。`, 409);
  const branch = await readCurrent();
  await git(["fetch", "--quiet", "origin", branch], timeouts.fetch);
  latestCommit = await readCommit(`origin/${branch}`);
  behind = Number(await git(["rev-list", "--count", `HEAD..origin/${branch}`], 30000)) || 0;
  checkedAt = Date.now();
  failure = "";
  failureDetail = "";
  restartRequired = false;
  return getSystemUpdateStatus(req);
}

export async function applySystemUpdate(req: Request) {
  if (!isLocalRequest(req)) throw fail(msg`请从服务所在机器打开本页面后操作。`, 403);
  await assertRepository();
  if (applying) throw fail(msg`更新正在进行，请稍候。`, 409);
  const branch = await readCurrent();
  if (!checkedAt) await checkSystemUpdate(req);
  if (!behind) return getSystemUpdateStatus(req);
  applying = true;
  failure = "";
  failureDetail = "";
  restartRequired = false;
  // ACT: 单进程内只允许一个更新任务；结果通过状态接口轮询，不等待长时间构建。
  void (async () => {
    await git(["pull", "--ff-only", "origin", branch], timeouts.pull);
    await run([process.execPath, "install", "--frozen-lockfile"], timeouts.install);
    if (getRuntimePlatform().desktop) {
      // ACT: 桌面 dev 的重启脚本会重新执行完整构建，这里不再运行 build:server。
      if (!restartApp) throw fail(msg`当前桌面客户端不支持自动重启更新。`, 409);
      await restartApp();
      return;
    }
    await run([process.execPath, "run", "build:server"], timeouts.build);
    currentCommit = undefined;
    latestCommit = undefined;
    behind = 0;
    checkedAt = 0;
    restartRequired = true;
  })().catch(error => {
    // ACT: 失败时保留已拉取的提交，重新读取真实 HEAD；用户修复环境后可再次点击更新重试构建。
    currentCommit = undefined;
    const failed = error as { i18nMessage?: MessageDescriptor; detail?: string } | null;
    failure = failed?.i18nMessage ?? (error instanceof Error ? error.message : String(error));
    failureDetail = typeof failed?.detail === "string" ? failed.detail : "";
  }).finally(() => {
    applying = false;
  });
  return getSystemUpdateStatus(req);
}
