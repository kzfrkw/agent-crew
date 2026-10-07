import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/index.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;

describe("CLI の骨組み", () => {
  it("createProgram は package.json のバージョンを持つ", () => {
    expect(createProgram().version()).toBe(pkg.version);
  });

  it("bin から --version を表示できる", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(pkg.version);
  });

  it("bin から --help を表示できる", () => {
    const out = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(out).toContain("Usage: agent-crew");
  });
});
