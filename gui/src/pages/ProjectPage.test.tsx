// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../../../src/server/api-types.ts";
import { ProjectPage } from "./ProjectPage.tsx";

const detail: ProjectDetail = {
  project: { id: 1, name: "agent-crew", profileStatus: "approved", testInfra: "present", allowWithoutTests: false },
  repos: [{ id: 1, path: "/r/agent-crew", role: "main", defaultBranch: "main" }],
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
