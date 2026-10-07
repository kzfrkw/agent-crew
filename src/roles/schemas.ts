import { z } from "zod";

/**
 * 役割固有の構造化出力。判定(verdict)と要約(summary)に加えて返させる項目。
 * zod で定義し、--json-schema には z.toJSONSchema で変換して渡す。
 */

/** プロジェクトプロファイル(リポジトリ単位。フェーズ1は1リポジトリなので全体の項目も含む) */
export const ProfileSchema = z.object({
  testInfra: z.enum(["present", "insufficient", "none"]).describe("自動テストの基盤があるか"),
  testInfraNotes: z.string().describe("テスト基盤の種類と、不足している点"),
  conventions: z.string().describe("コーディング規約・構成の要点"),
  qaMethod: z.string().describe("動くアプリで受け入れ条件を確かめる方法"),
  commands: z.object({
    install: z.string().nullable().describe("依存の準備(新しいworktreeで最初に1回実行する)"),
    build: z.string().nullable(),
    test: z.string().nullable().describe("全テストを実行するコマンド。終了コードで合否が分かること"),
    start: z.string().nullable().describe("アプリを起動するコマンド(127.0.0.1 で待ち受けること)"),
  }),
  startUrl: z.string().nullable().describe("起動後に確認するURL(http://127.0.0.1:<port>/ など)"),
});
export type Profile = z.infer<typeof ProfileSchema>;

const PlannerExtra = z.object({
  acceptanceCriteria: z.array(z.string()).describe("受け入れ条件(plan.md と同じもの)"),
  testFirstException: z.boolean().describe("テスト先行の例外にするか(理由は plan.md に書く)"),
});

export const EXTRA_SCHEMAS: Record<string, z.ZodObject> = {
  profiler: z.object({ profile: ProfileSchema }),
  planner: PlannerExtra,
};
