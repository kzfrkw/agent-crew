import type { RunSummary } from "../../../src/server/api-types.ts";
import { elapsedSec, formatCost, formatDateTime, formatDuration } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useNow } from "../lib/useNow.ts";
import { RunStateBadge, VerdictBadge } from "./StateBadge.tsx";
import { Empty } from "./Status.tsx";
import { RoleName } from "./RoleAvatar.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** 実行の一覧(S2・S5)。狭い画面では補助の列を隠す */
export function RunTable({ runs, compact = false }: { runs: RunSummary[]; compact?: boolean }) {
  const now = useNow(1000, runs.some((r) => r.state === "running"));
  if (runs.length === 0) return <Empty>実行はまだありません</Empty>;
  const aux = compact ? "hidden" : "max-sm:hidden";
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>#</TableHead>
          <TableHead>役割</TableHead>
          <TableHead>状態</TableHead>
          <TableHead className={aux}>判定</TableHead>
          <TableHead className="text-right">費用</TableHead>
          <TableHead className={`text-right ${aux}`}>時間</TableHead>
          <TableHead className={`text-right ${aux}`}>開始</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(paths.run(r.id))}>
            <TableCell className="w-px text-subtle-foreground tabular-nums">
              <Link to={paths.run(r.id)}>#{r.id}</Link>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Link to={paths.run(r.id)} className="font-medium">
                <RoleName role={r.role} active={r.state === "running"} />
              </Link>{" "}
              {r.model && <span className="text-xs text-muted-foreground">{r.model}</span>}
            </TableCell>
            <TableCell>
              <RunStateBadge state={r.state} />
            </TableCell>
            <TableCell className={aux}>
              <VerdictBadge verdict={r.verdict} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{formatCost(r.costUsd)}</TableCell>
            <TableCell className={`text-right text-xs tabular-nums ${aux}`}>{formatDuration(r.state === "running" ? elapsedSec(r.startedAt, now) : r.durationSec)}</TableCell>
            <TableCell className={`text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums ${aux}`}>{formatDateTime(r.startedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
