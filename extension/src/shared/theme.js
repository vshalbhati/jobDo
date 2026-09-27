// Light or dark for the extension's own pages: the same choice as the
// dashboard's toggle, kept in this browser under "dashTheme". Unset means
// following the system.
export async function applyTheme() {
  try {
    const { dashTheme } = await chrome.storage.local.get('dashTheme');
    if (dashTheme) document.documentElement.dataset.theme = dashTheme;
  } catch { /* storage unavailable: follow the system */ }
}

export async function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  await chrome.storage.local.set({ dashTheme: root.dataset.theme });
}
