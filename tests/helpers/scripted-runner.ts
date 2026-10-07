import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunResult, RunSpec, Runner } from "../../src/runner/types.ts";

export type Script = (spec: RunSpec, call: number) => Partial<RunResult> | void | Promise<Partial<RunResult> | void>;

/** 役割ごとに台本どおり動く偽のランナー(利用枠を使わずにオーケストレーターを試す) */
export class ScriptedRunner implements Runner {
  readonly calls: RunSpec[] = [];
  private readonly scripts: Record<string, Script>;
  private readonly counts = new Map<string, number>();

  constructor(scripts: Record<string, Script>) {
    this.scripts = scripts;
  }

  async run(spec: RunSpec, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    this.calls.push(spec);
    const script = this.scripts[spec.role];
    if (!script) throw new Error(`台本に役割 ${spec.role} がありません`);
    const n = this.counts.get(spec.role) ?? 0;
    this.counts.set(spec.role, n + 1);
    onEvent({ kind: "init", payload: { role: spec.role } });
    const r = (await script(spec, n)) ?? {};
    return { status: "succeeded", models: ["fake"], permissionDenials: [], bashResults: [], durationMs: 1, costUsd: 0.01, sessionId: `s-${spec.role}-${n}`, ...r };
  }

  rolesCalled(): string[] {
    return this.calls.map((c) => c.role);
  }
}

/** 成果物ディレクトリに frontmatter 付きの成果物を書く */
export function writeArtifact(spec: RunSpec, file: string, verdict: string, body = "本文"): void {
  mkdirSync(spec.artifactsDir, { recursive: true });
  writeFileSync(join(spec.artifactsDir, file), `---\nverdict: ${verdict}\n---\n${body}\n`);
}

/** よく使う「成果物を書いて判定を返す」台本 */
export const answer =
  (file: string, verdict: string, extra: Record<string, unknown> = {}): Script =>
  (spec) => {
    writeArtifact(spec, file, verdict);
    return { structuredOutput: { verdict, summary: `${spec.role}: ${verdict}`, ...extra } };
  };
