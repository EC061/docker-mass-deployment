"use client";

import { useMemo, useState } from "react";
import type { Person } from "@/lib/announcements";
import { Input } from "@/components/ui/input";

/**
 * Searchable checkbox list for picking individual announcement recipients. Selection lives in
 * state and posts as repeated hidden `recipient` fields, so filtering the visible list never
 * drops a selection. The filter input and checkboxes have no `name` and are never submitted.
 */
export function RecipientPicker({ people }: { people: Person[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  }, [people, query]);

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  const chosen = people.filter((p) => selected.has(p.email));

  if (people.length === 0) {
    return <p className="text-xs text-muted-foreground">No addressable users or PIs yet.</p>;
  }

  return (
    <div className="space-y-2">
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
              <span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
            </label>
          ))
        )}
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Picked:</span>
          {chosen.map((p) => (
            <span
              key={p.email}
              className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
            >
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
      )}
    </div>
  );
}
