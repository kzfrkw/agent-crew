import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Shot } from "../browser/chrome.ts";
import { defaultDenyRead } from "../browser/app.ts";
import { findFlutterRoot, runSandboxedCommand, toolchainRules, toolchainWritable, userTempDir, type CommandResult } from "../toolexec/command.ts";
import { bootDevice, defaultSimctl, leaseSimulator, setAppearance, shutdownDevice, type Simctl } from "./simulator.ts";

/**
 * Flutter の画面の撮影(設計メモ v0.15、フェーズ6)。
 * 実装者が書いた integration_test/screens_test.dart(画面を開いて takeScreenshot(<名前>) するテスト)を、
 * 貸し出したシミュレータで、ライト・ダークのそれぞれ flutter drive で動かす。
 * 画像を書き出すドライバーはホストで動くため、リポジトリのものは使わず、ツールが build/ の下に書いたものを使う。
 * ビルドを含めて sandbox-exec で囲う(書き込みは worktree・撮影先・Flutter のキャッシュ・DerivedData・ユーザーの一時ディレクトリ、通信は localhost)。
 * ユーザーの一時ディレクトリは、Xcode の actool がそこへ直接書くため(docs/safety.md 8章)。
 */

export const SCREENS_TEST = "integration_test/screens_test.dart";
const DRIVER = "build/agent_crew/screens_driver.dart";
const DRIVER_SOURCE = `// agent-crew が撮影のたびに書くドライバー(リポジトリには入れない。build/ は Flutter の .gitignore の対象)
import 'dart:io';
import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() => integrationDriver(
      onScreenshot: (String name, List<int> bytes, [Map<String, Object?>? args]) async {
        final dir = Platform.environment['AGENT_CREW_SHOTS_DIR']!;
        final safe = name.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
        File('$dir/$safe.png')
          ..parent.createSync(recursive: true)
          ..writeAsBytesSync(bytes);
        return true;
      },
    );
`;

/** extraRules は種類ごとの sandbox-exec の追加の規則(ネイティブ iOS のテスト。toolchainRules) */
export type DriveExec = (req: { cwd: string; command: string; env: Record<string, string>; writable: string[]; tmpDir: string; extraRules?: string[]; denyRead?: string[] }) => Promise<CommandResult>;

/** ビルドと撮影で書き込む場所(worktree と撮影先のほか) */
function buildWritable(): string[] {
  const home = homedir();
  let userTmp: string[] = [];
  try {
    userTmp = [execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim()];
  } catch {
    // macOS 以外
  }
  return [...toolchainWritable("flutter", { home, flutterRoot: findFlutterRoot() }), join(home, "Library", "Developer", "Xcode", "DerivedData"), ...userTmp];
}

export const defaultDriveExec =
  (dataHome: string): DriveExec =>
  (req) =>
    runSandboxedCommand({ cwd: req.cwd, command: req.command, env: req.env, writable: req.writable, tmpDir: req.tmpDir, denyRead: [...defaultDenyRead(homedir(), dataHome), ...(req.denyRead ?? [])], extraRules: req.extraRules, timeoutMs: 20 * 60_000 });

/** git の作業ツリーの変更(porcelain)。git のリポジトリでなければ null */
function gitStatus(worktree: string): string | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trimEnd();
  } catch {
    return null;
  }
}

/**
 * 撮影で変わったものを元に戻す(e2e で発見: flutter drive のビルドが pod install を行い、iOS のプロジェクトのファイルを変えた)。
 * 撮影の前にきれいだった worktree だけが対象。追跡しているファイルは戻し、新しく増えたファイル(.gitignore の対象を除く)は消す
 */
function restoreWorktree(worktree: string): string[] {
  const changed = (gitStatus(worktree) ?? "").split("\n").filter(Boolean).map((l) => l.slice(3));
  if (changed.length === 0) return [];
  execFileSync("git", ["checkout", "--", "."], { cwd: worktree });
  execFileSync("git", ["clean", "-fdq"], { cwd: worktree });
  return changed;
}

/** PNG の幅(IHDR)。読めなければ 0 */
function pngWidth(path: string): number {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    return b.toString("ascii", 12, 16) === "IHDR" ? b.readUInt32BE(16) : 0;
  } finally {
    closeSync(fd);
  }
}

export async function captureFlutterScreens(o: {
  home: string;
  taskId: number;
  worktree: string;
  outDir: string;
  simctl?: Simctl;
  exec?: DriveExec;
  slots?: number;
  waitMs?: number;
  deviceType?: string;
  /** 知らせること(撮影で変わったファイルを元に戻した、など)。イベントに残す */
  onNote?: (message: string) => void;
  /** プロジェクトの読ませないパス(7-4) */
  denyRead?: string[];
}): Promise<Shot[]> {
  if (!existsSync(join(o.worktree, SCREENS_TEST))) {
    throw new Error(`${SCREENS_TEST} がありません(画面を開いて takeScreenshot(<画面の名前>) するテストを、実装者が書く決まりです)`);
  }
  const simctl = o.simctl ?? defaultSimctl;
  const exec = o.exec ?? defaultDriveExec(o.home);
  // 撮影はコードを変えない。前にきれいだった worktree は、撮影の後で元に戻す
  const wasClean = gitStatus(o.worktree) === "";
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  mkdirSync(join(o.worktree, "build", "agent_crew"), { recursive: true });
  writeFileSync(join(o.worktree, DRIVER), DRIVER_SOURCE);
  const tmp = join(o.home, "tmp", `mobile-${o.taskId}-${Date.now()}`);

  const lease = await leaseSimulator({ home: o.home, taskId: o.taskId, simctl, slots: o.slots ?? 1, waitMs: o.waitMs ?? 30 * 60_000, deviceType: o.deviceType });
  const shots: Shot[] = [];
  try {
    await bootDevice(simctl, lease.udid);
    for (const scheme of ["light", "dark"] as const) {
      await setAppearance(simctl, lease.udid, scheme);
      const raw = join(tmp, `raw-${scheme}`);
      const r = await exec({
        cwd: o.worktree,
        command: `flutter drive --driver=${DRIVER} --target=${SCREENS_TEST} -d ${lease.udid}`,
        env: { AGENT_CREW_SHOTS_DIR: raw },
        writable: [o.worktree, o.outDir, raw, ...buildWritable()],
        tmpDir: join(tmp, `drive-${scheme}`),
        denyRead: o.denyRead,
      });
      const files = existsSync(raw) ? readdirSync(raw).filter((f) => f.endsWith(".png")).sort() : [];
      if (r.exitCode !== 0 || r.timedOut || files.length === 0) {
        const why = r.timedOut ? "flutter drive が時間切れになりました" : files.length === 0 && r.exitCode === 0 ? "takeScreenshot の画像がありません" : `flutter drive が失敗しました(終了コード ${r.exitCode})`;
        shots.push({ name: "screens", path: SCREENS_TEST, width: 0, scheme, file: `screens-iphone-${scheme}.png`, device: lease.deviceType, error: `${why}:\n${r.output.slice(-1500)}` });
        continue;
      }
      for (const f of files) {
        const name = f.replace(/\.png$/, "");
        const file = `${name}-iphone-${scheme}.png`;
        renameSync(join(raw, f), join(o.outDir, file));
        // 幅は論理ピクセル(iPhone は 3 倍の画像)。表示の目安に使う
        shots.push({ name, path: name, width: Math.round(pngWidth(join(o.outDir, file)) / 3), scheme, file, device: lease.deviceType });
      }
    }
    return shots;
  } finally {
    await shutdownDevice(simctl, lease.udid);
    lease.release();
    rmSync(tmp, { recursive: true, force: true });
    if (wasClean) {
      const restored = restoreWorktree(o.worktree);
      if (restored.length > 0) o.onNote?.(`撮影(ビルド)で変わったファイルを元に戻しました: ${restored.join("、")}(ビルドで変わるファイルは、実装者がコミットしておくと、次からは変わりません)`);
    }
  }
}

/** xcresult の添付(スクリーンショット)を取り出す。manifest.json と画像を outDir に置く。テストでは差し替える */
export type XcresultExport = (resultPath: string, outDir: string) => Promise<void>;

const runFile = promisify(execFile);
export const defaultXcresultExport: XcresultExport = async (resultPath, outDir) => {
  mkdirSync(outDir, { recursive: true });
  await runFile("xcrun", ["xcresulttool", "export", "attachments", "--path", resultPath, "--output-path", outDir], { timeout: 120_000 });
};

/**
 * ネイティブ iOS の画面の撮影(設計メモ v0.16、6b)。
 * 実装者が書いた「画面を撮る UI テスト」(XCTAttachment に画面の ID の名前でスクリーンショットを添付する)を、
 * 貸し出したシミュレータで、ライト・ダークのそれぞれ -only-testing で動かし、xcresult から添付を取り出す。
 * sandbox-exec の許可はネイティブ iOS のもの(worktree・ユーザーの一時ディレクトリ・testmanagerd のソケット・/dev/ptmx。docs/safety.md 9章)
 */
export async function captureIosScreens(o: {
  home: string;
  taskId: number;
  worktree: string;
  outDir: string;
  scheme: string;
  /** 画面を撮る UI テスト(<ターゲット>/<クラス>) */
  screens: string | null;
  simctl?: Simctl;
  exec?: DriveExec;
  xcresult?: XcresultExport;
  slots?: number;
  waitMs?: number;
  deviceType?: string;
  onNote?: (message: string) => void;
  denyRead?: string[];
}): Promise<Shot[]> {
  if (!o.screens) throw new Error("撮影の UI テストがプロファイルにありません(agent-crew project set <名前> --screens <UIテストのターゲット>/ScreensUITests で設定してください)");
  const simctl = o.simctl ?? defaultSimctl;
  const exec = o.exec ?? defaultDriveExec(o.home);
  const xcresult = o.xcresult ?? defaultXcresultExport;
  const wasClean = gitStatus(o.worktree) === "";
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  const tmp = join(o.home, "tmp", `ios-${o.taskId}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  const lease = await leaseSimulator({ home: o.home, taskId: o.taskId, simctl, slots: o.slots ?? 1, waitMs: o.waitMs ?? 30 * 60_000, deviceType: o.deviceType });
  const shots: Shot[] = [];
  try {
    await bootDevice(simctl, lease.udid);
    for (const scheme of ["light", "dark"] as const) {
      await setAppearance(simctl, lease.udid, scheme);
      const result = join(tmp, `${scheme}.xcresult`);
      const r = await exec({
        cwd: o.worktree,
        command: `xcodebuild test -scheme ${o.scheme} -destination 'platform=iOS Simulator,id=${lease.udid}' -derivedDataPath build/DerivedData -only-testing:${o.screens} -resultBundlePath '${result}' -quiet`,
        env: {},
        writable: [o.worktree, tmp, ...toolchainWritable("ios", { home: homedir(), flutterRoot: null, userTmp: userTempDir() })],
        tmpDir: join(tmp, `run-${scheme}`),
        extraRules: toolchainRules("ios"),
        denyRead: o.denyRead,
      });
      const raw = join(tmp, `raw-${scheme}`);
      let entries: { file: string; name: string }[] = [];
      if (existsSync(result) || o.xcresult) {
        try {
          await xcresult(result, raw);
          const manifest = JSON.parse(readFileSync(join(raw, "manifest.json"), "utf8")) as { attachments?: { exportedFileName: string; suggestedHumanReadableName?: string }[] }[];
          entries = manifest.flatMap((t) => t.attachments ?? []).flatMap((a) => {
            // 名前は「<添付の名前>_<番号>_<UUID>.png」
            const name = /^(.+?)_\d+_[0-9A-Fa-f-]{36}\.png$/.exec(a.suggestedHumanReadableName ?? "")?.[1] ?? (a.suggestedHumanReadableName ?? a.exportedFileName).replace(/\.png$/, "");
            return a.exportedFileName.endsWith(".png") ? [{ file: a.exportedFileName, name: name.replace(/[^A-Za-z0-9_-]/g, "_") }] : [];
          });
        } catch {
          entries = [];
        }
      }
      if (r.exitCode !== 0 || r.timedOut || entries.length === 0) {
        const why = r.timedOut ? "UI テストが時間切れになりました" : r.exitCode === 0 ? "スクリーンショットの添付がありません" : `UI テストが失敗しました(終了コード ${r.exitCode})`;
        shots.push({ name: "screens", path: o.screens, width: 0, scheme, file: `screens-iphone-${scheme}.png`, device: lease.deviceType, error: `${why}:\n${r.output.slice(-1500)}` });
        continue;
      }
      for (const e of entries) {
        const file = `${e.name}-iphone-${scheme}.png`;
        copyFileSync(join(raw, e.file), join(o.outDir, file));
        shots.push({ name: e.name, path: e.name, width: Math.round(pngWidth(join(o.outDir, file)) / 3), scheme, file, device: lease.deviceType });
      }
    }
    return shots;
  } finally {
    await shutdownDevice(simctl, lease.udid);
    lease.release();
    rmSync(tmp, { recursive: true, force: true });
    if (wasClean) {
      const restored = restoreWorktree(o.worktree);
      if (restored.length > 0) o.onNote?.(`撮影(ビルド)で変わったファイルを元に戻しました: ${restored.join("、")}`);
    }
  }
}
