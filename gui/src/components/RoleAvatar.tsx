import type { ReactNode } from "react";
import { roleMeta, type RoleMotion, type RoleTool } from "../lib/roles.ts";
import { cn } from "@/lib/utils";

/**
 * 役割のキャラクター(docs/surface.md の「役割のキャラクター」)。線画の人物が役割の道具を持つ。
 * 色は文字の色(currentColor)だけで、実行中は「実行中」の緑にして、まばたき・小さな上下と、役割に合った道具の動きを付ける。
 * 座標は 48×48 の viewBox の中の値(画面の px ではない)
 */

const SIZE = { sm: "size-5", md: "size-9", lg: "size-16" } as const;

const MOTION: Record<RoleMotion, string> = {
  scan: "animate-role-scan",
  type: "animate-role-type",
  write: "origin-bottom-left animate-role-write",
  wave: "origin-bottom-left animate-role-wave",
  stamp: "animate-role-stamp",
};

const TOOLS: Record<RoleTool, ReactNode> = {
  clipboard: (
    <>
      <rect x="32" y="24" width="13" height="18" rx="1.5" />
      <rect x="36" y="22" width="5" height="3" rx="1" />
      <path d="M35 30h7M35 34h7M35 38h5" />
    </>
  ),
  compass: (
    <>
      <path d="M38.5 24.5 33 43M38.5 24.5 44 43M34.5 37q4 3 8 0" />
      <circle cx="38.5" cy="23" r="1.6" />
    </>
  ),
  pencil: <path d="m33 43 1.2-5 9.5-9.5 3.8 3.8-9.5 9.5Zm8.2-12 3.8 3.8" />,
  laptop: (
    <>
      <rect x="32" y="28" width="13" height="9" rx="1" />
      <path d="M30.5 41h16M35 31v3" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="37" cy="30" r="5.5" />
      <path d="m41 34 4.5 4.5" />
    </>
  ),
  stamp: <path d="M35 24h7v4h-2v4h5v4H32v-4h5v-4h-2Z" />,
  checklist: (
    <>
      <rect x="32" y="24" width="13" height="18" rx="1.5" />
      <path d="m34.5 29 1.5 1.5 2.5-2.5M40 29.5h3M34.5 35l1.5 1.5 2.5-2.5M40 35.5h3" />
    </>
  ),
  frame: (
    <>
      <rect x="31.5" y="25" width="14" height="12" rx="2" />
      <path d="M33.5 31q5-4.5 10 0-5 4.5-10 0Z" />
      <circle cx="38.5" cy="31" r="1.3" className="fill-current" />
    </>
  ),
  merge: (
    <>
      <circle cx="34" cy="25" r="2" />
      <circle cx="34" cy="41" r="2" />
      <circle cx="43" cy="33" r="2" />
      <path d="M34 27v12M34 30c0 3 3 3 7 3" />
    </>
  ),
  flask: <path d="M35 23h7m-5.5 0v7l-5 10q-.5 2 1.5 2h11q2 0 1.5-2l-5-10v-7M33 36h11" />,
  map: <path d="m31.5 27 5-2 5 2 5-2v14l-5 2-5-2-5 2ZM36.5 25v14M41.5 27v14" />,
  bulb: (
    <>
      <circle cx="38.5" cy="29" r="6" />
      <path d="M36 35v3h5v-3M36.5 41h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="38.5" cy="32" r="7" />
      <ellipse cx="38.5" cy="32" rx="3" ry="7" />
      <path d="M31.5 32h14" />
    </>
  ),
  target: (
    <>
      <circle cx="38.5" cy="33" r="7" />
      <circle cx="38.5" cy="33" r="3.5" />
      <circle cx="38.5" cy="33" r="1" className="fill-current" />
    </>
  ),
  cards: (
    <>
      <rect x="32" y="24" width="13" height="5" rx="1" />
      <rect x="32" y="31" width="13" height="5" rx="1" />
      <rect x="32" y="38" width="13" height="5" rx="1" />
    </>
  ),
  wireframe: (
    <>
      <rect x="32" y="24" width="13" height="18" rx="1.5" />
      <rect x="34" y="30" width="4" height="4" />
      <path d="M32 28h13M40 31h3M40 33h3M34 37h9M34 39.5h7" />
    </>
  ),
  box: <path d="m31.5 29 7-3.5 7 3.5v9l-7 3.5-7-3.5Zm0 0 7 3.5 7-3.5m-7 3.5v9" />,
  bubble: (
    <>
      <path d="M31 24h15v11h-8l-4 4v-4h-3ZM38.5 27v3.5" />
      <circle cx="38.5" cy="32.5" r=".9" className="fill-current" />
    </>
  ),
  baton: (
    <>
      <path d="M32 42 45 25M42 38v-5l3-1" />
      <circle cx="32" cy="42" r="1.8" />
      <circle cx="41" cy="38.2" r="1.2" className="fill-current" />
    </>
  ),
};

/**
 * decorative: 横に役割の名前を書くところでは、読み上げが重ならないように飾りにする。
 * active: 実行中(実行中の色と動き。動きを減らす設定では止まる)
 */
export function RoleAvatar({ role, size = "md", active = false, decorative = false, className }: { role: string; size?: keyof typeof SIZE; active?: boolean; decorative?: boolean; className?: string }) {
  const meta = roleMeta(role);
  const anim = (c: string) => (active ? c : "");
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("flex-none", SIZE[size], active ? "text-run" : "text-muted-foreground", className)}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": meta.label })}
    >
      <g className={cn("[transform-box:fill-box]", anim("animate-role-bob"))}>
        <circle cx="18" cy="15" r="8" />
        <g className={cn("[transform-box:fill-box] origin-center", anim("animate-role-blink"))}>
          <circle cx="15" cy="15" r="1.2" className="fill-current" stroke="none" />
          <circle cx="21" cy="15" r="1.2" className="fill-current" stroke="none" />
        </g>
        <path d="M15.5 18.8q2.5 1.8 5 0" />
        <path d="M4 44c0-9 6-14 14-14s12 5 12 14" />
      </g>
      <g data-tool={meta.tool} data-motion={meta.motion} className={cn("[transform-box:fill-box]", anim(MOTION[meta.motion]))}>
        {TOOLS[meta.tool]}
      </g>
    </svg>
  );
}

/** 役割のキャラクターと日本語の名前(表や経緯の行に使う。英語の役割名は title に残す) */
export function RoleName({ role, active = false }: { role: string; active?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle" title={role}>
      <RoleAvatar role={role} size="sm" active={active} decorative />
      {roleMeta(role).label}
    </span>
  );
}
