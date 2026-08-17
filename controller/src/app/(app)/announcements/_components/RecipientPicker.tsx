"use client";

import { useMemo, useState } from "react";
import type { Person, RecipientGroup } from "@/lib/announcements";
import { Input } from "@/components/ui/input";

/**
 * Recipient chooser: one-click group shortcuts over a searchable checkbox list of every addressable
 * person. A shortcut ("All PIs", "PhD", a lab, a node) only *selects* its members, so any of them
 * can be unchecked afterwards — there is no separate audience concept. Selection lives in state and
 * posts as repeated hidden `recipient` fields, so filtering the visible list never drops a
 * selection. The filter input and checkboxes have no `name` and are never submitted.
 */

/** The shortcut bar's rows, in display order. */
const GROUP_ROWS: { kind: RecipientGroup["kind"]; label: string }[] = [
  { kind: "all", label: "Everyone" },
  { kind: "degree", label: "Standing" },
  { kind: "lab", label: "Labs" },
  { kind: "node", label: "Nodes" },
];

export function RecipientPicker({
  people,
  groups,
  selectedEmails,
  onSelectedEmailsChange,
}: {
  people: Person[];
  groups: RecipientGroup[];
  selectedEmails: string[];
  onSelectedEmailsChange: (emails: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedEmails), [selectedEmails]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  }, [people, query]);

  function toggle(email: string) {
    onSelectedEmailsChange(
      selected.has(email) ? selectedEmails.filter((candidate) => candidate !== email) : [...selectedEmails, email],
    );
  }

  /** Select every member of a group, or clear them all when the group is already fully selected. */
  function toggleGroup(group: RecipientGroup) {
    const all = group.emails.every((email) => selected.has(email));
    onSelectedEmailsChange(
      all
        ? selectedEmails.filter((email) => !group.emails.includes(email))
        : [...selectedEmails, ...group.emails.filter((email) => !selected.has(email))],
    );
  }

  const peopleByEmail = new Map(people.map((person) => [person.email, person]));
  const chosen = selectedEmails.map((email) => peopleByEmail.get(email)).filter((person): person is Person => !!person);

  if (people.length === 0) {
    return <p className="text-xs text-muted-foreground">No addressable users or PIs yet.</p>;
  }

  return (
    <div className="space-y-3">
      {GROUP_ROWS.map((row) => {
        const rowGroups = groups.filter((g) => g.kind === row.kind && g.emails.length > 0);
        if (rowGroups.length === 0) return null;
        return (
          <div key={row.kind} className="flex flex-wrap items-baseline gap-1.5">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{row.label}</span>
            {rowGroups.map((g) => {
              const hit = g.emails.filter((e) => selected.has(e)).length;
              const all = hit === g.emails.length;
              return (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={all}
                  onClick={() => toggleGroup(g)}
                  title={
                    all
                      ? `Deselect the ${g.emails.length} recipient(s) in ${g.label}`
                      : `Select the ${g.emails.length} recipient(s) in ${g.label}`
                  }
                  className={
                    "rounded border px-2 py-0.5 text-xs transition-colors " +
                    (all
                      ? "border-primary bg-primary text-primary-foreground"
                      : hit > 0
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground")
                  }
                >
                  {g.label}{" "}
                  <span className="tabular-nums opacity-70">
                    {hit > 0 && !all ? `${hit}/${g.emails.length}` : g.emails.length}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or email…"
        aria-label="Search recipients"
      />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border">
        {matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No matches.</p>
        ) : (
          matches.map((p) => (
            <label
              key={p.email}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={selected.has(p.email)}
                onChange={() => toggle(p.email)}
                className="accent-primary"
              />
              <span className="truncate">{p.name}</span>
              {p.kind === "pi" && (
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  PI
                </span>
              )}
              {p.degree && (
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  {p.degree}
                </span>
              )}
              <span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
            </label>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {chosen.length === 0
            ? "No recipients selected."
            : `${chosen.length} recipient${chosen.length === 1 ? "" : "s"} selected:`}
        </span>
        {chosen.length > 0 && (
          <button
            type="button"
            onClick={() => onSelectedEmailsChange([])}
            className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Clear
          </button>
        )}
        {chosen.map((p) => (
          <span key={p.email} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
            {p.name}
            <button
              type="button"
              onClick={() => toggle(p.email)}
              aria-label={`Remove ${p.name}`}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
            <input type="hidden" name="recipient" value={p.email} />
          </span>
        ))}
      </div>
    </div>
  );
}
