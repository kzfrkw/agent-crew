#!/usr/bin/env node
// エントリポイント。TypeScript のソースを Node の型除去でそのまま実行する(ビルド工程なし)。
import { main } from "../src/cli/index.ts";

await main(process.argv);
