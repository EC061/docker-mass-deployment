"use client";

import { usePathname } from "next/navigation";
import {
  Bell,
  Cpu,
  FlaskConical,
  HardDrive,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV: [string, string, LucideIcon][] = [
  ["/dashboard", "Dashboard", LayoutDashboard],
  ["/nodes", "Nodes", Server],
  ["/labs", "Labs", FlaskConical],
  ["/students", "Students", Users],
  ["/stats", "Stats", HardDrive],
  ["/gpu", "GPU", Cpu],
  ["/logs", "Logs", ScrollText],
  ["/announcements", "Announce", Bell],
  ["/settings", "Settings", Settings],
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(([href, label, Icon]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <a
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors no-underline hover:bg-accent hover:text-accent-foreground",
              active
                ? "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary"
                : "text-sidebar-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
