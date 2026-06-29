"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface LabTemplate {
  id: number;
  name: string;
}

interface Props {
  labs: LabTemplate[]; // existing labs whose roster can be copied into the new one
  action: (formData: FormData) => void | Promise<void>;
}

/** Create a node-independent logical lab. Node/quota/image config is set later via "grant node access". */
export function CreateLabForm({ labs, action }: Props) {
  const [copyFrom, setCopyFrom] = useState<number>(0);

  return (
    <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <Label>Lab name</Label>
        <Input name="name" required placeholder="bio-x" />
      </div>
      <div>
        <Label>PI name</Label>
        <Input name="piName" placeholder="Dr. Jane Smith" />
      </div>
      <div>
        <Label>PI email</Label>
        <Input name="piEmail" type="email" placeholder="pi@uga.edu" />
      </div>
      {labs.length > 0 && (
        <div>
          <Label>Copy roster from</Label>
          <Select name="copyFromLabId" value={copyFrom} onChange={(e) => setCopyFrom(Number(e.target.value))}>
            <option value={0}>— none —</option>
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {labs.length > 0 && (
        <label
          className={`flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2 lg:col-span-4 ${copyFrom ? "" : "opacity-50"}`}
        >
          <input type="checkbox" name="copyStudents" disabled={!copyFrom} className="accent-primary" />
          Also copy the selected lab&apos;s student roster
        </label>
      )}
      <div className="sm:col-span-2 lg:col-span-4">
        <Button type="submit">Create lab</Button>
      </div>
    </form>
  );
}
