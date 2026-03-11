import { afterEach, describe, expect, it } from "vitest";

import { getRestartPlan } from "./service-control.js";

describe("service-control", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_SERVICE_NAME;
    delete process.env.NANOCLAW_LAUNCHD_LABEL;
  });

  it("uses launchd kickstart on macOS", () => {
    const plan = getRestartPlan({
      platform: "darwin",
      uid: 501,
    });

    expect(plan).toEqual({
      manager: "launchd",
      command: "launchctl kickstart -k gui/501/com.nanoclaw",
    });
  });

  it("uses systemd --user on Linux for non-root", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-user",
      command: "systemctl --user restart nanoclaw",
    });
  });

  it("uses system-level systemd when running as root", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 0,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-system",
      command: "systemctl restart nanoclaw",
    });
  });

  it("uses configurable service names", () => {
    process.env.NANOCLAW_SERVICE_NAME = "nanoclaw-dev";
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: true,
    });

    expect(plan).toEqual({
      manager: "systemd-user",
      command: "systemctl --user restart nanoclaw-dev",
    });
  });

  it("returns unsupported when systemd is unavailable on Linux", () => {
    const plan = getRestartPlan({
      platform: "linux",
      uid: 1000,
      hasSystemd: false,
    });

    expect(plan.manager).toBe("none");
    expect(plan.command).toBeNull();
    expect(plan.reason).toContain("systemd");
  });
});
