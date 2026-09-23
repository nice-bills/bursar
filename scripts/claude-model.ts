/**
 * Claude as the agent's model, through the local Claude Code CLI.
 *
 * ElizaOS asks for text; this answers by piping the composed prompt to
 * `claude -p`, so the agent thinks with Claude on the operator's existing
 * login — no model API key, no OpenRouter free tier.
 *
 * It is run with every tool disabled, no MCP servers, no settings and no
 * project context. That is load-bearing, not tidiness: Claude Code with a
 * shell could edit bursar.config.json and raise its own limits. Here it can
 * only return text, so the only way it moves money is by choosing an ElizaOS
 * action, and every action goes through the policy engine.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelType, type IAgentRuntime, type Plugin } from "@elizaos/core";

// Outside the repo, so no CLAUDE.md or project settings reach the model.
const CWD = mkdtempSync(join(tmpdir(), "bursar-claude-"));

export const claudeModel = process.env.BURSAR_CLAUDE_MODEL ?? "sonnet";

function ask(prompt: string, system: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", claudeModel,
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--system-prompt", system,
      ],
      { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}

const generate = async (runtime: IAgentRuntime, params: { prompt: string }) =>
  ask(params.prompt, runtime.character.system ?? "");

export const claudeModelPlugin: Plugin = {
  name: "claude-code-model",
  description: "Claude via the local Claude Code CLI, with no tools, as the agent's text model.",
  models: {
    [ModelType.TEXT_SMALL]: generate,
    [ModelType.TEXT_LARGE]: generate,
  },
};
