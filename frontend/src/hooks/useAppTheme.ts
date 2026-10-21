import { useContext } from 'react';
import { AppThemeContext } from '../contexts/AppThemeContext';

export function useAppTheme() {
  const context = useContext(AppThemeContext);
  if (!context) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return context;
}
