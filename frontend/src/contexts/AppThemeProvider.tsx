import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { parseFieldTerminalUser } from '../lib/fieldTerminal';
import { APP_THEME_STORAGE_KEY, FIELD_APPEARANCE_SESSION_KEY, isFieldAppearance, resolveAppTheme, parseAppTheme, readAppTheme, rememberAppTheme } from '../domains/appearance/theme';
import type { AppTheme } from '../domains/appearance/theme';
import { AppThemeContext } from './AppThemeContext';

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { user, authSessionId, isLoading } = useAuth();
  const [bootFieldAppearance] = useState(() => document.documentElement.dataset.fieldAppearance === 'legacy');
  const [theme, updateTheme] = useState<AppTheme>(() => {
    // Access to the storage property itself can throw in managed browsers.
    try { return readAppTheme(window.localStorage); } catch { return 'light'; }
  });
  const [liteMode, setLiteMode] = useState(() => document.documentElement.classList.contains('lite-mode'));
  const fieldTerminal = Boolean(parseFieldTerminalUser(user?.username));
  const fieldAppearance = isFieldAppearance(pathname, fieldTerminal)
    || (isLoading && !user && bootFieldAppearance);
  const effectiveTheme = resolveAppTheme(theme, liteMode, fieldAppearance);

  useEffect(() => {
    const sync = () => setLiteMode(document.documentElement.classList.contains('lite-mode'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.appTheme = effectiveTheme;
    if (fieldAppearance) document.documentElement.dataset.fieldAppearance = 'legacy';
    else delete document.documentElement.dataset.fieldAppearance;
    document.documentElement.style.colorScheme = effectiveTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveTheme === 'dark' ? '#101619' : '#F3F5F7');
  }, [effectiveTheme, fieldAppearance]);

  useEffect(() => {
    if (isLoading) return;
    try {
      if (fieldTerminal && authSessionId) localStorage.setItem(FIELD_APPEARANCE_SESSION_KEY, authSessionId);
      else localStorage.removeItem(FIELD_APPEARANCE_SESSION_KEY);
    } catch { /* The authenticated identity still enforces light in this tab. */ }
  }, [isLoading, fieldTerminal, authSessionId]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === APP_THEME_STORAGE_KEY || event.key === null) updateTheme(parseAppTheme(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const setTheme = (next: AppTheme) => {
    updateTheme(next);
    try { rememberAppTheme(next, window.localStorage); } catch { /* Keep this tab usable without storage. */ }
  };

  const materialTheme = useMemo(() => fieldAppearance ? createTheme() : createTheme({
    palette: {
      mode: effectiveTheme,
      primary: { main: effectiveTheme === 'dark' ? '#57f2b6' : '#006d91', contrastText: effectiveTheme === 'dark' ? '#101619' : '#fff' },
      background: { default: effectiveTheme === 'dark' ? '#101619' : '#f3f5f7', paper: effectiveTheme === 'dark' ? '#192328' : '#fff' },
      text: { primary: effectiveTheme === 'dark' ? '#eff5f6' : '#222b33', secondary: effectiveTheme === 'dark' ? '#adbcc4' : '#5d6872' },
      divider: effectiveTheme === 'dark' ? '#35444c' : '#dce1e5',
    },
    typography: { fontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: 14 },
    shape: { borderRadius: 6 },
    components: {
      MuiTableCell: { styleOverrides: { root: { verticalAlign: 'middle', fontSize: 14 } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    },
  }), [effectiveTheme, fieldAppearance]);

  return <AppThemeContext.Provider value={{ theme: effectiveTheme, setTheme, liteMode, fieldAppearance }}><ThemeProvider theme={materialTheme}>{children}</ThemeProvider></AppThemeContext.Provider>;
}
