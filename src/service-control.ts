import { exec } from "child_process";
import fs from "fs";
import os from "os";

export type RestartManager = "launchd" | "systemd-user" | "systemd-system" | "none";

export interface RestartPlanOptions {
  platform?: NodeJS.Platform;
  uid?: number | null;
  hasSystemd?: boolean;
  serviceName?: string;
  launchdLabel?: string;
}

export interface RestartPlan {
  manager: RestartManager;
  command: string | null;
  reason?: string;
}

export interface RestartResult extends RestartPlan {
  ok: boolean;
  error?: string;
}

function detectSystemdOnLinux(): boolean {
  try {
    const init = fs.readFileSync("/proc/1/comm", "utf-8").trim();
    return init === "systemd";
  } catch {
    return false;
  }
}

export function getRestartPlan(options: RestartPlanOptions = {}): RestartPlan {
  const platform = options.platform ?? os.platform();
  const uid = options.uid ?? process.getuid?.() ?? null;
  const hasSystemd = options.hasSystemd ?? (platform === "linux" ? detectSystemdOnLinux() : false);
  const serviceName = options.serviceName ?? process.env.NANOCLAW_SERVICE_NAME ?? "nanoclaw";
  const launchdLabel = options.launchdLabel ?? process.env.NANOCLAW_LAUNCHD_LABEL ?? "com.nanoclaw";

  if (platform === "darwin") {
    if (uid == null) {
      return {
        manager: "none",
        command: null,
        reason: "launchd restart requires a numeric uid",
      };
    }

    return {
      manager: "launchd",
      command: `launchctl kickstart -k gui/${uid}/${launchdLabel}`,
    };
  }

  if (platform === "linux") {
    if (!hasSystemd) {
      return {
        manager: "none",
        command: null,
        reason: "systemd not detected on this host",
      };
    }

    if (uid === 0) {
      return {
        manager: "systemd-system",
        command: `systemctl restart ${serviceName}`,
      };
    }

    return {
      manager: "systemd-user",
      command: `systemctl --user restart ${serviceName}`,
    };
  }

  return {
    manager: "none",
    command: null,
    reason: `unsupported platform: ${platform}`,
  };
}

export async function restartNanoClawService(plan = getRestartPlan()): Promise<RestartResult> {
  const command = plan.command;
  if (!command) {
    return {
      ...plan,
      ok: false,
      error: plan.reason,
    };
  }

  return new Promise<RestartResult>((resolve) => {
    exec(command, (err) => {
      if (err) {
        resolve({
          ...plan,
          ok: false,
          error: err.message,
        });
        return;
      }

      resolve({
        ...plan,
        ok: true,
      });
    });
  });
}
