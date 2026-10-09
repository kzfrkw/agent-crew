import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** クラス名を組み立て、Tailwind の衝突するクラスは後のものを優先する(shadcn/ui の標準) */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
