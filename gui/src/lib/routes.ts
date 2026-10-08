/** 画面と URL の対応(docs/structure.md の画面一覧) */
export type Route =
  | { name: "dashboard" }
  | { name: "task"; id: number }
  | { name: "artifact"; taskId: number; id: number }
  | { name: "run"; id: number }
  | { name: "project"; id: number }
  | { name: "notFound" };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "dashboard" };
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
  task: (id: number) => `/tasks/${id}`,
  artifact: (taskId: number, id: number) => `/tasks/${taskId}/artifacts/${id}`,
  run: (id: number) => `/runs/${id}`,
  project: (id: number) => `/projects/${id}`,
};
