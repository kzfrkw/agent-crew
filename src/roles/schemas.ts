import { z } from "zod";

/**
 * 役割固有の構造化出力。判定(verdict)と要約(summary)に加えて返させる項目。
 * zod で定義し、--json-schema には z.toJSONSchema で変換して渡す。
 */

/** プロジェクトプロファイル(リポジトリ単位。フェーズ1は1リポジトリなので全体の項目も含む) */
export const ProfileSchema = z.object({
  platform: z.enum(["web", "flutter", "ios"]).default("web").describe("アプリの種類。pubspec.yaml があれば flutter、*.xcodeproj のネイティブ iOS アプリなら ios(フェーズ6)"),
  testInfra: z.enum(["present", "insufficient", "none"]).describe("自動テストの基盤があるか"),
  testInfraNotes: z.string().describe("テスト基盤の種類と、不足している点"),
  conventions: z.string().describe("コーディング規約・構成の要点"),
  qaMethod: z.string().describe("動くアプリで受け入れ条件を確かめる方法"),
  commands: z.object({
    install: z.string().nullable().describe("依存の準備(新しいworktreeで最初に1回実行する)"),
    build: z.string().nullable(),
    test: z.string().nullable().describe("全テストを実行するコマンド。終了コードで合否が分かること"),
    start: z.string().nullable().describe("アプリを起動するコマンド(127.0.0.1 で待ち受けること)"),
    analyze: z.string().nullable().default(null).describe("静的解析のコマンド(flutter analyze など。無ければ null)"),
    screens: z.string().nullable().default(null).describe("ios: 画面を撮る UI テスト(<UIテストのターゲット>/<クラス>。例 OrdersUITests/ScreensUITests)。無ければ null"),
  }),
  startUrl: z.string().nullable().describe("起動後に確認するURL(http://127.0.0.1:<port>/ など)"),
});
/** DB に残るプロファイル。フェーズ6より前のものは platform / commands.analyze を持たない(読むときは platformOf など既定値で補う) */
export type Profile = z.input<typeof ProfileSchema>;

const PlannerExtra = z.object({
  acceptanceCriteria: z.array(z.string()).describe("受け入れ条件(plan.md と同じもの)"),
  testFirstException: z.boolean().describe("テスト先行の例外にするか(理由は plan.md に書く)"),
  design: z
    .object({
      architect: z.boolean().describe("設計者を動かすか(構造の変更、新しいモジュールやインターフェース、複数の選択肢から選ぶ設計判断があるとき)"),
      designer: z.boolean().describe("デザイナーを動かすか(画面・見た目・操作の流れが変わるとき)"),
      reason: z.string().describe("判断の理由(1〜2文)"),
    })
    .describe("実装の前に、設計の段で動かす役割(人が計画の承認時に上書きできる)"),
  repos: z
    .array(z.string())
    .optional()
    .describe("複数リポジトリのプロジェクトのときだけ: 変更するリポジトリの役目を、実装する順に(例: [\"backend\", \"frontend\"])。1リポジトリなら省く"),
  size: z.enum(["small", "medium", "large"]).default("medium").describe("規模。small: 数ファイル・1つの関心ごと、medium: それより大きいが1タスクで済む、large: 分けたほうがよい"),
  expectedFiles: z.array(z.string()).default([]).describe("変更する見込みのファイル(リポジトリのルートからの相対パス。テストも含む)"),
  split: z
    .array(z.object({ title: z.string(), body: z.string().describe("子タスクの本文(やること・受け入れ条件の要点)") }))
    .default([])
    .describe("size が large のときだけ: 子タスクの案(2〜5個。実装する順)。それ以外は空配列"),
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
  repeated: z.boolean().default(false).describe("前回の review.md にあった指摘が、まだ直っていないか(同じ指摘の繰り返し)"),
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

/** 設計者・デザイナー: 今後のタスクでも守るべき判断(オーケストレーターが設計判断ログに追記する) */
const DesignExtra = z.object({
  decisions: z.array(z.string()).describe("設計判断ログに残す、このプロジェクトの重要な判断(1件1文)。なければ空配列"),
});

/** QA: 実装後のデザインレビューで撮ってほしい画面(ui-spec.md の画面。UI を伴うタスクのとき) */
const QaExtra = z.object({
  failedCriteria: z.array(z.string()).default([]).describe("不合格だった受け入れ条件(plan.md の文言のまま)。合格なら空配列"),
  screens: z
    .array(z.object({ path: z.string().describe("起動 URL からのパス(例: /tasks/1)"), note: z.string().describe("何の画面か") }))
    .optional()
    .describe("UI 仕様(ui-spec.md)があるとき、変更された画面を撮るためのパスの一覧。なければ省く"),
});

const RetrospectiveExtra = z.object({
  proposals: z
    .array(z.object({ target: z.enum(["conventions", "decisions"]).describe("規約(conventions)か設計判断(decisions)か"), text: z.string().describe("書き足す内容(1文)") }))
    .describe("提案(多くても5つ)。無ければ空配列"),
});

const CriticExtra = z.object({
  issues: z
    .array(z.object({ severity: z.enum(["must", "should"]), title: z.string().describe("指摘の見出し(1文)"), detail: z.string().describe("何がなぜ問題か、どう直すか") }))
    .describe("指摘の一覧。無ければ空配列"),
});

const HandoffExtra = z.object({
  tickets: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().describe("やること、関係する画面の ID とユーザーストーリー、参照する企画の文書"),
        acceptanceCriteria: z.array(z.string()).describe("受け入れ条件(検証できる形)"),
      }),
    )
    .describe("開発のチケット(実装する順。2〜8枚)"),
});

export const EXTRA_SCHEMAS: Record<string, z.ZodObject> = {
  critic: CriticExtra,
  handoff: HandoffExtra,
  retrospective: RetrospectiveExtra,
  qa: QaExtra,
  architect: DesignExtra,
  designer: DesignExtra,
  implementer: ImplementerExtra,
  profiler: z.object({ profile: ProfileSchema }),
  planner: PlannerExtra,
  reviewer: ReviewerExtra,
  auditor: AuditorExtra,
};
