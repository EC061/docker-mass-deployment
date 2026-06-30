/**
 * Wire-protocol frame schemas for the agent hub.
 *
 * Every inbound frame (agent -> controller) is validated against these schemas at the edge — in
 * hub.ts — before it touches the DB or triggers a side effect, so a malformed or hostile frame is
 * rejected up front instead of relying on ad-hoc per-handler checks. Extra/unknown keys are stripped.
 *
 * PROTOCOL_VERSION is announced by the agent in its hello frame; the hub refuses an incompatible
 * version so an agent speaking a different protocol fails fast with a clear close code rather than
 * silently misbehaving. This redesign is a clean break (nodes are reprovisioned and agents
 * reinstalled), so exactly the current version is required — there is no legacy-agent compatibility.
 */

import { z } from "zod";

export const PROTOCOL_VERSION = 2;

const ts = z.number().finite().optional();

export const HelloFrame = z.object({
  type: z.literal("hello"),
  v: z.number().int().nonnegative().optional(), // protocol version; absent => 0 (pre-versioning)
  node: z.string().min(1).max(63),
  token: z.string().min(1).max(512),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  ts,
});

export const ResultFrame = z.object({
  type: z.literal("result"),
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(20000).nullish(),
  logs: z.string().max(20000).nullish(),
  // Set by the agent when this result was replayed from its durable cache (a redelivered task it had
  // already completed) rather than freshly executed — recorded so the UI can mark it idempotent.
  cached: z.boolean().optional(),
  ts,
});

// Agent -> controller acknowledgement that a pushed task was durably received + persisted locally.
export const ReceiptFrame = z.object({
  type: z.literal("receipt"),
  id: z.string().min(1).max(64),
  ts,
});

export const LogFrame = z.object({
  type: z.literal("log"),
  level: z.string().max(16).optional(),
  source: z.string().max(64).nullish(),
  lab: z.string().max(64).nullish(),
  user: z.string().max(64).nullish(),
  task_id: z.string().max(64).nullish(),
  msg: z.string().max(20000).optional(),
  detail: z.string().max(20000).nullish(),
  ts,
});

export const EventFrame = z.object({
  type: z.literal("event"),
  kind: z.string().max(32),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts,
});

export const TelemetryFrame = z.object({
  type: z.literal("telemetry"),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts,
});

const InboundFrame = z.discriminatedUnion("type", [
  HelloFrame,
  ResultFrame,
  ReceiptFrame,
  LogFrame,
  EventFrame,
  TelemetryFrame,
]);

export type InboundFrame = z.infer<typeof InboundFrame>;
export type Hello = z.infer<typeof HelloFrame>;
export type Result = z.infer<typeof ResultFrame>;
export type Receipt = z.infer<typeof ReceiptFrame>;
export type LogMsg = z.infer<typeof LogFrame>;
export type Event = z.infer<typeof EventFrame>;
export type Telemetry = z.infer<typeof TelemetryFrame>;

/** Validate a parsed-JSON frame. Returns the typed frame, or null if it matches no known schema. */
export function parseInboundFrame(raw: unknown): InboundFrame | null {
  const res = InboundFrame.safeParse(raw);
  return res.success ? res.data : null;
}

/**
 * Whether an agent's announced protocol version is compatible. An absent version (pre-versioning
 * agent) is treated as 0. Clean-break policy: exactly the current PROTOCOL_VERSION is accepted.
 */
export function isProtocolCompatible(v: number | undefined): boolean {
  return (v ?? 0) === PROTOCOL_VERSION;
}
