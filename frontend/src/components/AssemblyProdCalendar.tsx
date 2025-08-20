import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko, zhCN } from 'date-fns/locale';
import dayjs from 'dayjs';
import { useAssemblyReports } from '../hooks/useAssemblyReports';
import { useLang } from '../i18n';

interface Props {
  onSelect: (date: string) => void;
  selected: string | null;
}

export default function AssemblyProdCalendar({ onSelect, selected }: Props) {
  const { data: reportsData } = useAssemblyReports();
  const { lang } = useLang();
  
  // API 응답에서 results 배열을 추출하고, 없으면 빈 배열 사용
  const reports = reportsData?.results || [];
  const datesWithData = new Set(reports.map((r: any) => r.date));

  const modifiers = {
    hasData: (d: Date) => datesWithData.has(dayjs(d).format('YYYY-MM-DD')),
  } as const;

  const modifiersClassNames = {
    hasData: 'bg-green-300/70 text-green-800 hover:bg-green-400/80 font-medium',
    selected: 'bg-green-600 text-white font-bold',
  } as const;

  const disabled = (d: Date) => !datesWithData.has(dayjs(d).format('YYYY-MM-DD'));

  return (
    <DayPicker
      mode="single"
      locale={lang === 'zh' ? zhCN : ko}
      selected={selected ? dayjs(selected).toDate() : undefined}
      onSelect={(d) => d && onSelect(dayjs(d).format('YYYY-MM-DD'))}
      modifiers={modifiers}
      modifiersClassNames={modifiersClassNames}
      disabled={disabled}
      className="p-2 rounded border shadow-sm max-w-fit"
    />
  );
}