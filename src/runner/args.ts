import type { RunSpec } from "./types.ts";

/**
 * claude -p の引数(docs/safety.md 3章の標準形)。
 * プロンプトは引数に入れず標準入力で渡す(--tools / --add-dir は複数値を取るため、後ろの引数を飲み込みうる)。
 */
export function buildClaudeArgs(o: {
  model: string;
  effort?: RunSpec["effort"];
  tools: string[];
  settingsPath: string;
  jsonSchema: object;
  artifactsDir: string;
  maxBudgetUsd: number;
  systemPromptAppend: string;
  resumeSessionId?: string;
}): string[] {
  return [
    "-p",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--settings", o.settingsPath,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--output-format", "stream-json",
    "--verbose",
    "--model", o.model,
    ...(o.effort ? ["--effort", o.effort] : []),
    "--tools", o.tools.join(","),
    "--json-schema", JSON.stringify(o.jsonSchema),
    "--max-budget-usd", String(o.maxBudgetUsd),
    "--append-system-prompt", o.systemPromptAppend,
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    "--add-dir", o.artifactsDir,
  ];
}
