import { notFound } from "next/navigation";
import { takeFlash } from "@/lib/flash";
import { containerOptionsOf, getPlacement } from "@/lib/placements";
import { recreatePlacementSettingsAction } from "../../../../actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StudentQuotaFields } from "../../../../_components/StudentQuotaFields";
import { TIB } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function RecreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; placementId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, placementId } = await params;
  const { error } = await searchParams;
  const errMsg = error ? takeFlash(error) : null;
  const placement = getPlacement(Number(placementId));
  if (!placement || placement.lab_id !== Number(id)) notFound();
  const opts = containerOptionsOf(placement);

  const field = (label: string, name: string, value: string) => (
    <div>
      <Label>{label}</Label>
      <Input name={name} defaultValue={value} />
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        Recreate container — {placement.lab_name} on {placement.node_name}
      </h1>

      <Card>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Recreating applies the settings below and rebuilds the container. The node validates and
            pulls the image, brings up a <b>candidate</b> alongside the preserved current container,
            verifies SSH/systemd readiness, and only then promotes it — rolling back to the previous
            container if anything fails. All fast/cold data is preserved (it lives in ZFS datasets).
          </p>
          <p>
            Current: image <b>{placement.image}</b> · {opts.cpus} CPU · {opts.memory} RAM ·{" "}
            {opts.shm_size} shm · rootfs-quota {opts.rootfs_quota} · restart {opts.restart}
          </p>
        </CardContent>
      </Card>

      {errMsg && (
        <Card className="border-destructive/50">
          <CardContent>
            <p className="text-sm text-destructive">{errMsg}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-base font-semibold">Proposed settings</h3>
          <form action={recreatePlacementSettingsAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input type="hidden" name="placementId" value={placement.id} />
            {field("Base image", "image", placement.image)}
            {field("CPUs", "cpus", opts.cpus)}
            {field("RAM", "memory", opts.memory)}
            {field("Shared memory", "shmSize", opts.shm_size)}
            {field("Root filesystem quota", "rootfsQuota", opts.rootfs_quota)}
            {field("Restart policy", "restart", opts.restart)}
            <StudentQuotaFields
              allowCold={placement.node_cold_backend !== "smb"}
              fastDefault={placement.student_fast_quota_bytes == null ? null : placement.student_fast_quota_bytes / TIB}
              coldDefault={placement.student_cold_quota_bytes == null ? null : placement.student_cold_quota_bytes / TIB}
            />
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit">Recreate container</Button>
              <a href={`/labs/${id}`} className="text-sm text-muted-foreground hover:underline">
                Cancel
              </a>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
