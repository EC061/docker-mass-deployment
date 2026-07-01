import { audit } from "./audit";
import { db } from "./db";

/** Delete historical idle-kill events without disturbing the live GPU process snapshot. */
export function clearGpuEvents(actor: string): number {
  return db().transaction(() => {
    const cleared = db().prepare("DELETE FROM gpu_events").run().changes;
    audit(actor, "gpu.events.clear", undefined, `${cleared} event(s)`);
    return cleared;
  })();
}
