"use client";

import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = Omit<ButtonProps, "onClick"> & {
  /** Message shown in the confirmation dialog. Submitting only proceeds if the admin confirms. */
  confirm: string;
  /** Heading for the dialog. */
  title?: string;
  /** Destructive action label. Defaults to a generic confirmation label. */
  confirmLabel?: string;
};

/**
 * A button that opens a styled confirmation dialog before submitting its surrounding form's Server
 * Action. Used for every destructive action (destroy lab, remove student, delete node) so a delete is
 * never a single mis-click. On confirm it calls requestSubmit() on the closest <form> — every
 * destructive form carries its inputs as hidden fields, so no submitter value is needed.
 */
export function ConfirmButton({
  confirm: message,
  title = "Are you sure?",
  confirmLabel = "Confirm",
  children,
  variant = "outline",
  ...rest
}: Props) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  function onConfirm() {
    setOpen(false);
    triggerRef.current?.closest("form")?.requestSubmit();
  }

  return (
    <>
      <Button ref={triggerRef} type="button" variant={variant} onClick={() => setOpen(true)} {...rest}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-3rem)]">
          <DialogHeader className="min-h-0 overflow-y-auto p-5 pr-12 sm:p-6 sm:pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="shrink-0 border-t border-border bg-card p-4 sm:p-5">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" className="w-full sm:w-auto" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
