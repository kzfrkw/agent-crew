import { DEFAULT_CONFIG, type Config } from "../../src/config/config.ts";
import { openDb } from "../../src/db/connection.ts";
import type { AppContext } from "../../src/orchestrator/context.ts";
import { loadRoles } from "../../src/roles/roles.ts";
import type { Runner } from "../../src/runner/types.ts";
import { gitEnv, tempDir } from "./gitrepo.ts";

export function testContext(runner: Runner, config: Partial<Config> = {}): AppContext {
  return {
    db: openDb(":memory:"),
    home: tempDir("agent-crew-home-"),
    config: { ...DEFAULT_CONFIG, ...config },
    roles: loadRoles(),
    runner,
    gitEnv: gitEnv(),
  };
}
