"use client";

import { usePathname } from "next/navigation";

const NAV: [string, string][] = [
  ["/dashboard", "Dashboard"],
  ["/nodes", "Nodes"],
  ["/labs", "Labs"],
  ["/students", "Students"],
  ["/gpu", "GPU"],
  ["/logs", "Logs"],
  ["/settings", "Settings"],
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav>
      {NAV.map(([href, label]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <a key={href} href={href} className={active ? "active" : undefined}>
            {label}
          </a>
        );
      })}
    </nav>
  );
}
