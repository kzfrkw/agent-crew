import * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * ネイティブの select をトークンで整えたもの(docs/surface.md)。選択肢が少なく、
 * スマホでは OS の選択の画面が使えるため、Radix の Select の代わりに使う。
 */
function NativeSelect({ className, size = "default", ...props }: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <select
        data-slot="native-select"
        className={cn(
          "w-full min-w-0 appearance-none truncate rounded-md border border-input bg-card pr-8 pl-3 text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30",
          size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
        )}
        {...props}
      />
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </span>
  )
}

export { NativeSelect }
