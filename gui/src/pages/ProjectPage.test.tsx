// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { ProjectPage } from "./ProjectPage.tsx";

const detail: ProjectDetail = {
  project: { id: 1, name: "agent-crew", profileStatus: "approved", testInfra: "present", allowWithoutTests: false, repoCount: 1, activeTasks: 0 },
  repos: [
    { id: 1, path: "/r/agent-crew", role: "main", defaultBranch: "main", profile: { commands: { install: "npm install", build: null, test: "npm test", start: "npm start -- --port 4310" }, startUrl: "http://127.0.0.1:4310/" }, env: {}, protect: [] },
  ],
  profile: { commands: { install: "npm install", build: null, test: "npm test", start: "npm start -- --port 4310" }, startUrl: "http://127.0.0.1:4310/" },
  profileMd: "# プロファイル",
  decisionsMd: null,
  runs: [],
  tasks: [],
  settings: { integrate: "pr", autoApprovePlan: false, retrospective: true, coordinator: false, explain: true, workspace: "worktree" },
  operable: true,
  glossaryMd: "- **ページング**: 一覧を一定件数ずつに分けて返すこと(#3)",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("プロジェクト画面", () => {
  it("役割に渡すコマンド(正本は DB のプロファイル)と、直し方を出す", async () => {
    render(<ProjectPage id={1} />);
    expect(await screen.findByText("役割に渡すコマンド")).toBeTruthy();
    expect(screen.getByText("npm start -- --port 4310")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4310/")).toBeTruthy();
    expect(screen.getByText(/agent-crew project set agent-crew/)).toBeTruthy();
  });
});

describe("リポジトリの欄", () => {
  it("ベースのブランチを説明つきで出す。リポジトリが1つだけなら、区別する名前の行は出さない", async () => {
    render(<ProjectPage id={1} />);
    expect(await screen.findByText("ベースのブランチ")).toBeTruthy();
    expect(screen.queryByText("名前")).toBeNull();
    expect(screen.getByText(/タスクのブランチはここから作り/)).toBeTruthy();
    expect(screen.queryByText("役目")).toBeNull();
    expect(screen.queryByText("既定")).toBeNull();
  });

  it("リポジトリが無い(企画用の)プロジェクトでは、そう書く", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...detail, repos: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ProjectPage id={1} />);
    expect(await screen.findByText(/リポジトリはまだありません/)).toBeTruthy();
  });
});

describe("プロジェクト画面(複数リポジトリ)", () => {
  it("リポジトリごとに、役割に渡すコマンドと起動のつなぎ方を出す", async () => {
    const multi: ProjectDetail = {
      ...detail,
      repos: [
        { id: 1, path: "/r/api", role: "backend", defaultBranch: "main", profile: { commands: { install: null, build: null, test: "npm test", start: "node api.js" }, startUrl: "http://127.0.0.1:3001/" }, env: {}, protect: [] },
        { id: 2, path: "/r/web", role: "frontend", defaultBranch: "main", profile: { commands: { install: null, build: null, test: "npm test", start: "node web.js" }, startUrl: "http://127.0.0.1:3000/" }, env: { API_URL: "{url:backend}" }, protect: ["secrets"] },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(multi), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ProjectPage id={1} />);
    expect(await screen.findByText("node api.js")).toBeTruthy();
    expect(screen.getByText("node web.js")).toBeTruthy();
    expect(screen.getAllByText("名前")).toHaveLength(2); // 複数リポジトリでは区別する名前を出す
    expect(screen.getByText("API_URL={url:backend}")).toBeTruthy();
    expect(screen.getByText("secrets")).toBeTruthy(); // 読ませないパス(7-4)
    expect(screen.getByText(/project set agent-crew --role frontend/)).toBeTruthy();
  });
});

describe("プロジェクト画面(Flutter、フェーズ6)", () => {
  it("Flutter のリポジトリは種類と静的解析のコマンドを出す。web では種類の行を出さない", async () => {
    const flutter: ProjectDetail = {
      ...detail,
      repos: [{ id: 1, path: "/r/app", role: "main", defaultBranch: "main", profile: { platform: "flutter", commands: { install: "flutter pub get", build: null, test: "flutter test", start: null, analyze: "flutter analyze" }, startUrl: null }, env: {}, protect: [] }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(flutter), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ProjectPage id={1} />);
    expect(await screen.findByText("flutter analyze")).toBeTruthy();
    expect(screen.getByText("Flutter(iOS)")).toBeTruthy();
  });
});

describe("プロファイルの承認(フェーズ9: GUI から)", () => {
  const stub = (d: ProjectDetail) => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "POST") {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ message: "承認しました", project: d.project }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return posts;
  };
  const run = (state: "running" | "failed", error: string | null = null) =>
    ({ id: 5, taskId: null, projectId: 1, role: "profiler", model: null, state, verdict: null, summary: null, error, costUsd: null, startedAt: "2026-10-15T00:00:00Z", endedAt: null, durationSec: null }) as unknown as ProjectDetail["runs"][number];

  it("承認待ちなら、テスト基盤を待たずに始めるかを選んで承認できる", async () => {
    const posts = stub({ ...detail, project: { ...detail.project, profileStatus: "draft", testInfra: "none" } });
    render(<ProjectPage id={1} />);
    fireEvent.click(await screen.findByLabelText(/整備を待たずに開発を始める/));
    fireEvent.click(screen.getByRole("button", { name: "プロファイルを承認する" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/projects/1/profile", body: { action: "approve", allowWithoutTests: true } });
  });

  it("作っている間はその旨を、失敗したら理由と「作り直す」を出す", async () => {
    stub({ ...detail, project: { ...detail.project, profileStatus: "none" }, runs: [run("running")] });
    render(<ProjectPage id={1} />);
    expect(await screen.findByText(/プロジェクト把握担当がプロファイルを作っています/)).toBeTruthy();
    cleanup();
    const posts = stub({ ...detail, project: { ...detail.project, profileStatus: "none" }, runs: [run("failed", "時間切れ")] });
    render(<ProjectPage id={1} />);
    expect(await screen.findByText(/時間切れ/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "作り直す" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ action: "reprofile" });
  });
});

describe("作業場所(v0.25)", () => {
  it("作業場所を2択で出し、選ぶと設定を送る", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? { settings: { ...detail.settings, workspace: "repo" } } : detail), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage id={1} />);
    expect(((await screen.findByRole("radio", { name: /worktree/ })) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /リポジトリで直接/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, i]) => i?.method === "POST")![1]!.body))).toEqual({ workspace: "repo" });
  });
});

describe("解説と用語集(v0.24)", () => {
  it("設定に「解説を作る」があり、用語集を出す", async () => {
    render(<ProjectPage id={1} />);
    expect(((await screen.findByRole("checkbox", { name: /解説を作る/ })) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("heading", { name: "用語集" })).toBeTruthy();
    expect(screen.getByText(/一覧を一定件数ずつに分けて返すこと/)).toBeTruthy();
  });
});

describe("設定の欄(v0.23)", () => {
  it("取り込み方を2択で出し、選ぶと設定を送る。ほかの設定はチェックで切り替える", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? { message: "設定を変えました", settings: { ...detail.settings, integrate: "main" } } : detail), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage id={1} />);
    const pr = (await screen.findByRole("radio", { name: /PR を作る/ })) as HTMLInputElement;
    expect(pr.checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /main に取り込む/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(url).toBe("/api/projects/1/settings");
    expect(JSON.parse(String(init!.body))).toEqual({ integrate: "main" });
    fireEvent.click(screen.getByRole("checkbox", { name: /計画の自動承認/ }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(2));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([, i]) => i?.method === "POST")[1]![1]!.body))).toEqual({ autoApprovePlan: true });
  });

  it("読み取り専用では切り替えられず、CLI のコマンドを出す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...detail, operable: false }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ProjectPage id={1} />);
    const pr = (await screen.findByRole("radio", { name: /PR を作る/ })) as HTMLInputElement;
    expect(pr.disabled).toBe(true);
    expect(screen.getByText(/agent-crew project set agent-crew --integrate main/)).toBeTruthy();
  });
});
