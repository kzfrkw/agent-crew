/**
 * エージェントのサンドボックスの中(agent-crew が自分自身を扱うとき。AGENT_CREW_RUN=1)では、sandbox-exec の入れ子や
 * プロセスの検査・停止ができないので、この検査は飛ばす(人の環境・CI で検査する。自己適用 4c で判明)
 */
export const inAgentSandbox = process.env.AGENT_CREW_RUN === "1";
