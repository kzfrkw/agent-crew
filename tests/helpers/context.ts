import { DEFAULT_CONFIG, type Config } from "../../src/config/config.ts";
import { openDb } from "../../src/db/connection.ts";
import type { AppContext } from "../../src/orchestrator/context.ts";
import { loadRoles } from "../../src/roles/roles.ts";
import { loadRubrics } from "../../src/roles/rubrics.ts";
import type { Runner } from "../../src/runner/types.ts";
import { gitEnv, tempDir } from "./gitrepo.ts";

export function testContext(runner: Runner, config: Partial<Config> = {}): AppContext {
  return {
    db: openDb(":memory:"),
    home: tempDir("agent-crew-home-"),
    // limits などの入れ子は写す(テストで書き換えても既定値に漏れないように)
    config: { ...DEFAULT_CONFIG, ...config, limits: { ...DEFAULT_CONFIG.limits, ...config.limits }, review: { ...DEFAULT_CONFIG.review, ...config.review }, sandbox: { ...DEFAULT_CONFIG.sandbox, ...config.sandbox } },
    roles: loadRoles(),
    rubrics: loadRubrics(),
    runner,
    gitEnv: gitEnv(),
    notifier: () => {},
  };
}
