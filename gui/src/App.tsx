import type { ReactNode } from "react";
import { Layout } from "./components/Layout.tsx";
import { matchRoute, type Route } from "./lib/routes.ts";
import { usePath } from "./lib/router.tsx";
import { ArtifactPage } from "./pages/ArtifactPage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { RunPage } from "./pages/RunPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";

/** 画面の振り分けだけを行う(docs/structure.md の画面一覧) */
export function App() {
  const route = matchRoute(usePath());
  return <Layout projectId={route.name === "project" ? route.id : undefined}>{page(route)}</Layout>;
}

function page(route: Route): ReactNode {
  switch (route.name) {
    case "dashboard":
      return <Dashboard />;
    case "task":
      return <TaskPage key={route.id} id={route.id} />;
    case "artifact":
      return <ArtifactPage key={route.id} taskId={route.taskId} id={route.id} />;
    case "run":
      return <RunPage key={route.id} id={route.id} />;
    case "project":
      return <ProjectPage key={route.id} id={route.id} />;
    case "notFound":
      return <div className="state-msg">ページが見つかりません</div>;
  }
}
