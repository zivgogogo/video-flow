import { computed, shallowRef } from "vue";
import http from "@/lib/http";

export type SystemUpdateCommit = { shortHash: string; date: string; subject: string };
export type SystemUpdateStatus = {
  supported: boolean;
  reasonCode?: "notLocal" | "notGitRepo" | "notConfigured";
  branch?: string;
  current?: SystemUpdateCommit;
  latest?: SystemUpdateCommit;
  behind: number;
  updateAvailable: boolean;
  applying: boolean;
  error: string;
  restartRequired: boolean;
  checkedAt?: number;
};

export const systemUpdateStatus = shallowRef<SystemUpdateStatus | null>(null);
export const systemUpdateChecking = shallowRef(false);
export const systemUpdateApplying = computed(() => systemUpdateStatus.value?.applying === true);

let polling: number | undefined;
let polls = 0;

function stopPolling() {
  if (polling === undefined) return;
  window.clearInterval(polling);
  polling = undefined;
}

function startPolling() {
  stopPolling();
  polls = 0;
  // ACT: 构建最长约三十分钟，超时后停止轮询，避免服务重启后无限请求。
  polling = window.setInterval(() => {
    polls++;
    if (polls > 900) {
      stopPolling();
      return;
    }
    void readSystemUpdate();
  }, 2000);
}

export async function readSystemUpdate() {
  try {
    const status = await http<SystemUpdateStatus>({ method: "GET", url: "/api/systemUpdate/status" });
    systemUpdateStatus.value = status;
    if (!status.applying) stopPolling();
  } catch {
    // ACT: 更新期间服务可能正在重启，轮询失败保留上次状态，下一次继续。
  }
}

export async function checkSystemUpdate() {
  if (systemUpdateChecking.value) return;
  systemUpdateChecking.value = true;
  try {
    systemUpdateStatus.value = await http<SystemUpdateStatus>({ method: "POST", url: "/api/systemUpdate/check", timeout: 120000 });
  } finally {
    systemUpdateChecking.value = false;
  }
}

export async function applySystemUpdate() {
  const status = await http<SystemUpdateStatus>({ method: "POST", url: "/api/systemUpdate/apply", timeout: 60000 });
  systemUpdateStatus.value = status;
  if (status.applying) startPolling();
}
