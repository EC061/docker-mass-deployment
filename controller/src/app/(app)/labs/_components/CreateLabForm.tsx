"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface NodeOpt {
  id: number;
  name: string;
  online: number;
}

export interface LabTemplate {
  id: number;
  name: string;
  image: string;
  fastTb: number;
  slowTb: number;
  cpus: string;
  memory: string;
  shmSize: string;
  imageQuota: string;
  restart: string;
}

interface Props {
  nodes: NodeOpt[];
  labs: LabTemplate[];
  defaultFastTb: number;
  defaultSlowTb: number;
  action: (formData: FormData) => void | Promise<void>;
}

export function CreateLabForm({ nodes, labs, defaultFastTb, defaultSlowTb, action }: Props) {
  const blank: Omit<LabTemplate, "id" | "name"> = {
    image: "custom-ssh",
    fastTb: defaultFastTb,
    slowTb: defaultSlowTb,
    cpus: "4",
    memory: "8g",
    shmSize: "1g",
    imageQuota: "300g",
    restart: "unless-stopped",
  };
  const [copyFrom, setCopyFrom] = useState<number>(0);
  const [cfg, setCfg] = useState(blank);

  function onCopyFromChange(id: number) {
    setCopyFrom(id);
    const src = labs.find((l) => l.id === id);
    if (src) {
      const { id: _id, name: _name, ...rest } = src;
      void _id;
      void _name;
      setCfg(rest);
    } else {
      setCfg(blank);
    }
  }

  const set = (patch: Partial<typeof cfg>) => setCfg((c) => ({ ...c, ...patch }));

  return (
    <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {labs.length > 0 && (
        <div className="flex flex-wrap items-end gap-4 sm:col-span-2 lg:col-span-3">
          <div className="min-w-[220px] flex-1">
            <Label>Copy configuration from</Label>
            <Select
              name="copyFromLabId"
              value={copyFrom}
              onChange={(e) => onCopyFromChange(Number(e.target.value))}
            >
              <option value={0}>— start from defaults —</option>
              {labs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <label
            className={`flex items-center gap-2 text-sm text-muted-foreground ${copyFrom ? "" : "opacity-50"}`}
          >
            <input type="checkbox" name="copyStudents" disabled={!copyFrom} className="accent-primary" />
            Also enroll the same students
          </label>
        </div>
      )}

      <div>
        <Label>Name</Label>
        <Input name="name" required placeholder="bio-x" />
      </div>
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
        <Label>PI email</Label>
        <Input name="piEmail" type="email" placeholder="pi@uga.edu" />
      </div>
      <div>
        <Label>Base image</Label>
        <Input name="image" value={cfg.image} onChange={(e) => set({ image: e.target.value })} />
      </div>
      <div>
        <Label>Fast quota (TB)</Label>
        <Input
          name="fastTb"
          type="number"
          step="0.5"
          value={cfg.fastTb}
          onChange={(e) => set({ fastTb: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Slow quota (TB)</Label>
        <Input
          name="slowTb"
          type="number"
          step="0.5"
          value={cfg.slowTb}
          onChange={(e) => set({ slowTb: Number(e.target.value) })}
        />
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <span className="text-xs text-muted-foreground">
          Container options below are set at creation; changing them later (from the lab page)
          recreates the container with data preserved. All GPUs are always attached.
        </span>
      </div>
      <div>
        <Label>CPUs</Label>
        <Input name="cpus" value={cfg.cpus} onChange={(e) => set({ cpus: e.target.value })} />
      </div>
      <div>
        <Label>RAM</Label>
        <Input name="memory" value={cfg.memory} onChange={(e) => set({ memory: e.target.value })} />
      </div>
      <div>
        <Label>Shared memory</Label>
        <Input name="shmSize" value={cfg.shmSize} onChange={(e) => set({ shmSize: e.target.value })} />
      </div>
      <div>
        <Label>Image size quota</Label>
        <Input name="imageQuota" value={cfg.imageQuota} onChange={(e) => set({ imageQuota: e.target.value })} />
      </div>
      <div>
        <Label>Restart policy</Label>
        <Input name="restart" value={cfg.restart} onChange={(e) => set({ restart: e.target.value })} />
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit">Create lab</Button>
      </div>
    </form>
  );
}
