import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { clearSessionCookie, currentAdmin } from "@/lib/auth";
import { MobileNav } from "./_components/MobileNav";
import { SidebarContent } from "./_components/SidebarContent";

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
    <div className="min-h-screen">
      {/* Fixed sidebar on desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-sidebar md:block">
        <SidebarContent email={admin.email} logout={logout} />
      </aside>

      <div className="flex min-h-screen flex-col md:pl-64">
        {/* Hamburger top bar on mobile; the same sidebar body slides in as a Sheet */}
        <MobileNav>
          <SidebarContent email={admin.email} logout={logout} />
        </MobileNav>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
