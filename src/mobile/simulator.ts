import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * iOS シミュレータ(設計メモ v0.15、フェーズ6)。ツールが専用の端末(agent-crew-<番号>)を作って使い、人の端末には触らない。
 * 1タスク1台の貸し出し。貸し出しはデータディレクトリのロックファイルで管理する(serve と CLI の run の両方から使えるように)。
 */

/** xcrun simctl を実行して標準出力を返す。テストでは差し替える */
export type Simctl = (args: string[]) => Promise<string>;

const run = promisify(execFile);
export const defaultSimctl: Simctl = async (args) => (await run("xcrun", ["simctl", ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 300_000 })).stdout;

type Runtime = { identifier: string; platform?: string; isAvailable: boolean; version: string; supportedDeviceTypes?: { name: string; identifier: string }[] };
type Device = { name: string; udid: string; isAvailable?: boolean; state?: string; deviceTypeIdentifier?: string };
export type SimDevice = { udid: string; name: string; deviceType: string };

const versionKey = (v: string) => v.split(".").map((n) => n.padStart(4, "0")).join(".");

/** 専用の端末を用意する。無ければ最新の iOS で作る(機種の指定が無ければ、その iOS が対応する最後の iPhone) */
export async function ensureDevice(simctl: Simctl, name: string, deviceType?: string): Promise<SimDevice> {
  const runtimes = (JSON.parse(await simctl(["list", "runtimes", "-j"])) as { runtimes: Runtime[] }).runtimes
    .filter((r) => r.isAvailable && (r.platform === "iOS" || r.identifier.includes(".iOS-")))
    .sort((a, b) => versionKey(a.version).localeCompare(versionKey(b.version)));
  const devices = (JSON.parse(await simctl(["list", "devices", "-j"])) as { devices: Record<string, Device[]> }).devices;
  for (const [runtimeId, list] of Object.entries(devices)) {
    const mine = list.find((d) => d.name === name && d.isAvailable !== false);
    if (mine) {
      const type = runtimes.find((r) => r.identifier === runtimeId)?.supportedDeviceTypes?.find((t) => t.identifier === mine.deviceTypeIdentifier)?.name;
      return { udid: mine.udid, name, deviceType: type ?? deviceType ?? "iPhone" };
    }
  }
  const runtime = runtimes.at(-1);
  if (!runtime) throw new Error("iOS シミュレータの実行環境がありません(Xcode で iOS の Simulator を入れてください)");
  const types = (runtime.supportedDeviceTypes ?? []).filter((t) => (deviceType ? t.name === deviceType : t.name.startsWith("iPhone")));
  const type = types.at(-1);
  if (!type) throw new Error(`iOS ${runtime.version} に機種 ${deviceType ?? "iPhone"} がありません`);
  const udid = (await simctl(["create", name, type.identifier, runtime.identifier])).trim();
  return { udid, name, deviceType: type.name };
}

export type Lease = SimDevice & { release: () => void };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 空いている番号の端末を借りる。空きが無ければ waitMs まで待つ。持ち主のプロセスが終わった貸し出しは取り戻す */
export async function leaseSimulator(o: { home: string; taskId: number; simctl: Simctl; slots: number; waitMs: number; pollMs?: number; deviceType?: string }): Promise<Lease> {
  const dir = join(o.home, "simulators");
  mkdirSync(dir, { recursive: true });
  const until = Date.now() + o.waitMs;
  for (;;) {
    for (let slot = 1; slot <= o.slots; slot++) {
      const lock = join(dir, `slot-${slot}.lock`);
      if (existsSync(lock)) {
        try {
          const held = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; taskId: number };
          if (alive(held.pid) && held.taskId !== o.taskId) continue;
        } catch {
          // 壊れたロックは取り戻す
        }
        rmSync(lock, { force: true });
      }
      try {
        writeFileSync(lock, JSON.stringify({ taskId: o.taskId, pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      } catch {
        continue; // ほかのプロセスが先に取った
      }
      try {
        const device = await ensureDevice(o.simctl, `agent-crew-${slot}`, o.deviceType);
        return { ...device, release: () => rmSync(lock, { force: true }) };
      } catch (e) {
        rmSync(lock, { force: true });
        throw e;
      }
    }
    if (Date.now() >= until) throw new Error(`シミュレータに空きがありません(${o.slots} 台とも使用中)`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 5000));
  }
}

/** 起動して、使えるようになるまで待つ(すでに起動していればそのまま) */
export async function bootDevice(simctl: Simctl, udid: string): Promise<void> {
  try {
    await simctl(["boot", udid]);
  } catch (e) {
    if (!/current state: Booted|Unable to boot device in current state: Booted/i.test(String((e as { stderr?: string }).stderr ?? (e as Error).message))) throw e;
  }
  await simctl(["bootstatus", udid, "-b"]);
}

export async function setAppearance(simctl: Simctl, udid: string, scheme: "light" | "dark"): Promise<void> {
  await simctl(["ui", udid, "appearance", scheme]);
}

export async function shutdownDevice(simctl: Simctl, udid: string): Promise<void> {
  try {
    await simctl(["shutdown", udid]);
  } catch {
    // すでに止まっている
  }
}
