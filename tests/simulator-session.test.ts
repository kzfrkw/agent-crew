import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SimulatorSession } from "../src/mobile/session.ts";
import type { Simctl } from "../src/mobile/simulator.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const RUNTIMES = JSON.stringify({ runtimes: [{ identifier: "rt.iOS-26-4", platform: "iOS", isAvailable: true, version: "26.4", supportedDeviceTypes: [{ name: "iPhone 17", identifier: "x.iPhone-17" }] }] });
function fake() {
  const calls: string[][] = [];
  const simctl: Simctl = async (args) => {
    calls.push(args);
    if (args.join(" ") === "list devices -j") return JSON.stringify({ devices: {} });
    if (args.join(" ") === "list runtimes -j") return RUNTIMES;
    if (args[0] === "create") return "SIM-1\n";
    return "";
  };
  return { simctl, calls };
}

describe("コマンドの {simulator} の置き換え(6b)", () => {
  it("{simulator} が無ければ、シミュレータを借りずにそのまま返す", async () => {
    const { simctl, calls } = fake();
    const s = new SimulatorSession({ home: tempDir("agent-crew-sess-"), taskId: 1, simctl, slots: 1 });
    expect(await s.resolve("flutter test")).toBe("flutter test");
    await s.close();
    expect(calls).toEqual([]);
  });

  it("{simulator} があれば、最初の1回だけ借りて起動し、UDID に置き換える。閉じると止めて返す", async () => {
    const home = tempDir("agent-crew-sess-");
    const { simctl, calls } = fake();
    const s = new SimulatorSession({ home, taskId: 1, simctl, slots: 1 });
    expect(await s.resolve("xcodebuild test -destination 'platform=iOS Simulator,id={simulator}'")).toBe("xcodebuild test -destination 'platform=iOS Simulator,id=SIM-1'");
    expect(await s.resolve("x {simulator} {simulator}")).toBe("x SIM-1 SIM-1");
    expect(calls.filter((c) => c[0] === "boot")).toHaveLength(1);
    expect(existsSync(join(home, "simulators", "slot-1.lock"))).toBe(true);
    await s.close();
    expect(calls).toContainEqual(["shutdown", "SIM-1"]);
    expect(existsSync(join(home, "simulators", "slot-1.lock"))).toBe(false);
  });
});
