import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";

/** Shared sidebar body — rendered both in the fixed desktop rail and inside the mobile Sheet. */
export function SidebarContent({
  email,
  logout,
}: {
  email: string;
  logout: () => void | Promise<void>;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-2 px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          L
        </span>
        <span className="text-sm font-semibold tracking-tight">Lab Manager</span>
      </div>

      <NavLinks />

      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
        <form action={logout}>
          <button
            type="submit"
            className="w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Sign out
          </button>
        </form>
        <ThemeToggle />
        <p className="break-all px-1 text-xs text-muted-foreground">{email}</p>
      </div>
    </div>
  );
}
