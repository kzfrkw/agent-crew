// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { ProjectPage } from "./ProjectPage.tsx";

const detail: ProjectDetail = {
  project: { id: 1, name: "agent-crew", profileStatus: "approved", testInfra: "present", allowWithoutTests: false },
  repos: [
    { id: 1, path: "/r/agent-crew", role: "main", defaultBranch: "main", profile: { commands: { install: "npm install", build: null, test: "npm test", start: "npm start -- --port 4310" }, startUrl: "http://127.0.0.1:4310/" }, env: {} },
  ],
  profile: { commands: { install: "npm install", build: null, test: "npm test", start: "npm start -- --port 4310" }, startUrl: "http://127.0.0.1:4310/" },
  profileMd: "# プロファイル",
  decisionsMd: null,
  runs: [],
  tasks: [],
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

describe("プロジェクト画面(複数リポジトリ)", () => {
  it("リポジトリごとに、役割に渡すコマンドと起動のつなぎ方を出す", async () => {
    const multi: ProjectDetail = {
      ...detail,
      repos: [
        { id: 1, path: "/r/api", role: "backend", defaultBranch: "main", profile: { commands: { install: null, build: null, test: "npm test", start: "node api.js" }, startUrl: "http://127.0.0.1:3001/" }, env: {} },
        { id: 2, path: "/r/web", role: "frontend", defaultBranch: "main", profile: { commands: { install: null, build: null, test: "npm test", start: "node web.js" }, startUrl: "http://127.0.0.1:3000/" }, env: { API_URL: "{url:backend}" } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(multi), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ProjectPage id={1} />);
    expect(await screen.findByText("node api.js")).toBeTruthy();
    expect(screen.getByText("node web.js")).toBeTruthy();
    expect(screen.getByText("API_URL={url:backend}")).toBeTruthy();
    expect(screen.getByText(/project set agent-crew --role frontend/)).toBeTruthy();
  });
});
