export type AppTheme = 'light' | 'dark';

export const APP_THEME_STORAGE_KEY = 'wj:appearance:v1';
// Appearance hint only, bound to the current auth generation; never grants access.
export const FIELD_APPEARANCE_SESSION_KEY = 'wj:appearance:field-session:v1';

export function isFieldAppearance(pathname: string, fieldTerminal = false): boolean {
  return fieldTerminal || /^\/field(?:\/|$)/.test(pathname);
}

export function isInjectionBoardAppearance(pathname: string): boolean {
  return /^\/(?:boards\/injection|(?:next\/)?production\/injection-board)(?:\/|$)/.test(pathname);
}

export function resolveAppTheme(preferred: AppTheme, liteMode: boolean, legacyAppearance: boolean): AppTheme {
  return liteMode || legacyAppearance ? 'light' : preferred;
}

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function parseAppTheme(value: unknown): AppTheme {
  return value === 'dark' ? 'dark' : 'light';
}

export function readAppTheme(storage?: Pick<ThemeStorage, 'getItem'>): AppTheme {
  try {
    return parseAppTheme(storage?.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return 'light';
  }
}

export function rememberAppTheme(theme: AppTheme, storage?: Pick<ThemeStorage, 'setItem'>): boolean {
  try {
    if (!storage) return false;
    storage.setItem(APP_THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
