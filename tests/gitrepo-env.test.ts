import { afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "./helpers/gitrepo.ts";

/** このリポジトリ自身をエージェントが扱うとき(フェーズ4b)、テストがエージェントの環境変数に影響されないこと */
describe("テスト用の git の環境変数", () => {
  const saved = process.env.AGENT_CREW_ROLE;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CREW_ROLE;
    else process.env.AGENT_CREW_ROLE = saved;
  });

  it("エージェントの実行中の印(AGENT_CREW_ROLE)を外す。残るとテストの中のコミットにも trailer が付く", () => {
    process.env.AGENT_CREW_ROLE = "implementer";
    expect(gitEnv().AGENT_CREW_ROLE).toBeUndefined();
  });
});
