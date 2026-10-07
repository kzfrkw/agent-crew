import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { EXTRA_SCHEMAS } from "./schemas.ts";

/** 役割定義(roles/*.md)。frontmatter に実行条件、本文に役割のプロンプトを書く */
const FrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  tools: z.array(z.string().min(1)).min(1),
  permissions: z.object({
    write: z.enum(["none", "artifacts", "worktree"]),
    bashWritesWorktree: z.boolean().default(false),
    localServer: z.boolean().default(false),
  }),
  verdicts: z.array(z.string().min(1)).min(1),
  output: z.string().optional(),
  timeoutSec: z.number().int().positive().default(1800),
  maxBudgetUsd: z.number().positive().default(5),
  resume: z.boolean().default(false),
});

export type RoleDef = z.infer<typeof FrontmatterSchema> & { prompt: string };
export type RoleOverrides = Record<string, { model?: string; effort?: RoleDef["effort"] }>;

export function defaultRolesDir(): string {
  return new URL("../../roles/", import.meta.url).pathname;
}

const COMMON = "_common.md";

export function loadRoles(dir: string = defaultRolesDir()): Map<string, RoleDef> {
  const commonPath = join(dir, COMMON);
  const common = existsSync(commonPath) ? readFileSync(commonPath, "utf8").trim() : "";
  const roles = new Map<string, RoleDef>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== COMMON).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${file}: 先頭に frontmatter(--- で囲んだ YAML)がありません`);
    const parsed = FrontmatterSchema.safeParse(parseYaml(m[1]!));
    if (!parsed.success) {
      throw new Error(`${file}: 役割定義が不正です: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (parsed.data.name !== basename(file, ".md")) throw new Error(`${file}: name(${parsed.data.name})とファイル名が一致しません`);
    roles.set(parsed.data.name, { ...parsed.data, prompt: [m[2]!.trim(), common].filter(Boolean).join("\n\n") });
  }
  return roles;
}

/** 設定ファイル(config.json の roles)でモデルと effort を上書きする */
export function applyRoleOverrides(roles: Map<string, RoleDef>, overrides: RoleOverrides): Map<string, RoleDef> {
  const out = new Map(roles);
  for (const [name, o] of Object.entries(overrides)) {
    const r = out.get(name);
    if (r) out.set(name, { ...r, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) });
  }
  return out;
}

/** --json-schema に渡す判定のスキーマ */
export function verdictSchemaFor(role: RoleDef): object {
  const base = z.object({
    verdict: z.enum(role.verdicts as [string, ...string[]]),
    summary: z.string().describe("結果の要約(3文以内)。詳細は成果物に書く"),
  });
  const extra = EXTRA_SCHEMAS[role.name];
  // claude の検証器は draft 2020-12 の $schema 宣言を解釈できないため外す
  const { $schema: _, ...schema } = z.toJSONSchema(extra ? base.extend(extra.shape) : base) as Record<string, unknown>;
  return schema;
}

/** 構造化出力を検証して取り出す */
export function parseVerdict(role: RoleDef, output: unknown): { verdict: string; summary: string; extra: Record<string, unknown> } {
  const base = z.object({ verdict: z.enum(role.verdicts as [string, ...string[]]), summary: z.string() });
  const extra = EXTRA_SCHEMAS[role.name];
  const schema = extra ? base.extend(extra.shape) : base;
  const r = schema.safeParse(output);
  if (!r.success) throw new Error(`${role.name} の判定が不正です: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const { verdict, summary, ...rest } = r.data as Record<string, unknown> & { verdict: string; summary: string };
  return { verdict, summary, extra: rest };
}
