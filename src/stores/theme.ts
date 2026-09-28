// Appearance theme: light / dark / system. Persisted, applied via
// `document.documentElement.dataset.theme` so CSS variables can switch.

export type ThemeChoice = "light" | "dark" | "system";

const LS_THEME = "muse-desktop.theme.v1";

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(LS_THEME);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "light";
}

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  try {
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  } catch {
    /* ignore */
  }
  return "light";
}

export function applyTheme(choice: ThemeChoice): void {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(LS_THEME, choice);
  } catch {
    /* ignore */
  }
  // Keep form controls and scrollbars consistent with the theme.
  try {
    document.documentElement.style.colorScheme = resolved;
  } catch {
    /* ignore */
  }
}

export function initTheme(): ThemeChoice {
  const choice = getThemeChoice();
  applyTheme(choice);
  try {
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      .addEventListener?.("change", () => applyTheme(getThemeChoice()));
  } catch {
    /* older WebView: skip live system follow */
  }
  return choice;
}
