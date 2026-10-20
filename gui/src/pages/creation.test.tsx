// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Overview, ProjectDetail } from "../../../src/server/api-types.ts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "../components/Layout.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { NewProjectPage } from "./NewProjectPage.tsx";
import { NewTaskPage } from "./NewTaskPage.tsx";
import { ProjectPage } from "./ProjectPage.tsx";

/** チケット・企画はプロジェクトから作る(docs/structure.md「フェーズ9: プロジェクトから作る」) */

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: (url: string, init: RequestInit) => { status: number; body: unknown };

const project = (id: number, name: string, repoCount: number) => ({ id, name, profileStatus: repoCount ? "approved" : "none", testInfra: "present", allowWithoutTests: false, repoCount, activeTasks: 0 });
const overview: Overview = {
  worker: { state: "running", active: [] },
  usage: null,
  projects: [project(1, "shop", 1), project(2, "kakeibo", 0)],
  tasks: [],
  running: [],
  stateLabels: {} as Overview["stateLabels"],
};
const detail = (id: number, name: string, repos: number): ProjectDetail => ({
  project: project(id, name, repos),
  settings: { integrate: "pr", autoApprovePlan: false, retrospective: true, coordinator: false, explain: true, workspace: "worktree" },
  operable: true,
  glossaryMd: null,
  repos: Array.from({ length: repos }, (_, i) => ({ id: i + 1, path: `/r/${name}`, role: "main", defaultBranch: "main", profile: null, env: {}, protect: [] })),
  profile: null,
  profileMd: null,
  decisionsMd: null,
  runs: [],
  tasks: [],
});

beforeEach(() => {
  calls = [];
  reply = (url) => {
    if (url === "/api/projects/1") return { status: 200, body: detail(1, "shop", 1) };
    if (url === "/api/projects/2") return { status: 200, body: detail(2, "kakeibo", 0) };
    if (url.startsWith("/api/events")) return { status: 200, body: { events: [], lastId: 0 } };
    return { status: 200, body: overview };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = reply(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () => calls.filter((c) => c.init.method === "POST").map((c) => ({ url: c.url, body: JSON.parse(String(c.init.body)) }));
const withPost = (status: number, body: unknown) => {
  const base = reply;
  reply = (url, init) => (init.method === "POST" ? { status, body } : base(url, init));
};

describe("チケットを作る(プロジェクトから)", () => {
  it("プロジェクトは見出しに出し、タイトル・本文・取り込み元を送って作ったタスクへ移る", async () => {
    withPost(201, { task: { id: 42 } });
    window.history.pushState(null, "", "/projects/1/tasks/new");
    render(<NewTaskPage projectId={1} kind="normal" />);
    expect(await screen.findByText(/チケットを作る — shop/)).toBeTruthy();
    expect(screen.queryByLabelText("プロジェクト")).toBeNull();
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検索を追加" } });
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "部分一致で" } });
    fireEvent.change(screen.getByLabelText(/取り込み元/), { target: { value: "https://www.notion.so/x" } });
    fireEvent.click(screen.getByRole("button", { name: "作成する" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/42"));
    expect(posts()[0]).toEqual({ url: "/api/tasks", body: { projectId: 1, title: "検索を追加", body: "部分一致で", sourceUrl: "https://www.notion.so/x" } });
  });

  it("企画を作るでは、種類と読ませる資料(1行に1つ)を送る", async () => {
    withPost(201, { task: { id: 43 } });
    render(<NewTaskPage projectId={2} kind="planning" />);
    expect(await screen.findByText(/企画を作る — kakeibo/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "家計簿の共有" } });
    fireEvent.change(screen.getByLabelText(/読ませる資料/), { target: { value: "/Users/me/docs\n/Users/me/memo.md\n" } });
    fireEvent.click(screen.getByRole("button", { name: "作成する" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/43"));
    expect(posts()[0]!.body).toMatchObject({ projectId: 2, kind: "planning", docs: ["/Users/me/docs", "/Users/me/memo.md"] });
  });

  it("リポジトリの無いプロジェクトでチケットを作ろうとしたら、企画を作るよう案内する", async () => {
    render(<NewTaskPage projectId={2} kind="normal" />);
    expect(await screen.findByText(/リポジトリがありません/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /企画を作る/ }).getAttribute("href")).toBe("/projects/2/plans/new");
  });

  it("タイトルが空なら送らない", async () => {
    render(<NewTaskPage projectId={1} kind="normal" />);
    await screen.findByText(/チケットを作る — shop/);
    fireEvent.click(screen.getByRole("button", { name: "作成する" }));
    expect(screen.getByRole("alert").textContent).toContain("タイトル");
    expect(posts()).toEqual([]);
  });
});

describe("プロジェクトを作る", () => {
  it("企画用は名前だけで作り、プロジェクト画面へ移る。リポジトリの登録は CLI のコマンドを示す", async () => {
    withPost(201, { project: project(9, "newsvc", 0) });
    render(<NewProjectPage />);
    expect(screen.getByText(/npx agent-crew project add/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("企画用のプロジェクトの名前"), { target: { value: "newsvc" } });
    fireEvent.click(screen.getByRole("button", { name: "作る" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/9"));
    expect(posts()[0]).toEqual({ url: "/api/projects", body: { name: "newsvc" } });
  });
});

describe("プロジェクト画面の作成ボタン", () => {
  it("リポジトリがあれば「+ チケット」と「+ 企画」、無ければ「+ 企画」だけ", async () => {
    render(<ProjectPage id={1} />);
    expect((await screen.findByRole("link", { name: /チケット/ })).getAttribute("href")).toBe("/projects/1/tasks/new");
    expect(screen.getByRole("link", { name: /企画/ }).getAttribute("href")).toBe("/projects/1/plans/new");
    cleanup();
    render(<ProjectPage id={2} />);
    expect(await screen.findByRole("link", { name: /企画/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /チケット/ })).toBeNull();
  });
});

describe("ダッシュボードのプロジェクトの欄と、ヘッダー", () => {
  it("プロジェクトの一覧(種類つき)と「+ プロジェクト」を出す", async () => {
    render(<Dashboard />);
    expect((await screen.findAllByRole("link", { name: "kakeibo" })).map((a) => a.getAttribute("href"))).toContain("/projects/2");
    expect(screen.getByText("企画用")).toBeTruthy();
    expect(screen.getByRole("link", { name: /プロジェクト/ }).getAttribute("href")).toBe("/projects/new");
  });

  it("ヘッダーの「+ チケット」は、プロジェクトを選んでいるときだけ出る(企画用なら企画の作成へ)", async () => {
    render(
      <TooltipProvider>
        <Layout>中身</Layout>
      </TooltipProvider>,
    );
    await screen.findByLabelText("プロジェクト");
    expect(screen.queryByRole("link", { name: /チケット|企画/ })).toBeNull();
    cleanup();
    render(<Layout projectId={2}>中身</Layout>);
    expect((await screen.findByRole("link", { name: /企画/ })).getAttribute("href")).toBe("/projects/2/plans/new");
    cleanup();
    render(<Layout projectId={1}>中身</Layout>);
    expect((await screen.findByRole("link", { name: /チケット/ })).getAttribute("href")).toBe("/projects/1/tasks/new");
  });
});
