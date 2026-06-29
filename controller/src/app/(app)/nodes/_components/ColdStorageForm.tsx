"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

interface Props {
  name: string;
  backend: "local_zfs" | "smb";
  ownerName: string | null;
  localZfsNodes: string[]; // candidate owners
  action: (formData: FormData) => void | Promise<void>;
}

/** Configure a node's cold-storage backend (local ZFS, or SMB client of an owner node). */
export function ColdStorageForm({ name, backend, ownerName, localZfsNodes, action }: Props) {
  const [b, setB] = useState<"local_zfs" | "smb">(backend);
  const owners = localZfsNodes.filter((n) => n !== name);
  return (
    <form action={action} className="mt-1.5 flex flex-col gap-1">
      <input type="hidden" name="name" value={name} />
      <Select name="backend" value={b} onChange={(e) => setB(e.target.value as "local_zfs" | "smb")} className="h-7 w-32 text-xs">
        <option value="local_zfs">local ZFS</option>
        <option value="smb">SMB client</option>
      </Select>
      {b === "smb" && (
        <Select name="ownerName" defaultValue={ownerName ?? ""} className="h-7 w-32 text-xs">
          <option value="" disabled>
            owner node…
          </option>
          {owners.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      )}
      <Button type="submit" variant="secondary" size="sm" className="h-7">
        Save
      </Button>
    </form>
  );
}
