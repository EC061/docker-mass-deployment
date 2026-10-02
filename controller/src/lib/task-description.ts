const ACTION_LABELS: Record<string, string> = {
  "lab.create": "Create lab",
  "lab.set_quota": "Update lab quotas",
  "lab.destroy": "Delete lab",
  "student.add": "Provision student access",
  "student.remove": "Remove student access",
  "student.delete_cold": "Delete student cold storage",
  "container.recreate": "Recreate lab container",
  "gpu.policy.update": "Update GPU idle policy",
  "node.report_state": "Report node state",
  "node.scrub": "Start ZFS pool scrub",
  "node.check": "Check node health",
  "node.repair": "Repair node configuration",
  "node.reboot": "Reboot node",
  "usage.scan": "Scan student storage usage",
  "storage.status": "Refresh storage inventory",
  "storage.list_devices": "List storage devices",
  "storage.list_pools": "List ZFS pools",
  "storage.create_pool": "Initialize disks and create ZFS pool",
  "storage.attach_pool": "Attach pool to storage tier",
  "storage.remove_pool": "Detach pool from storage tier",
  "storage.rebalance": "Rebalance storage quotas",
  "storage.mount": "Reconcile storage mounts",
  "storage.provision_lab": "Provision lab storage",
};

export function taskParams(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function matchingTaskActions(query: string): string[] {
  const text = query.toLowerCase();
  return Object.entries(ACTION_LABELS)
    .filter(([, label]) => label.toLowerCase().includes(text))
    .map(([action]) => action);
}

export function describeTask(action: string, rawParams: string | null): string {
  const params = taskParams(rawParams);
  const context: string[] = [];
  // Only expose known operational fields; task parameters may contain credentials.
  for (const [key, label] of [["lab", "lab"], ["username", "student"], ["tier", "tier"], ["pool", "pool"]]) {
    if (typeof params[key] === "string" && params[key]) context.push(`${label} ${params[key]}`);
  }
  if (Array.isArray(params.pools) && params.pools.every((p) => typeof p === "string")) {
    if (params.pools.length) context.push(`pools ${params.pools.join(", ")}`);
  }
  if (action === "gpu.policy.update") {
    if (typeof params.enabled === "boolean") context.push(params.enabled ? "enabled" : "disabled");
    if (typeof params.idle_minutes === "number") context.push(`idle ${params.idle_minutes} min`);
  }
  const label = ACTION_LABELS[action] ?? action;
  return context.length ? `${label} · ${context.join(" · ")}` : label;
}

export function taskResultMessage(
  task: { node: string; action: string; params: string | null },
  ok: boolean,
  error?: string | null,
): string {
  const outcome = ok ? "completed" : "failed";
  return `${describeTask(task.action, task.params)} on ${task.node} — ${outcome}${!ok && error ? `: ${error}` : ""}`;
}
