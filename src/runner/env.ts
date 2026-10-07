/**
 * エージェントに渡す環境変数(docs/safety.md 4章)。許可リストの変数だけを渡す。
 * HOME は Claude Code がサブスクのOAuth認証(キーチェーン)を読むために渡す。
 */

const ALLOWED = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TMPDIR", "SHELL"];
const FORBIDDEN = /^(ANTHROPIC_|AWS_|GITHUB_|GH_|CLAUDE)|^SSH_AUTH_SOCK$|TOKEN|SECRET|PASSWORD|_KEY$/;

export function buildAgentEnv(
  parent: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v !== undefined && (ALLOWED.includes(k) || k.startsWith("LC_"))) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (FORBIDDEN.test(k)) throw new Error(`環境変数 ${k} はエージェントに渡せません`);
    env[k] = v;
  }
  env.AGENT_CREW_RUN = "1";
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  return env;
}
