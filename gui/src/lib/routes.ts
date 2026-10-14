/** 画面と URL の対応(docs/structure.md の画面一覧) */
export type Route =
  | { name: "dashboard" }
  | { name: "chooseProject" }
  | { name: "newProject" }
  | { name: "newTask"; projectId: number }
  | { name: "newPlan"; projectId: number }
  | { name: "task"; id: number }
  | { name: "artifact"; taskId: number; id: number }
  | { name: "run"; id: number }
  | { name: "project"; id: number }
  | { name: "notFound" };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "dashboard" };
  // チケット・企画はプロジェクトから作る(フェーズ9)。以前の /tasks/new はプロジェクトを選ぶ案内にする
  if (p === "/tasks/new") return { name: "chooseProject" };
  if (p === "/projects/new") return { name: "newProject" };
  const n = /^\/projects\/(\d+)\/(tasks|plans)\/new$/.exec(p);
  if (n) return { name: n[2] === "tasks" ? "newTask" : "newPlan", projectId: Number(n[1]) };
  let m = /^\/tasks\/(\d+)$/.exec(p);
  if (m) return { name: "task", id: Number(m[1]) };
  m = /^\/tasks\/(\d+)\/artifacts\/(\d+)$/.exec(p);
  if (m) return { name: "artifact", taskId: Number(m[1]), id: Number(m[2]) };
  m = /^\/runs\/(\d+)$/.exec(p);
  if (m) return { name: "run", id: Number(m[1]) };
  m = /^\/projects\/(\d+)$/.exec(p);
  if (m) return { name: "project", id: Number(m[1]) };
  return { name: "notFound" };
}

export const paths = {
  dashboard: () => "/",
  newProject: () => "/projects/new",
  newTask: (projectId: number) => `/projects/${projectId}/tasks/new`,
  newPlan: (projectId: number) => `/projects/${projectId}/plans/new`,
  task: (id: number) => `/tasks/${id}`,
  artifact: (taskId: number, id: number) => `/tasks/${taskId}/artifacts/${id}`,
  run: (id: number) => `/runs/${id}`,
  project: (id: number) => `/projects/${id}`,
};
