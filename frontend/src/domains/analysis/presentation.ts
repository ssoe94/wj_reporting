export type Translate = (ko: string, zh: string) => string;
export function formatQuantity(value: number | null | undefined, lang: string, decimals = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: decimals }).format(value) : '—';
}
export function formatTime(value: string | null | undefined, lang: string) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'ko-KR', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}
