import { createContext } from 'react';
import type { AppTheme } from '../domains/appearance/theme';

export const AppThemeContext = createContext<{
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  liteMode: boolean;
  fieldAppearance: boolean;
} | null>(null);
