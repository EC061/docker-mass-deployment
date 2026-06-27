"use client";

import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Message shown in the confirmation dialog. Submitting only proceeds if the admin confirms. */
  confirm: string;
};

/**
 * A submit button that pops a native confirmation dialog before letting its form's Server Action
 * run. Used for every destructive action (destroy lab, remove student, delete node) so a delete is
 * never a single mis-click. Cancelling preventDefaults the submit; the surrounding <form action=…>
 * (and any redirect the action performs) is otherwise untouched.
 */
export function ConfirmButton({ confirm: message, children, onClick, ...rest }: Props) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        if (!window.confirm(message)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}
