import { createContext, useContext, useEffect, useState, ReactNode } from "react";

type ThemeCtx = { isDark: boolean; setIsDark: (v: boolean) => void };
const ThemeContext = createContext<ThemeCtx | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("ThemeContext missing");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(false);

  // Init from saved value or system preference
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const prefers = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    setIsDark(saved ? saved === "dark" : !!prefers);
  }, []);

  // Apply document class + persist
  useEffect(() => {
    const cls = document.documentElement.classList;
    isDark ? cls.add("dark") : cls.remove("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
  }, [isDark]);

  return <ThemeContext.Provider value={{ isDark, setIsDark }}>{children}</ThemeContext.Provider>;
}
