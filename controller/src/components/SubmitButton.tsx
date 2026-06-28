"use client";

/**
 * A form submit button that reflects the pending state of its enclosing <form>. While the server
 * action runs it disables itself and swaps its leading icon for a spinner (optionally showing
 * `pendingText`), so the user gets immediate feedback instead of a dead-looking button.
 *
 * useFormStatus tracks the *nearest* parent form, so give each action its own <form> when you want
 * independent per-button feedback rather than every button in a shared form spinning at once.
 */

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

interface SubmitButtonProps extends Omit<ButtonProps, "type"> {
  /** Leading icon shown when idle (replaced by a spinner while pending). */
  icon?: React.ReactNode;
  /** Optional label to show while the action runs (defaults to children). */
  pendingText?: React.ReactNode;
}

export function SubmitButton({ icon, pendingText, children, ...props }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} aria-busy={pending} {...props}>
      {pending ? <Loader2 className="animate-spin" /> : icon}
      {pending && pendingText ? pendingText : children}
    </Button>
  );
}
