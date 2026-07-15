import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeCatalog, discoverAgents, parseAgentFile, resolveAgent } from "../src/agents.js";
import { validateSubagentRequest, type ParentContext } from "../src/policy.js";

const REVIEWER = `---
description: Security-focused code reviewer
model: openrouter/x-ai/grok-4.5
thinking: high
profile: review
max_turns: 20
fallback_models: [openrouter/backup-a, openrouter/backup-b]
---

You are a security auditor. Report findings with file:line evidence and severity.
`;

describe("agent file parsing", () => {
  it("parses frontmatter and body into a definition", () => {
    const agent = parseAgentFile("reviewer", REVIEWER, "/x/reviewer.md", "project")!;
    expect(agent.name).toBe("reviewer");
    expect(agent.description).toBe("Security-focused code reviewer");
    expect(agent.model).toBe("openrouter/x-ai/grok-4.5");
    expect(agent.thinking).toBe("high");
    expect(agent.profile).toBe("review");
    expect(agent.maxTurns).toBe(20);
    expect(agent.fallbackModels).toEqual(["openrouter/backup-a", "openrouter/backup-b"]);
    expect(agent.systemPrompt).toContain("security auditor");
  });

  it("tolerates missing frontmatter (body-only persona)", () => {
    const agent = parseAgentFile("scout", "Just explore fast.\n", "/x/scout.md", "global")!;
    expect(agent.description).toBe("scout");
    expect(agent.systemPrompt).toBe("Just explore fast.");
    expect(agent.model).toBeUndefined();
  });

  it("drops invalid enum values instead of failing", () => {
    const agent = parseAgentFile("odd", "---\nthinking: bogus\nprofile: wizard\nisolation: nope\n---\nbody", "/x/odd.md", "project")!;
    expect(agent.thinking).toBeUndefined();
    expect(agent.profile).toBeUndefined();
    expect(agent.isolation).toBeUndefined();
  });

  it("parses tools as comma or bracket lists", () => {
    expect(parseAgentFile("a", "---\ntools: read, grep\n---\nx", "/a.md", "project")!.tools).toEqual(["read", "grep"]);
    expect(parseAgentFile("b", '---\ntools: ["read", "grep"]\n---\nx', "/b.md", "project")!.tools).toEqual(["read", "grep"]);
  });

  it("parses inline output_schema and drops invalid values", () => {
    const inline = parseAgentFile(
      "s",
      '---\noutput_schema: {"type": "object", "required": ["findings"]}\n---\nbody',
      "/s.md",
      "project",
    )!;
    expect(inline.outputSchema).toEqual({ type: "object", required: ["findings"] });

    const invalid = parseAgentFile("t", "---\noutput_schema: not-json\n---\nbody", "/t.md", "project")!;
    expect(invalid.outputSchema).toBeUndefined();
  });
});

describe("agent discovery", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agents-"));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("discovers project and shared agents with project winning name conflicts", async () => {
    await fs.mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".agents", "agents"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\ndescription: project reviewer\n---\nP");
    await fs.writeFile(path.join(cwd, ".agents", "agents", "reviewer.md"), "---\ndescription: shared reviewer\n---\nS");
    await fs.writeFile(path.join(cwd, ".agents", "agents", "scout.md"), "---\ndescription: shared scout\n---\nS2");

    const catalog = discoverAgents(cwd);
    expect(catalog.get("reviewer")!.description).toBe("project reviewer");
    expect(catalog.get("reviewer")!.scope).toBe("project");
    expect(catalog.get("scout")!.scope).toBe("shared");
  });

  it("skips invalid names, non-md files, and oversized files", async () => {
    const dir = path.join(cwd, ".pi", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "..bad..md"), "x");
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    await fs.writeFile(path.join(dir, "big.md"), "y".repeat(70 * 1024));
    await fs.writeFile(path.join(dir, "good.md"), "---\ndescription: fine\n---\nbody");
    const catalog = discoverAgents(cwd);
    expect([...catalog.keys()]).toEqual(["good"]);
  });

  it("returns an empty catalog when no roots exist", () => {
    expect(discoverAgents(cwd).size).toBe(0);
  });

  it("resolves @file.json output_schema references relative to the agent file", async () => {
    const dir = path.join(cwd, ".pi", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "contract.json"), JSON.stringify({ type: "object", required: ["summary"] }));
    await fs.writeFile(path.join(dir, "auditor.md"), "---\ndescription: audits\noutput_schema: @contract.json\n---\nbody");
    const catalog = discoverAgents(cwd);
    expect(catalog.get("auditor")!.outputSchema).toEqual({ type: "object", required: ["summary"] });

    // Missing reference degrades to undefined, not an error.
    await fs.writeFile(path.join(dir, "broken.md"), "---\noutput_schema: @missing.json\n---\nbody");
    expect(discoverAgents(cwd).get("broken")!.outputSchema).toBeUndefined();
  });

  it("resolveAgent is case-insensitive and lists available names on miss", async () => {
    const dir = path.join(cwd, ".pi", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "reviewer.md"), "body");
    const catalog = discoverAgents(cwd);
    expect(resolveAgent(catalog, "REVIEWER").agent?.name).toBe("reviewer");
    const miss = resolveAgent(catalog, "nope");
    expect(miss.error).toContain("reviewer");
  });

  it("describeCatalog produces one routing line per agent", async () => {
    const dir = path.join(cwd, ".pi", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "reviewer.md"), "---\ndescription: reviews code\nprofile: review\nmodel: m/x\n---\nbody");
    const lines = describeCatalog(discoverAgents(cwd));
    expect(lines).toEqual(["reviewer: reviews code (review, m/x)"]);
  });
});

describe("agent resolution in policy", () => {
  const parent: ParentContext = {
    cwd: "/repo",
    model: "parent/model",
    thinking: "low",
    availableTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    depth: 0,
  };

  const catalog = new Map([
    ["reviewer", parseAgentFile("reviewer", REVIEWER, "/x/reviewer.md", "project")!],
  ]);

  it("applies agent defaults with explicit params winning", () => {
    const res = validateSubagentRequest({ task: "review this diff", agent: "reviewer" }, parent, { agents: catalog });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const task = res.tasks[0]!;
    expect(task.model).toBe("openrouter/x-ai/grok-4.5");
    expect(task.thinking).toBe("high");
    expect(task.profile).toBe("review");
    expect(task.canWrite).toBe(false); // review profile is read-only
    expect(task.maxTurns).toBe(20);
    expect(task.fallbackModels).toEqual(["openrouter/backup-a", "openrouter/backup-b"]);
    expect(task.systemPrompt).toContain("security auditor");
    expect(task.label).toBe("reviewer"); // agent name as default label

    const overridden = validateSubagentRequest(
      { task: "x", agent: "reviewer", model: "explicit/model", thinking: "off", max_turns: 5, description: "Custom label" },
      parent,
      { agents: catalog },
    );
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.tasks[0]!.model).toBe("explicit/model");
    expect(overridden.tasks[0]!.thinking).toBe("off");
    expect(overridden.tasks[0]!.maxTurns).toBe(5);
    expect(overridden.tasks[0]!.label).toBe("Custom label");
  });

  it("appends explicit system_prompt after the agent persona", () => {
    const res = validateSubagentRequest(
      { task: "x", agent: "reviewer", system_prompt: "Focus on the auth module only." },
      parent,
      { agents: catalog },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const prompt = res.tasks[0]!.systemPrompt!;
    expect(prompt.indexOf("security auditor")).toBeLessThan(prompt.indexOf("auth module only"));
  });

  it("agent profile beats mode default but explicit profile beats agent", () => {
    // Parallel default is explore; agent says review.
    const par = validateSubagentRequest({ tasks: [{ task: "a", agent: "reviewer" }] }, parent, { agents: catalog });
    expect(par.ok).toBe(true);
    if (par.ok) expect(par.tasks[0]!.profile).toBe("review");

    const explicit = validateSubagentRequest(
      { task: "x", agent: "reviewer", profile: "explore" },
      parent,
      { agents: catalog },
    );
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.tasks[0]!.profile).toBe("explore");
  });

  it("unknown agent fails with the available list", () => {
    const res = validateSubagentRequest({ task: "x", agent: "ghost" }, parent, { agents: catalog });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("reviewer");
  });

  it("agent write-capable tools still fail closed under read-only profiles", () => {
    const writer = new Map([
      ["writer", parseAgentFile("writer", "---\nprofile: review\ntools: read, bash\n---\nbody", "/w.md", "project")!],
    ]);
    const res = validateSubagentRequest({ task: "x", agent: "writer" }, parent, { agents: writer });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/read-only/i);
  });
});
