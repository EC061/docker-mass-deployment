import { db } from "./db";
import type { Result } from "./protocol";
import { matchingTaskActions, taskParams, taskResultMessage } from "./task-description";

export interface LogRow {
  id: number;
  ts: number;
  node: string | null;
  level: string;
  source: string | null;
  lab: string | null;
  user: string | null;
  task_id: string | null;
  msg: string;
  detail: string | null;
  task_action: string | null;
  task_params: string | null;
  task_error: string | null;
}

// Recover context for old completion logs too. A node's streamed log cannot claim a foreign task.
const LOG_CONTEXT = `SELECT l.*, COALESCE(l.node, t.node) AS resolved_node,
  t.action AS task_action, t.params AS task_params, t.error AS task_error
  FROM logs l LEFT JOIN task_log t ON t.task_uuid = l.task_id
    AND (l.node IS NULL OR l.node = t.node)`;

export function listLogs(
  { level = "", node = "", q = "", task = "" }: {
    level?: string; node?: string; q?: string; task?: string;
  } = {},
  options: { chronological?: boolean; limit?: number } = {},
): LogRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  for (const [column, value] of [["level", level], ["resolved_node", node], ["task_id", task]]) {
    if (value) {
      where.push(`${column} = ?`);
      args.push(value);
    }
  }
  if (q) {
    const columns = ["msg", "detail", "source", "resolved_node", "task_action", "lab", "user", "task_id"];
    const matches = columns.map((column) => `${column} LIKE ?`);
    args.push(...columns.map(() => `%${q}%`));
    // Search historical targets without searching (or displaying) arbitrary task parameters.
    matches.push("CASE WHEN json_valid(task_params) THEN json_extract(task_params, '$.lab') END LIKE ?");
    matches.push("CASE WHEN json_valid(task_params) THEN json_extract(task_params, '$.username') END LIKE ?");
    args.push(`%${q}%`, `%${q}%`);
    const actions = matchingTaskActions(q);
    if (actions.length) {
      matches.push(`task_action IN (${actions.map(() => "?").join(", ")})`);
      args.push(...actions);
    }
    where.push(`(${matches.join(" OR ")})`);
  }
  const order = options.chronological ? "ASC" : "DESC";
  args.push(options.limit ?? 300);
  const rows = db().prepare(
    `WITH contextual_logs AS (${LOG_CONTEXT})
     SELECT * FROM contextual_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ts ${order}, id ${order} LIMIT ?`,
  ).all(...args) as (LogRow & { resolved_node: string | null })[];
  return rows.map((row) => {
    const params = taskParams(row.task_params);
    const log = {
      ...row,
      node: row.resolved_node,
      lab: row.lab ?? (typeof params.lab === "string" ? params.lab : null),
      user: row.user ?? (typeof params.username === "string" ? params.username : null),
    };
    if (log.source === "task" && log.node && log.task_action &&
        (log.msg === "task ok" || log.msg === "task failed")) {
      log.msg = taskResultMessage(
        { node: log.node, action: log.task_action, params: log.task_params },
        log.msg === "task ok",
        log.task_error,
      );
    }
    return log;
  });
}

export function logNodes(): string[] {
  return (db().prepare(
    `WITH contextual_logs AS (${LOG_CONTEXT})
     SELECT DISTINCT resolved_node AS node FROM contextual_logs
     WHERE resolved_node IS NOT NULL ORDER BY node`,
  ).all() as { node: string }[]).map((row) => row.node);
}

export function recordTaskResultLog(
  task: { node: string; action: string; params: string | null },
  result: Result,
): void {
  const params = taskParams(task.params);
  db().prepare(
    `INSERT INTO logs (ts, node, level, source, lab, user, task_id, msg, detail)
     VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(), task.node, result.ok ? "INFO" : "ERROR",
    typeof params.lab === "string" ? params.lab : null,
    typeof params.username === "string" ? params.username : null,
    result.id, taskResultMessage(task, result.ok, result.error), result.logs ?? null,
  );
}
