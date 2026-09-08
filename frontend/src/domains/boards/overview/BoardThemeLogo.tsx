import type { AppLanguage } from "@/shared/i18n/language";
import type { BoardTheme } from "./theme";
import styles from "./BoardThemeLogo.module.css";

export function BoardThemeLogo({ theme, language, onToggle }: {
  theme: BoardTheme;
  language: AppLanguage;
  onToggle: () => void;
}) {
  const isDark = theme === "dark";
  const label = language === "ko" ? "WJ 다크 모드" : "WJ 深色模式";
  const action = language === "ko"
    ? `${isDark ? "라이트" : "다크"} 모드로 전환 · 북경 시간 08:00/20:00 자동 전환`
    : `切换至${isDark ? "浅色" : "深色"}模式 · 北京时间 08:00/20:00 自动切换`;
  return (
    <button className={styles.logoButton} aria-label={label} aria-pressed={isDark} title={action} onClick={onToggle} type="button">
      <img alt="" src="/logo-transparent.png" width="96" height="96" />
    </button>
  );
}
