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

const ImplementerExtra = z.object({
  testCommand: z
    .string()
    .nullable()
    .describe("全テストを実行するコマンドを新しく用意・変更した場合だけ書く(テスト基盤整備など)。変えていなければ null"),
});

/** レビュワーの指摘。重大度は roles/reviewer.md の基準で決める。Must があるかどうかが、判定(approve / changes_requested)と一致していなければならない */
export const FindingSchema = z.object({
  severity: z.enum(["must", "should", "nit"]),
  file: z.string().describe("指摘の対象のファイル(リポジトリのルートからの相対パス)"),
  line: z.number().int().positive().nullable().describe("行番号。特定できなければ null"),
  title: z.string().describe("指摘の見出し(1文)"),
  detail: z.string().describe("何がなぜ問題か。Must は、具体的な失敗の筋書き(入力 → 結果)を含める"),
  suggestion: z.string().describe("直し方"),
});

const ReviewerExtra = z.object({
  findings: z.array(FindingSchema).describe("指摘の一覧(review.md と同じ順序)。無ければ空配列"),
});

/** 監査担当の、Must 指摘1件ごとの判定。invalid(却下)には、事実と食い違うコードの箇所を根拠に書く */
export const JudgmentSchema = z.object({
  finding: z.number().int().min(0).describe("対象の指摘の番号(入力に示された番号)"),
  result: z.enum(["valid", "invalid", "unverifiable"]),
  evidence: z.string().describe("判定の根拠(ファイルと行、確認した内容)"),
});
export type Judgment = z.infer<typeof JudgmentSchema>;

const AuditorExtra = z.object({
  judgments: z.array(JudgmentSchema).describe("監査した Must 指摘ごとの判定"),
});

export const EXTRA_SCHEMAS: Record<string, z.ZodObject> = {
  implementer: ImplementerExtra,
  profiler: z.object({ profile: ProfileSchema }),
  planner: PlannerExtra,
  reviewer: ReviewerExtra,
  auditor: AuditorExtra,
};
