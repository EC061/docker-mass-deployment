"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

export function ThemeToggle() {
  // Start as null so the first client render matches the server (no theme-specific label),
  // then sync to whatever the pre-paint inline script put on <html>.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // One-time read of the theme the pre-paint inline script wrote to <html>; the server can't
    // know it, so we sync after mount. This is the intended use of the escape hatch below.
    const current = document.documentElement.getAttribute("data-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current === "light" ? "light" : "dark");
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode / storage disabled — theme just won't persist */
    }
  }

  // Render a stable label until the effect resolves the real theme.
  const label = theme === "light" ? "🌙  Dark mode" : "☀️  Light mode";
  return (
    <button type="button" className="theme-toggle" onClick={toggle} suppressHydrationWarning>
      {theme === null ? "Theme" : label}
    </button>
  );
}
