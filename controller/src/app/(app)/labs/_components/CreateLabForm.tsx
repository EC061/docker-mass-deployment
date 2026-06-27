"use client";

import { useState } from "react";

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
    <form action={action} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      {labs.length > 0 && (
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Copy configuration from</label>
            <select
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
            </select>
          </div>
          <label
            className="muted"
            style={{ margin: 0, display: "inline-flex", gap: 6, alignItems: "center", opacity: copyFrom ? 1 : 0.5 }}
          >
            <input type="checkbox" name="copyStudents" disabled={!copyFrom} style={{ width: "auto" }} />
            Also enroll the same students
          </label>
        </div>
      )}

      <div>
        <label>Name</label>
        <input name="name" required placeholder="bio-x" />
      </div>
      <div>
        <label>Node</label>
        <select name="nodeId" required defaultValue="">
          <option value="" disabled>
            Select node…
          </option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} {n.online ? "(online)" : "(offline)"}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>PI email</label>
        <input name="piEmail" type="email" placeholder="pi@uga.edu" />
      </div>
      <div>
        <label>Base image</label>
        <input name="image" value={cfg.image} onChange={(e) => set({ image: e.target.value })} />
      </div>
      <div>
        <label>Fast quota (TB)</label>
        <input
          name="fastTb"
          type="number"
          step="0.5"
          value={cfg.fastTb}
          onChange={(e) => set({ fastTb: Number(e.target.value) })}
        />
      </div>
      <div>
        <label>Slow quota (TB)</label>
        <input
          name="slowTb"
          type="number"
          step="0.5"
          value={cfg.slowTb}
          onChange={(e) => set({ slowTb: Number(e.target.value) })}
        />
      </div>
      <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Container options below are set at creation; changing them later (from the lab page)
          recreates the container with data preserved. All GPUs are always attached.
        </span>
      </div>
      <div>
        <label>CPUs</label>
        <input name="cpus" value={cfg.cpus} onChange={(e) => set({ cpus: e.target.value })} />
      </div>
      <div>
        <label>RAM</label>
        <input name="memory" value={cfg.memory} onChange={(e) => set({ memory: e.target.value })} />
      </div>
      <div>
        <label>Shared memory</label>
        <input name="shmSize" value={cfg.shmSize} onChange={(e) => set({ shmSize: e.target.value })} />
      </div>
      <div>
        <label>Image size quota</label>
        <input name="imageQuota" value={cfg.imageQuota} onChange={(e) => set({ imageQuota: e.target.value })} />
      </div>
      <div>
        <label>Restart policy</label>
        <input name="restart" value={cfg.restart} onChange={(e) => set({ restart: e.target.value })} />
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <button type="submit" style={{ width: 160 }}>
          Create lab
        </button>
      </div>
    </form>
  );
}
