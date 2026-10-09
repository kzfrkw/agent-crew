import type { TaskSummary } from "../../../src/server/api-types.ts";
import { formatCost, formatDateTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link, navigate } from "../lib/router.tsx";
import { StateBadge } from "./StateBadge.tsx";
import { Empty } from "./Status.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** タスクの一覧表(F3)。行のどこを押しても詳細へ。狭い画面では補助の列を隠す */
export function TaskTable({ tasks, empty = "タスクはありません" }: { tasks: TaskSummary[]; empty?: string }) {
  if (tasks.length === 0) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="max-sm:hidden">ID</TableHead>
          <TableHead>状態</TableHead>
          <TableHead>タイトル</TableHead>
          <TableHead className="max-sm:hidden">実行中</TableHead>
          <TableHead className="text-right max-sm:hidden">差し戻し</TableHead>
          <TableHead className="text-right max-sm:hidden">費用</TableHead>
          <TableHead className="text-right">更新</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((t) => (
          <TableRow key={t.id} className="cursor-pointer" onClick={(e) => !(e.target as HTMLElement).closest("a") && navigate(paths.task(t.id))}>
            <TableCell className="w-px whitespace-nowrap text-subtle-foreground tabular-nums max-sm:hidden">#{t.id}</TableCell>
            <TableCell className="w-px whitespace-nowrap">
              <StateBadge task={t} />
            </TableCell>
            <TableCell className="min-w-[10em] font-medium">
              <Link to={paths.task(t.id)} className="no-underline">
                {t.title}
              </Link>
              {t.kind === "test_infra" && <span className="text-xs font-normal text-muted-foreground"> (テスト基盤整備)</span>}
            </TableCell>
            <TableCell className="text-xs whitespace-nowrap max-sm:hidden">
              {t.running ? (
                <Link to={paths.run(t.running.id)}>
                  {t.running.role}
                  {t.running.model && <span className="text-muted-foreground">({t.running.model})</span>}
                </Link>
              ) : (
                <span className="text-subtle-foreground">-</span>
              )}
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums max-sm:hidden">{t.reviewRounds}</TableCell>
            <TableCell className="text-right text-xs whitespace-nowrap tabular-nums max-sm:hidden">
              {t.costUsd === null ? <span className="text-subtle-foreground">{formatCost(null)}</span> : formatCost(t.costUsd)}
            </TableCell>
            <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(t.updatedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
