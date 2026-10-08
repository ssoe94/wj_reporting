/** Choose an explicitly bilingual Korean/Chinese display label; preserve custom names and IDs. */
export function inspectionDisplayLabel(value: string, lang: 'ko' | 'zh'): string {
  const parts = value.split(/\s+\/\s+/);
  if (parts.length !== 2) return value;
  const korean = parts.find((part) => /[가-힣]/.test(part) && !/[\u3400-\u9fff]/.test(part));
  const chinese = parts.find((part) => /[\u3400-\u9fff]/.test(part) && !/[가-힣]/.test(part));
  return korean && chinese ? (lang === 'ko' ? korean : chinese) : value;
}
