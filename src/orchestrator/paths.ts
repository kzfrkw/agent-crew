import { join } from "node:path";

/** データディレクトリの中の置き場所 */
export const projectDir = (home: string, projectId: number) => join(home, "projects", String(projectId));
export const taskDir = (home: string, taskId: number) => join(home, "tasks", String(taskId));
export const runDir = (home: string, runId: number) => join(home, "runs", String(runId));
