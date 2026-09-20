"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function QuotaDuration({ disabled }: { disabled: boolean }) {
  const [duration, setDuration] = useState("permanent");
  return (
    <div className="space-y-2">
      <Label htmlFor="quota-duration">Duration</Label>
      <Select id="quota-duration" name="quotaDuration" value={duration}
        onChange={(event) => setDuration(event.target.value)} disabled={disabled}>
        <option value="permanent">Permanent change</option>
        <option value="7">Temporary · 1 week</option>
        <option value="14">Temporary · 2 weeks</option>
        <option value="custom">Temporary · custom duration</option>
      </Select>
      {duration === "custom" && (
        <div>
          <Label htmlFor="quota-days">Number of days</Label>
          <Input id="quota-days" name="quotaDays" type="number" min="1" max="3650"
            step="1" required disabled={disabled} />
        </div>
      )}
      {duration !== "permanent" && (
        <p className="text-xs text-muted-foreground">Enter the increased total limit above. At expiry,
          the original limit is restored as far as current usage permits. Any violation is shown here
          and sent through admin alerts. Offline nodes apply restoration when they reconnect.</p>
      )}
    </div>
  );
}
