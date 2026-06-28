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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
