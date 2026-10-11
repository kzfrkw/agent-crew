import { parse as parseYaml } from "yaml";

/** 成果物の先頭の frontmatter(--- で囲んだ YAML)と本文に分ける。壊れた frontmatter はそのまま本文として扱う */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  try {
    const fm = parseYaml(m[1]!);
    if (fm && typeof fm === "object" && !Array.isArray(fm)) return { frontmatter: fm as Record<string, unknown>, body: text.slice(m[0].length) };
  } catch {
    // 壊れた frontmatter はそのまま本文として見せる
  }
  return { frontmatter: null, body: text };
}
