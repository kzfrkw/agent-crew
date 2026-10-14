import type { ReactNode } from "react";
import { Layout } from "./components/Layout.tsx";
import { Empty } from "./components/Status.tsx";
import { matchRoute, type Route } from "./lib/routes.ts";
import { usePath } from "./lib/router.tsx";
import { ArtifactPage } from "./pages/ArtifactPage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { NewProjectPage } from "./pages/NewProjectPage.tsx";
import { NewTaskPage } from "./pages/NewTaskPage.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { RunPage } from "./pages/RunPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";

/** 画面の振り分けだけを行う(docs/structure.md の画面一覧) */
export function App() {
  const route = matchRoute(usePath());
  const projectId = route.name === "project" ? route.id : route.name === "newTask" || route.name === "newPlan" ? route.projectId : undefined;
  return <Layout projectId={projectId}>{page(route)}</Layout>;
}

function page(route: Route): ReactNode {
  switch (route.name) {
    case "dashboard":
      return <Dashboard />;
    case "newTask":
      return <NewTaskPage key={`t${route.projectId}`} projectId={route.projectId} kind="normal" />;
    case "newPlan":
      return <NewTaskPage key={`p${route.projectId}`} projectId={route.projectId} kind="planning" />;
    case "newProject":
      return <NewProjectPage />;
    case "chooseProject":
      return <Empty>チケットや企画は、プロジェクトの画面から作ります。ヘッダーでプロジェクトを選んでください</Empty>;
    case "task":
      return <TaskPage key={route.id} id={route.id} />;
    case "artifact":
      return <ArtifactPage key={route.id} taskId={route.taskId} id={route.id} />;
    case "run":
      return <RunPage key={route.id} id={route.id} />;
    case "project":
      return <ProjectPage key={route.id} id={route.id} />;
    case "notFound":
      return <Empty>ページが見つかりません</Empty>;
  }
}
