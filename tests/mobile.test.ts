import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDevice, leaseSimulator, type Simctl } from "../src/mobile/simulator.ts";
import { captureFlutterScreens, captureIosScreens, type DriveExec, type XcresultExport } from "../src/mobile/capture.ts";
import { git, makeRepo, tempDir } from "./helpers/gitrepo.ts";

/** 1x1 の PNG に、IHDR の幅・高さだけを書いたもの(幅の読み取りの確認用) */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const DEVICES = (extra: object[] = []) =>
  JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [{ name: "iPhone 17", udid: "HUMAN-1", isAvailable: true, state: "Shutdown" }, ...extra] } });
const RUNTIMES = JSON.stringify({
  runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", platform: "iOS", isAvailable: true, version: "18.0", supportedDeviceTypes: [{ name: "iPhone 16", identifier: "x.iPhone-16" }] },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4", platform: "iOS", isAvailable: true, version: "26.4", supportedDeviceTypes: [{ name: "iPad Pro", identifier: "x.iPad" }, { name: "iPhone 17", identifier: "x.iPhone-17" }, { name: "iPhone 17 Pro", identifier: "x.iPhone-17-Pro" }] },
  ],
});

function fakeSimctl(devices = DEVICES()) {
  const calls: string[][] = [];
  const simctl: Simctl = async (args) => {
    calls.push(args);
    if (args.join(" ") === "list devices -j") return devices;
    if (args.join(" ") === "list runtimes -j") return RUNTIMES;
    if (args[0] === "create") return "NEW-UDID\n";
    return "";
  };
  return { simctl, calls };
}

describe("シミュレータ(フェーズ6)", () => {
  it("ツール専用の端末(agent-crew-<番号>)が無ければ、最新の iOS と、その中の最後の iPhone で作る。人の端末には触らない", async () => {
    const { simctl, calls } = fakeSimctl();
    expect(await ensureDevice(simctl, "agent-crew-1")).toEqual({ udid: "NEW-UDID", name: "agent-crew-1", deviceType: "iPhone 17 Pro" });
    expect(calls).toContainEqual(["create", "agent-crew-1", "x.iPhone-17-Pro", "com.apple.CoreSimulator.SimRuntime.iOS-26-4"]);
    expect(calls.flat()).not.toContain("HUMAN-1");
  });

  it("機種を指定できる。あれば作らずに使う", async () => {
    const a = fakeSimctl();
    expect((await ensureDevice(a.simctl, "agent-crew-1", "iPhone 17")).deviceType).toBe("iPhone 17");
    expect(a.calls).toContainEqual(["create", "agent-crew-1", "x.iPhone-17", "com.apple.CoreSimulator.SimRuntime.iOS-26-4"]);
    const b = fakeSimctl(DEVICES([{ name: "agent-crew-1", udid: "MINE-1", isAvailable: true, state: "Shutdown", deviceTypeIdentifier: "x.iPhone-17" }]));
    expect((await ensureDevice(b.simctl, "agent-crew-1")).udid).toBe("MINE-1");
    expect(b.calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("1タスク1台で貸し出す。空きが無ければ待ち、返されたら次が借りられる。持ち主のいない貸し出しは取り戻す", async () => {
    const home = tempDir("agent-crew-sim-");
    const { simctl } = fakeSimctl();
    const a = await leaseSimulator({ home, taskId: 1, simctl, slots: 1, waitMs: 0 });
    expect(a.name).toBe("agent-crew-1");
    await expect(leaseSimulator({ home, taskId: 2, simctl, slots: 1, waitMs: 0 })).rejects.toThrow(/空き/);
    const waiting = leaseSimulator({ home, taskId: 2, simctl, slots: 1, waitMs: 3000, pollMs: 50 });
    setTimeout(() => a.release(), 200);
    expect((await waiting).name).toBe("agent-crew-1");

    // 持ち主のプロセスが終わった貸し出し(異常終了の跡)は取り戻す
    const home2 = tempDir("agent-crew-sim-");
    mkdirSync(join(home2, "simulators"), { recursive: true });
    writeFileSync(join(home2, "simulators", "slot-1.lock"), JSON.stringify({ taskId: 9, pid: 999999, at: new Date().toISOString() }));
    expect((await leaseSimulator({ home: home2, taskId: 3, simctl, slots: 1, waitMs: 0 })).name).toBe("agent-crew-1");
  });
});

describe("Flutter の画面の撮影(フェーズ6)", () => {
  function setup(o: { screensTest?: boolean; fail?: boolean } = {}) {
    const home = tempDir("agent-crew-cap-");
    const worktree = tempDir("agent-crew-cap-wt-");
    if (o.screensTest !== false) {
      mkdirSync(join(worktree, "integration_test"), { recursive: true });
      writeFileSync(join(worktree, "integration_test", "screens_test.dart"), "// screens");
    }
    const { simctl, calls } = fakeSimctl();
    const drives: { command: string; env: Record<string, string>; writable: string[]; appearance: string }[] = [];
    const exec: DriveExec = async (req) => {
      const appearance = calls.filter((c) => c[0] === "ui").at(-1)?.[3] ?? "";
      drives.push({ command: req.command, env: req.env, writable: req.writable, appearance });
      if (o.fail) return { exitCode: 1, timedOut: false, output: "Failed to build iOS app", durationMs: 1 };
      const dir = req.env.AGENT_CREW_SHOTS_DIR!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "s1-orders.png"), png(1206, 2622));
      writeFileSync(join(dir, "s2-detail.png"), png(1206, 2622));
      return { exitCode: 0, timedOut: false, output: "All tests passed!", durationMs: 1 };
    };
    return { home, worktree, simctl, calls, drives, exec, outDir: join(home, "tasks", "1", "screens") };
  }

  it("貸し出したシミュレータで、ライト・ダークのそれぞれ flutter drive を動かし、画面の名前ごとに PNG を置く", async () => {
    const s = setup();
    const shots = await captureFlutterScreens({ home: s.home, taskId: 1, worktree: s.worktree, outDir: s.outDir, simctl: s.simctl, exec: s.exec, slots: 1 });
    expect(shots.map((x) => x.file).sort()).toEqual(["s1-orders-iphone-dark.png", "s1-orders-iphone-light.png", "s2-detail-iphone-dark.png", "s2-detail-iphone-light.png"]);
    expect(shots[0]).toMatchObject({ device: "iPhone 17 Pro", width: 402 });
    for (const x of shots) expect(existsSync(join(s.outDir, x.file))).toBe(true);
    expect(s.drives.map((d) => d.appearance)).toEqual(["light", "dark"]);
    // ドライバーはリポジトリのものではなく、ツールが build/ の下に書いたもの
    expect(s.drives[0]!.command).toContain("--driver=build/agent_crew/screens_driver.dart");
    expect(s.drives[0]!.command).toContain("--target=integration_test/screens_test.dart");
    expect(s.drives[0]!.command).toContain("-d NEW-UDID");
    expect(readFileSync(join(s.worktree, "build", "agent_crew", "screens_driver.dart"), "utf8")).toContain("AGENT_CREW_SHOTS_DIR");
    expect(s.drives[0]!.writable).toContain(s.worktree);
    // 使い終わったら止めて、返す
    expect(s.calls).toContainEqual(["shutdown", "NEW-UDID"]);
    expect(existsSync(join(s.home, "simulators", "slot-1.lock"))).toBe(false);
  });

  it("integration_test/screens_test.dart が無ければ、理由を添えて失敗する(シミュレータは借りない)", async () => {
    const s = setup({ screensTest: false });
    await expect(captureFlutterScreens({ home: s.home, taskId: 1, worktree: s.worktree, outDir: s.outDir, simctl: s.simctl, exec: s.exec, slots: 1 })).rejects.toThrow(/screens_test\.dart/);
    expect(s.calls.some((c) => c[0] === "boot")).toBe(false);
  });

  it("flutter drive が失敗したら、出力を添えて撮れなかった印を返し、シミュレータは返す", async () => {
    const s = setup({ fail: true });
    const shots = await captureFlutterScreens({ home: s.home, taskId: 1, worktree: s.worktree, outDir: s.outDir, simctl: s.simctl, exec: s.exec, slots: 1 });
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((x) => x.error?.includes("Failed to build iOS app"))).toBe(true);
    expect(existsSync(join(s.home, "simulators", "slot-1.lock"))).toBe(false);
  });

  it("撮影の前にきれいだった worktree は、撮影(ビルドの pod install など)で変わったものを元に戻し、戻したものを知らせる", async () => {
    const s = setup();
    const { repo } = makeRepo();
    mkdirSync(join(repo, "integration_test"), { recursive: true });
    writeFileSync(join(repo, "integration_test", "screens_test.dart"), "// screens");
    writeFileSync(join(repo, "project.pbxproj"), "original\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "app");
    const exec: DriveExec = async (req) => {
      writeFileSync(join(repo, "project.pbxproj"), "changed by pod install\n");
      writeFileSync(join(repo, "Podfile.lock"), "lock\n");
      return s.exec(req);
    };
    const notes: string[] = [];
    const shots = await captureFlutterScreens({ home: s.home, taskId: 1, worktree: repo, outDir: s.outDir, simctl: s.simctl, exec, slots: 1, onNote: (m) => notes.push(m) });
    expect(shots.filter((x) => !x.error)).toHaveLength(4);
    expect(readFileSync(join(repo, "project.pbxproj"), "utf8")).toBe("original\n");
    expect(existsSync(join(repo, "Podfile.lock"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(notes.join("\n")).toMatch(/project\.pbxproj/);
    expect(notes.join("\n")).toMatch(/Podfile\.lock/);
  });

  it("撮影の前から変更があった worktree には手を付けない", async () => {
    const s = setup();
    const { repo } = makeRepo();
    mkdirSync(join(repo, "integration_test"), { recursive: true });
    writeFileSync(join(repo, "integration_test", "screens_test.dart"), "// screens");
    writeFileSync(join(repo, "wip.txt"), "人の作業中\n");
    await captureFlutterScreens({ home: s.home, taskId: 1, worktree: repo, outDir: s.outDir, simctl: s.simctl, exec: s.exec, slots: 1 });
    expect(existsSync(join(repo, "wip.txt"))).toBe(true);
  });
});

describe("ネイティブ iOS の画面の撮影(XCUITest。6b)", () => {
  function setup(o: { fail?: boolean } = {}) {
    const home = tempDir("agent-crew-ioscap-");
    const { repo } = makeRepo();
    const { simctl, calls } = fakeSimctl();
    const runs: { command: string; appearance: string; writable: string[]; rules: string[] }[] = [];
    const exec: DriveExec = async (req) => {
      runs.push({ command: req.command, appearance: calls.filter((c) => c[0] === "ui").at(-1)?.[3] ?? "", writable: req.writable, rules: req.extraRules ?? [] });
      writeFileSync(join(repo, "Orders.xcodeproj.changed"), "x"); // ビルドが何かを書いた体
      return o.fail ? { exitCode: 65, timedOut: false, output: "** TEST FAILED **", durationMs: 1 } : { exitCode: 0, timedOut: false, output: "** TEST SUCCEEDED **", durationMs: 1 };
    };
    const xcresult: XcresultExport = async (_result, out) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "A1.png"), png(1206, 2622));
      writeFileSync(join(out, "B2.png"), png(1206, 2622));
      writeFileSync(
        join(out, "manifest.json"),
        JSON.stringify([{ attachments: [{ exportedFileName: "A1.png", suggestedHumanReadableName: "s1-orders_0_007D0F3A-F39F-4E85-B9C3-A7CAC8DF29D3.png" }, { exportedFileName: "B2.png", suggestedHumanReadableName: "s2-detail_1_1234ABCD-0000-0000-0000-000000000000.png" }] }]),
      );
    };
    const outDir = join(home, "tasks", "1", "screens");
    const base = { home, taskId: 1, worktree: repo, outDir, simctl, exec, xcresult, slots: 1, scheme: "Orders", screens: "OrdersUITests/ScreensUITests" };
    return { base, calls, runs, repo, outDir };
  }

  it("ライト・ダークのそれぞれ撮影の UI テストだけを動かし、xcresult の添付を画面の ID ごとに並べる", async () => {
    const s = setup();
    const shots = await captureIosScreens(s.base);
    expect(shots.map((x) => x.file).sort()).toEqual(["s1-orders-iphone-dark.png", "s1-orders-iphone-light.png", "s2-detail-iphone-dark.png", "s2-detail-iphone-light.png"]);
    for (const x of shots) expect(existsSync(join(s.outDir, x.file))).toBe(true);
    expect(shots[0]).toMatchObject({ width: 402, device: "iPhone 17 Pro" });
    expect(s.runs.map((r) => r.appearance)).toEqual(["light", "dark"]);
    expect(s.runs[0]!.command).toContain("-scheme Orders");
    expect(s.runs[0]!.command).toContain("id=NEW-UDID");
    expect(s.runs[0]!.command).toContain("-only-testing:OrdersUITests/ScreensUITests");
    expect(s.runs[0]!.command).toContain("-derivedDataPath build/DerivedData");
    expect(s.runs[0]!.rules.join("\n")).toContain("testmanagerd");
    // 撮影の後は止めて返し、ビルドで変わったものは元に戻す
    expect(s.calls).toContainEqual(["shutdown", "NEW-UDID"]);
    expect(existsSync(join(s.repo, "Orders.xcodeproj.changed"))).toBe(false);
  });

  it("UI テストが失敗したら、出力を添えて撮れなかった印を返す", async () => {
    const s = setup({ fail: true });
    const shots = await captureIosScreens(s.base);
    expect(shots.every((x) => x.error?.includes("TEST FAILED"))).toBe(true);
  });

  it("撮影の UI テストが設定されていなければ、理由を添えて失敗する", async () => {
    const s = setup();
    await expect(captureIosScreens({ ...s.base, screens: null })).rejects.toThrow(/撮影の UI テスト/);
  });
});

