import { bootDevice, defaultSimctl, leaseSimulator, shutdownDevice, type Lease, type Simctl } from "./simulator.ts";

/**
 * コマンドの {simulator} を、貸し出したシミュレータの UDID に置き換える(設計メモ v0.16、6b)。
 * 最初に要ったときだけ借りて起動し、close で止めて返す。MCP の橋では役割の実行が終わるまで、テストの再実行では1回の実行の間だけ借りる
 */
export const SIMULATOR_PLACEHOLDER = "{simulator}";

export class SimulatorSession {
  private lease: Lease | undefined;
  private readonly o: { home: string; taskId: number; simctl?: Simctl; slots: number; waitMs?: number; deviceType?: string };

  constructor(o: { home: string; taskId: number; simctl?: Simctl; slots: number; waitMs?: number; deviceType?: string }) {
    this.o = o;
  }

  async resolve(command: string): Promise<string> {
    if (!command.includes(SIMULATOR_PLACEHOLDER)) return command;
    if (!this.lease) {
      const simctl = this.o.simctl ?? defaultSimctl;
      const lease = await leaseSimulator({ home: this.o.home, taskId: this.o.taskId, simctl, slots: this.o.slots, waitMs: this.o.waitMs ?? 30 * 60_000, deviceType: this.o.deviceType });
      try {
        await bootDevice(simctl, lease.udid);
      } catch (e) {
        lease.release();
        throw e;
      }
      this.lease = lease;
    }
    return command.split(SIMULATOR_PLACEHOLDER).join(this.lease.udid);
  }

  async close(): Promise<void> {
    if (!this.lease) return;
    await shutdownDevice(this.o.simctl ?? defaultSimctl, this.lease.udid);
    this.lease.release();
    this.lease = undefined;
  }
}
