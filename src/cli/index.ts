import { readFileSync } from "node:fs";
import { Command } from "commander";
import { doctor, formatResults } from "../doctor/index.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export function createProgram(): Command {
  const program = new Command()
    .name("agent-crew")
    .description("役割別のAIエージェントにローカルで開発を進めさせる基盤ツール")
    .version(pkg.version);

  program
    .command("doctor")
    .description("前提ツール・認証・安全設定の状態を検査する")
    .option("--json", "結果をJSONで出力する")
    .action((opts: { json?: boolean }) => {
      const results = doctor();
      console.log(opts.json ? JSON.stringify(results, null, 2) : formatResults(results));
      if (results.some((r) => r.level === "error")) process.exitCode = 1;
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}
