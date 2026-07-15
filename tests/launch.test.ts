import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetLaunchCacheForTests,
  createGetPiCommand,
  resolvePiLaunch,
} from "../src/launch.js";

const tmpFiles: string[] = [];

afterEach(() => {
  _resetLaunchCacheForTests();
  for (const file of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
});

describe("resolvePiLaunch", () => {
  it("prefers PI_SUBAGENT_BIN when set", () => {
    const resolved = resolvePiLaunch({ PI_SUBAGENT_BIN: "/opt/custom/pi" }, "/usr/bin/node", [
      "node",
      "/some/entry.js",
    ]);
    expect(resolved).toMatchObject({
      command: "/opt/custom/pi",
      argsPrefix: [],
      source: "env",
    });
  });

  it("uses process.execPath + argv[1] when the entry is a real JS file", () => {
    const entry = path.join(os.tmpdir(), `pi-subagent-entry-${Date.now()}.mjs`);
    fs.writeFileSync(entry, "export {}\n");
    tmpFiles.push(entry);
    const resolved = resolvePiLaunch({}, "/usr/local/bin/node", ["node", entry]);
    expect(resolved.source).toBe("exec-path");
    expect(resolved.command).toBe("/usr/local/bin/node");
    expect(resolved.argsPrefix).toEqual([fs.realpathSync(path.resolve(entry))]);
  });

  it("follows extensionless bin symlinks to the real JS entry (npm/Homebrew shims)", () => {
    const target = path.join(os.tmpdir(), `pi-subagent-cli-${Date.now()}.js`);
    const shim = path.join(os.tmpdir(), `pi-subagent-shim-${Date.now()}`);
    fs.writeFileSync(target, "module.exports = {}\n");
    fs.symlinkSync(target, shim);
    tmpFiles.push(shim, target);
    const resolved = resolvePiLaunch({}, "/usr/local/bin/node", ["node", shim]);
    expect(resolved.source).toBe("exec-path");
    expect(resolved.command).toBe("/usr/local/bin/node");
    expect(resolved.argsPrefix).toEqual([fs.realpathSync(target)]);
  });

  it("falls back to bare pi when entry is missing", () => {
    const resolved = resolvePiLaunch({}, "/usr/bin/node", ["node", "/no/such/entry.js"]);
    expect(resolved).toMatchObject({ command: "pi", argsPrefix: [], source: "path-fallback" });
  });

  it("createGetPiCommand prefixes args", () => {
    const get = createGetPiCommand({
      command: "/bin/node",
      argsPrefix: ["/app/pi.mjs"],
      source: "exec-path",
    });
    expect(get(["--mode", "json"])).toEqual({
      command: "/bin/node",
      args: ["/app/pi.mjs", "--mode", "json"],
    });
  });
});
