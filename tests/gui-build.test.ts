import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guiBuildState } from "../src/server/gui-build.ts";
import { tempDir } from "./helpers/gitrepo.ts";

function setup() {
  const root = tempDir("agent-crew-guibuild-");
  mkdirSync(join(root, "gui", "src"), { recursive: true });
  mkdirSync(join(root, "gui", "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "gui", "src", "a.tsx"), "");
  writeFileSync(join(root, "shared.ts"), "");
  const out = join(root, "dist", "gui");
  const o = { sources: [join(root, "gui"), join(root, "shared.ts")], outDir: out };
  return { root, out, o };
}

const at = (path: string, sec: number) => utimesSync(path, sec, sec);

describe("guiBuildState", () => {
  it("ビルドが無ければ missing", () => {
    const { o } = setup();
    expect(guiBuildState(o)).toBe("missing");
  });

  it("ソースより新しければ ok、ソースのほうが新しければ stale", () => {
    const { root, out, o } = setup();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), "");
    at(join(root, "gui", "src", "a.tsx"), 1000);
    at(join(root, "shared.ts"), 1000);
    at(join(out, "index.html"), 2000);
    expect(guiBuildState(o)).toBe("ok");
    at(join(root, "shared.ts"), 3000);
    expect(guiBuildState(o)).toBe("stale");
  });

  it("node_modules の中は見ない", () => {
    const { root, out, o } = setup();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), "");
    writeFileSync(join(root, "gui", "node_modules", "x", "y.js"), "");
    at(join(root, "gui", "src", "a.tsx"), 1000);
    at(join(root, "shared.ts"), 1000);
    at(join(out, "index.html"), 2000);
    at(join(root, "gui", "node_modules", "x", "y.js"), 9000);
    expect(guiBuildState(o)).toBe("ok");
  });
});
