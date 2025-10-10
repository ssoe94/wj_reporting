
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko, zhCN } from 'date-fns/locale';
import dayjs from 'dayjs';
import { useLang } from '@/i18n';

interface Props {
  onSelect: (date: string) => void;
  selected: string | null;
  availableDates: string[];
}

export default function ProdCalendar({ onSelect, selected, availableDates }: Props) {
  const { lang } = useLang();
  const datesWithData = new Set(availableDates);

  const modifiers = {
    hasData: (d: Date) => datesWithData.has(dayjs(d).format('YYYY-MM-DD')),
  } as const;

  const modifiersClassNames = {
    hasData: 'bg-blue-300/70 text-blue-800 hover:bg-blue-400/80 font-medium',
    selected: 'bg-blue-600 text-white font-bold',
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