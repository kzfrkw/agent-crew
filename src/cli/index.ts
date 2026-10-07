import { readFileSync } from "node:fs";
import { Command } from "commander";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export function createProgram(): Command {
  return new Command()
    .name("agent-crew")
    .description("役割別のAIエージェントにローカルで開発を進めさせる基盤ツール")
    .version(pkg.version);
}

export async function main(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}
