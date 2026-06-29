"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface NodeOpt {
  id: number;
  name: string;
  online: number;
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
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No nodes available — connect a node, or the lab is already placed on every node.
      </p>
    );
  }
  return (
    <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="labId" value={labId} />
      <div>
        <Label>Node</Label>
        <Select name="nodeId" required defaultValue="">
          <option value="" disabled>
            Select node…
          </option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} {n.online ? "(online)" : "(offline)"}
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
        <Input name="coldTb" type="number" step="0.5" defaultValue={defaultColdTb} />
      </div>
      <div>
        <Label>Base image</Label>
        <Input name="image" defaultValue="custom-ssh" />
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
        <Label>Image size quota</Label>
        <Input name="imageQuota" defaultValue="300g" />
      </div>
      <div>
        <Label>Restart policy</Label>
        <Input name="restart" defaultValue="unless-stopped" />
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <p className="mb-2 text-xs text-muted-foreground">
          The SSH port is allocated automatically on the node. Container options are frozen after
          creation (change them via the placement&apos;s recreate action). All GPUs are always attached.
        </p>
        <Button type="submit">Grant node access</Button>
      </div>
    </form>
  );
}
