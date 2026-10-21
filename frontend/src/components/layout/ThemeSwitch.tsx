import { Moon, Sun } from 'lucide-react';
import { useAppTheme } from '../../hooks/useAppTheme';
import { useLang } from '../../i18n';

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme, liteMode, fieldAppearance } = useAppTheme();
  const { lang } = useLang();
  const light = lang === 'ko' ? '라이트 모드' : '浅色模式';
  const dark = lang === 'ko' ? '다크 모드' : '深色模式';
  const liteHint = lang === 'ko' ? '경량 모드에서는 라이트 화면을 사용합니다' : '轻量模式使用浅色界面';
  const hint = fieldAppearance ? (lang === 'ko' ? '현장 화면은 기존 라이트 화면을 사용합니다' : '现场界面保留原有浅色外观') : liteHint;
  return (
    <div className={`main-theme-switch${compact ? ' main-theme-switch--compact' : ''}`} role="group" aria-label={lang === 'ko' ? '화면 모드' : '显示模式'}>
      <button type="button" disabled={liteMode || fieldAppearance} aria-label={light} title={liteMode || fieldAppearance ? hint : light} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
        <Sun size={15} aria-hidden="true" /><span>{lang === 'ko' ? '라이트' : '浅色'}</span>
      </button>
      <button type="button" disabled={liteMode || fieldAppearance} aria-label={dark} title={liteMode || fieldAppearance ? hint : dark} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
        <Moon size={15} aria-hidden="true" /><span>{lang === 'ko' ? '다크' : '深色'}</span>
      </button>
    </div>
  );
}
