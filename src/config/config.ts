import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** データディレクトリ(DB、成果物、worktree、PC固有の設定)。リポジトリの外に置く */
export function dataHome(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_CREW_HOME ?? join(homedir(), ".agent-team");
}

const ConfigSchema = z.object({
  /** 同時に動かすエージェントの数。利用枠を共有するため、1〜2 から始める */
  concurrency: z.number().int().min(1).max(2).default(1),
  /** claude コマンドのパス(テストでは偽のスクリプトに差し替える) */
  claudePath: z.string().min(1).default("claude"),
  /** 実装後のデザインレビューの撮影に使う Chrome(既定は /Applications の Google Chrome を探す) */
  chromePath: z.string().min(1).optional(),
  /** iOS シミュレータで撮るときの機種(例: "iPhone 17")。既定は最新の iOS が対応する最後の iPhone(フェーズ6) */
  simulatorDevice: z.string().min(1).optional(),
  /** GUI の「エディタで開く」で起動するコマンド。引数には worktree のパスだけを渡す */
  editor: z.string().min(1).default("code"),
  /** タスクが人の対応待ちになったとき、利用枠で自動の一時停止に入ったときに macOS の通知を出す(フェーズ7) */
  notify: z.boolean().default(true),
  limits: z
    .object({
      runTimeoutSec: z.number().int().positive().default(1800),
      runMaxBudgetUsd: z.number().positive().default(5),
      maxReviewRounds: z.number().int().positive().default(3),
      /** 利用枠(5時間・7日の窓)の使用率がこれ以上なら、新しい役割を起動しない(フェーズ7) */
      pauseAtUtilization: z.number().min(0).max(1).default(0.95),
      /** 1タスクあたりの役割の起動回数(コーディネーター自身を含む)と費用の上限。超えると人に回す(フェーズ10、設計メモ v0.21) */
      maxRunsPerTask: z.number().int().positive().default(60),
      maxCostPerTaskUsd: z.number().positive().default(20),
    })
    .prefault({}),
  review: z
    .object({
      /** レビュワーの Must 指摘を、別のエージェント(auditor)が事実確認する。誤検知による差し戻しを減らす代わりに、Must があるときだけ1回余分に動く */
      audit: z.boolean().default(true),
    })
    .prefault({}),
  sandbox: z
    .object({
      allowedDomains: z.array(z.string()).default(["registry.npmjs.org"]),
    })
    .prefault({}),
  /** 役割ごとのモデル・effort の上書き(roles/*.md を書き換えずに調整する) */
  roles: z
    .record(z.string(), z.object({ model: z.string().optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() }))
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function loadConfig(home: string = dataHome()): Config {
  const path = configPath(home);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`設定ファイルを読めません: ${path}: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`設定ファイルが不正です: ${path}: ${detail}`);
  }
  return parsed.data;
}
