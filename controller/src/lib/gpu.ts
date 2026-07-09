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

/** Delete a single recorded idle-kill event. */
export function deleteGpuEvent(id: number, actor: string): void {
  const res = db().prepare("DELETE FROM gpu_events WHERE id = ?").run(id);
  if (res.changes === 0) throw new Error("event not found");
  audit(actor, "gpu.event.delete", String(id));
}

export interface GpuEventRow {
  id: number;
  node: string;
  pid: number | null;
  user: string | null;
  lab: string | null;
  vram_bytes: number | null;
  state: string;
  ts: number;
  cmd: string | null;
  idle_s: number | null;
}

export interface StudentKillStats {
  user: string | null;
  warned: number;
  killed: number;
  lastTs: number;
  events: GpuEventRow[]; // newest first
}

export interface LabKillStats {
  lab: string | null;
  warned: number;
  killed: number;
  students: StudentKillStats[];
}

/** Roll idle-kill events up into lab -> student groups with warn/kill counts, worst offenders
 * first (kills desc, then warns), so a repeat offender floats to the top of the GPU page. */
export function groupGpuEvents(events: GpuEventRow[]): LabKillStats[] {
  const labs = new Map<string, LabKillStats & { byUser: Map<string, StudentKillStats> }>();
  for (const e of events) {
    const labKey = e.lab ?? "";
    let lab = labs.get(labKey);
    if (!lab) {
      lab = { lab: e.lab, warned: 0, killed: 0, students: [], byUser: new Map() };
      labs.set(labKey, lab);
    }
    const userKey = e.user ?? "";
    let student = lab.byUser.get(userKey);
    if (!student) {
      student = { user: e.user, warned: 0, killed: 0, lastTs: e.ts, events: [] };
      lab.byUser.set(userKey, student);
      lab.students.push(student);
    }
    if (e.state === "killed") {
      lab.killed++;
      student.killed++;
    } else if (e.state === "warned") {
      lab.warned++;
      student.warned++;
    }
    student.lastTs = Math.max(student.lastTs, e.ts);
    student.events.push(e);
  }
  const byOffense = (a: { killed: number; warned: number }, b: { killed: number; warned: number }) =>
    b.killed - a.killed || b.warned - a.warned;
  const out = [...labs.values()];
  for (const lab of out) {
    lab.students.sort(byOffense);
    for (const s of lab.students) s.events.sort((a, b) => b.ts - a.ts);
  }
  out.sort(byOffense);
  return out.map(({ byUser: _byUser, ...lab }) => lab);
}

/** Recent idle-kill events for the GPU page's grouped offender view (bounded read). */
export function recentGpuEvents(limit = 1000): GpuEventRow[] {
  return db()
    .prepare("SELECT * FROM gpu_events ORDER BY ts DESC LIMIT ?")
    .all(limit) as GpuEventRow[];
}
