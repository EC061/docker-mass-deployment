import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { clearSessionCookie, currentAdmin } from "@/lib/auth";

// Authed pages read cookies/DB per request — never statically prerender them.
export const dynamic = "force-dynamic";

async function logout() {
  "use server";
  await clearSessionCookie();
  redirect("/login");
}

const NAV = [
  ["/dashboard", "Dashboard"],
  ["/nodes", "Nodes"],
  ["/labs", "Labs"],
  ["/students", "Students"],
  ["/gpu", "GPU"],
  ["/logs", "Logs"],
  ["/settings", "Settings"],
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Lab Manager</h1>
        <nav>
          {NAV.map(([href, label]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <form action={logout} style={{ marginTop: 24 }}>
          <button type="submit" style={{ background: "var(--panel-2)" }}>
            Sign out
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>{admin.email}</p>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
