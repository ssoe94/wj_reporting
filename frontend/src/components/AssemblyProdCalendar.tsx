import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko, zhCN } from 'date-fns/locale';
import dayjs from 'dayjs';
import { useLang } from '../i18n';

interface Props {
  onSelect: (date: string) => void;
  selected: string | null;
  availableDates?: string[];
}

export default function AssemblyProdCalendar({ onSelect, selected, availableDates }: Props) {
  const { lang } = useLang();
  
  // 날짜 목록을 Set으로 변환
  const datesWithData = new Set(availableDates || []);

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
