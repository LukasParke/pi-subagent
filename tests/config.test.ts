import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configFromEnv, defaultConfig, loadConfig, readConfigFile, sanitizeConfigOverrides } from "../src/config.js";

describe("config", () => {
  it("sanitizes untrusted overrides field-by-field", () => {
    const overrides = sanitizeConfigOverrides({
      maxActiveProcesses: 8,
      maxTasksPerRun: "not-a-number",
      maxDepth: -1,
      sessionDir: "  ",
      worktreeDir: "/custom/worktrees",
      unknownKey: true,
    });
    expect(overrides).toEqual({ maxActiveProcesses: 8, worktreeDir: "/custom/worktrees" });
  });

  it("layers defaults <- file <- env", () => {
    const env = { PI_SUBAGENT_MAX_ACTIVE: "6", PI_SUBAGENT_TIMEOUT_MS: "1000" } as NodeJS.ProcessEnv;
    const config = loadConfig({ maxActiveProcesses: 2, maxTasksPerRun: 4 }, env);
    expect(config.maxActiveProcesses).toBe(6); // env wins over file
    expect(config.maxTasksPerRun).toBe(4); // file wins over default
    expect(config.defaultTimeoutMs).toBe(1000);
    expect(config.maxQueuedTasks).toBe(defaultConfig.maxQueuedTasks);
  });

  it("ignores malformed env values", () => {
    const env = { PI_SUBAGENT_MAX_ACTIVE: "zero", PI_SUBAGENT_MAX_DEPTH: "-5" } as NodeJS.ProcessEnv;
    expect(configFromEnv(env)).toEqual({});
  });

  it("reads and sanitizes the config file, tolerating absence and bad JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-config-"));
    try {
      expect(await readConfigFile(path.join(dir, "missing.json"))).toEqual({});
      const bad = path.join(dir, "bad.json");
      await fs.writeFile(bad, "{not json");
      expect(await readConfigFile(bad)).toEqual({});
      const good = path.join(dir, "good.json");
      await fs.writeFile(good, JSON.stringify({ maxActiveProcesses: 2, nonsense: 1 }));
      expect(await readConfigFile(good)).toEqual({ maxActiveProcesses: 2 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps worktrees outside the OS tmpdir by default", () => {
    expect(defaultConfig.worktreeDir.startsWith(os.tmpdir())).toBe(false);
    expect(defaultConfig.worktreeDir).toContain(".pi");
  });

  it("exposes machine-wide lock and global concurrency defaults", () => {
    expect(defaultConfig.lockDir).toContain(".pi");
    expect(defaultConfig.lockDir).toContain("subagent-locks");
    expect(defaultConfig.maxGlobalActive).toBe(16);
    expect(defaultConfig.lockRetentionDays).toBe(7);
    const env = {
      PI_SUBAGENT_MAX_GLOBAL_ACTIVE: "32",
      PI_SUBAGENT_LOCK_DIR: "/tmp/locks",
    } as NodeJS.ProcessEnv;
    const config = loadConfig({}, env);
    expect(config.maxGlobalActive).toBe(32);
    expect(config.lockDir).toBe("/tmp/locks");
  });

  it("sanitizes per-profile taskDefaults field-by-field", () => {
    const sanitized = sanitizeConfigOverrides({
      taskDefaults: {
        explore: { model: "openrouter/kimi-k2.6", thinking: "medium", maxTurns: 12, maxCost: 0.2, timeoutMs: 600000 },
        review: { thinking: "bogus-level", maxTurns: -5, junk: true },
        general: { model: "   " },
        bogusProfile: { model: "x" },
      },
    });
    expect(sanitized.taskDefaults?.explore).toEqual({
      model: "openrouter/kimi-k2.6",
      thinking: "medium",
      maxTurns: 12,
      maxCost: 0.2,
      timeoutMs: 600000,
    });
    // Invalid fields dropped; a profile with nothing valid left is omitted.
    expect(sanitized.taskDefaults?.review).toBeUndefined();
    expect(sanitized.taskDefaults?.general).toBeUndefined();
    expect((sanitized.taskDefaults as any)?.bogusProfile).toBeUndefined();

    // Entirely invalid taskDefaults → key omitted.
    expect(sanitizeConfigOverrides({ taskDefaults: "nope" }).taskDefaults).toBeUndefined();
    expect(sanitizeConfigOverrides({ taskDefaults: {} }).taskDefaults).toBeUndefined();
  });

  it("defaults widget and notifications, accepts overrides, drops invalid values", () => {
    expect(defaultConfig.widget).toBe("background");
    expect(defaultConfig.notifications).toBe("batched");

    expect(sanitizeConfigOverrides({
      widget: "off",
      notifications: "off",
    })).toEqual({ widget: "off", notifications: "off" });

    // invalid modes fall back to omitted (defaults apply at loadConfig)
    expect(sanitizeConfigOverrides({
      widget: "always",
      notifications: true,
      maxRetries: 2,
    })).toEqual({ maxRetries: 2 });

    const env = {
      PI_SUBAGENT_WIDGET: "off",
      PI_SUBAGENT_NOTIFICATIONS: "off",
    } as NodeJS.ProcessEnv;
    expect(configFromEnv(env)).toEqual({ widget: "off", notifications: "off" });

    // malformed env ignored so loadConfig keeps defaults
    const badEnv = {
      PI_SUBAGENT_WIDGET: "maybe",
      PI_SUBAGENT_NOTIFICATIONS: "spam",
    } as NodeJS.ProcessEnv;
    expect(configFromEnv(badEnv)).toEqual({});
    const loaded = loadConfig({}, badEnv);
    expect(loaded.widget).toBe("background");
    expect(loaded.notifications).toBe("batched");

    const fileAndEnv = loadConfig(
      { widget: "off", notifications: "off" },
      { PI_SUBAGENT_WIDGET: "background" } as NodeJS.ProcessEnv,
    );
    expect(fileAndEnv.widget).toBe("background"); // env wins
    expect(fileAndEnv.notifications).toBe("off"); // file, no env override
  });
});
