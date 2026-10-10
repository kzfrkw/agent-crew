import type { ScreenshotView } from "../../../src/server/api-types.ts";

/**
 * 実装後のデザインレビューのために撮った画面(4c)。画面ごとにまとめ、幅と配色を添えて並べる。
 * 画像を押すと生ファイルを開く(最終確認の判断材料)
 */
export function Screenshots({ shots }: { shots: ScreenshotView[] }) {
  const paths = [...new Set(shots.map((s) => s.path))];
  return (
    <div className="flex flex-col gap-4">
      {paths.map((path) => (
        <div key={path}>
          <h3 className="mt-0 mb-2 font-mono text-xs text-muted-foreground">{path}</h3>
          <div className="flex flex-wrap items-start gap-3">
            {shots
              .filter((s) => s.path === path)
              .map((s) => {
                const size = s.device ?? `${s.width}px`;
                const scheme = s.scheme === "dark" ? "ダーク" : "ライト";
                const label = `${s.path} ${size} ${scheme}`;
                return (
                  <figure key={s.file} className="m-0 flex flex-col gap-1">
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-muted">
                        <img src={s.url} alt={label} loading="lazy" className={`block h-auto ${s.width < 600 ? "w-28" : "w-72 max-sm:w-full"}`} />
                      </a>
                    ) : (
                      <div className="flex h-24 w-72 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-destructive max-sm:w-full">
                        撮影できませんでした: {s.error}
                      </div>
                    )}
                    <figcaption className="text-xs text-muted-foreground tabular-nums">
                      {`${size} ・ ${scheme}`}
                    </figcaption>
                  </figure>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
