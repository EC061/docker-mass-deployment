"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function StudentQuotaFields({
  allowCold = true,
  fastDefault,
  coldDefault,
}: {
  allowCold?: boolean;
  fastDefault?: number | null;
  coldDefault?: number | null;
}) {
  const [fast, setFast] = useState(fastDefault != null);
  const [cold, setCold] = useState(coldDefault != null);
  return (
    <>
      <div className="space-y-2 rounded-md border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" name="enableStudentFastQuota" checked={fast} onChange={(e) => setFast(e.target.checked)} />
          Enable per-student fast quota
        </label>
        {fast ? <div><Label>Fast quota per student (TB)</Label><Input required name="studentFastTb" type="number" min="0.001" step="any" defaultValue={fastDefault ?? 1} /></div> : null}
      </div>
      <div className="space-y-2 rounded-md border p-3">
        {allowCold ? (
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="enableStudentColdQuota" checked={cold} onChange={(e) => setCold(e.target.checked)} />
              Enable per-student cold quota
            </label>
            {cold ? <div><Label>Cold quota per student (TB)</Label><Input required name="studentColdTb" type="number" min="0.001" step="any" defaultValue={coldDefault ?? 1} /></div> : null}
          </>
        ) : <p className="text-sm text-muted-foreground">Per-student cold quota is managed by the SMB owner placement.</p>}
      </div>
    </>
  );
}
