"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { StudentQuotaFields } from "./StudentQuotaFields";

export interface NodeOpt {
  id: number;
  name: string;
  online: number;
  coldBackend: "local_zfs" | "smb";
  ownerName: string | null; // for SMB nodes, the cold-storage owner
  ready: boolean; // can this lab be granted access to this node right now?
  blockedReason: string | null; // why not (SMB owner missing / not active / mount down)
}

interface Props {
  labId: number;
  nodes: NodeOpt[]; // nodes the lab is NOT already placed on
  defaultFastTb: number;
  defaultColdTb: number;
  action: (formData: FormData) => void | Promise<void>;
}

/** "Grant node access": create a placement of the lab on a node with its initial container config. */
export function PlacementForm({ labId, nodes, defaultFastTb, defaultColdTb, action }: Props) {
  const [nodeId, setNodeId] = useState<number>(0);
  const noNodeSelected = nodeId === 0;
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No nodes available — connect a node, or the lab is already placed on every node.
      </p>
    );
  }
  const selected = nodes.find((n) => n.id === nodeId);
  const isSmb = selected?.coldBackend === "smb";
  const blocked = !!selected && !selected.ready;

  return (
    <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="labId" value={labId} />
      <div>
        <Label>Node</Label>
        <Select
          name="nodeId"
          required
          value={noNodeSelected ? "" : nodeId}
          onChange={(e) => setNodeId(Number(e.target.value))}
        >
          <option value="" disabled>
            Select node…
          </option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} {n.online ? "(online)" : "(offline)"} {n.coldBackend === "smb" ? "· SMB" : ""}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Fast quota (TB)</Label>
        <Input name="fastTb" type="number" step="0.5" defaultValue={defaultFastTb} />
      </div>
      <div>
        <Label>Cold quota (TB)</Label>
        {isSmb ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Managed by owner {selected?.ownerName ?? "—"}
          </p>
        ) : (
          <Input name="coldTb" type="number" step="0.5" defaultValue={defaultColdTb} />
        )}
      </div>
      <div>
        <Label>Base image</Label>
        <Input name="image" defaultValue="ghcr.io/ec061/custom-ssh:latest" />
      </div>
      <div>
        <Label>CPUs</Label>
        <Input name="cpus" defaultValue="4" />
      </div>
      <div>
        <Label>RAM</Label>
        <Input name="memory" defaultValue="8g" />
      </div>
      <div>
        <Label>Shared memory</Label>
        <Input name="shmSize" defaultValue="1g" />
      </div>
      <div>
        <Label>Root filesystem quota</Label>
        <Input name="rootfsQuota" defaultValue="300g" />
      </div>
      <div>
        <Label>Restart policy</Label>
        <Input name="restart" defaultValue="unless-stopped" />
      </div>
      <StudentQuotaFields allowCold={!isSmb} />
      <div className="sm:col-span-2 lg:col-span-3">
        {blocked && (
          <p className="mb-2 text-sm text-amber-600">{selected?.blockedReason}</p>
        )}
        <p className="mb-2 text-xs text-muted-foreground">
          The SSH port is allocated automatically on the node. Container options are frozen after
          creation (change them via the placement&apos;s recreate action). Per-student quotas apply
          equally to every student on this placement and require recreation to change later.
          All GPUs are always attached.
        </p>
        <Button type="submit" disabled={blocked || noNodeSelected}>
          Grant node access
        </Button>
      </div>
    </form>
  );
}
