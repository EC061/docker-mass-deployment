import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { clearSessionCookie, currentAdmin } from "@/lib/auth";
import { NavLinks } from "./_components/NavLinks";
import { ThemeToggle } from "./_components/ThemeToggle";

// Authed pages read cookies/DB per request — never statically prerender them.
export const dynamic = "force-dynamic";

async function logout() {
  "use server";
  await clearSessionCookie();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Lab Manager</h1>
        <NavLinks />
        <div className="sidebar-footer">
          <form action={logout}>
            <button type="submit" className="secondary">
              Sign out
            </button>
          </form>
          <ThemeToggle />
          <p className="muted" style={{ marginTop: 16, fontSize: 12, wordBreak: "break-all" }}>
            {admin.email}
          </p>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
