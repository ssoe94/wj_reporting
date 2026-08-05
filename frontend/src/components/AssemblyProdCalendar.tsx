import { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko, zhCN } from 'date-fns/locale';
import dayjs from 'dayjs';
import { CalendarDays, CheckCircle2 } from 'lucide-react';
import { useLang } from '../i18n';
import { CalendarChevron } from './common/CalendarChevron';

interface Props {
  onSelect: (date: string) => void;
  selected: string | null;
  availableDates?: string[];
}

export default function AssemblyProdCalendar({ onSelect, selected, availableDates }: Props) {
  const { lang } = useLang();

  const datesWithData = useMemo(() => new Set(availableDates || []), [availableDates]);
  const latestDate = availableDates?.[0];
  const initialMonth = selected || latestDate;
  const [month, setMonth] = useState(initialMonth ? dayjs(initialMonth).toDate() : new Date());

  useEffect(() => {
    if (selected) setMonth(dayjs(selected).toDate());
  }, [selected]);

  const modifiers = {
    hasData: (d: Date) => datesWithData.has(dayjs(d).format('YYYY-MM-DD')),
  } as const;

  const modifiersClassNames = { hasData: 'assembly-calendar__has-data' } as const;

  const disabled = (d: Date) => !datesWithData.has(dayjs(d).format('YYYY-MM-DD'));

  return (
    <div className="assembly-calendar-card">
      <div className="assembly-calendar-card__header">
        <span className="assembly-calendar-card__icon" aria-hidden="true">
          <CalendarDays />
        </span>
        <div>
          <span>{lang === 'zh' ? '生产记录日期' : '생산 기록 날짜'}</span>
          <strong>
            {selected
              ? dayjs(selected).format(lang === 'zh' ? 'YYYY年 M月 D日' : 'YYYY년 M월 D일')
              : (lang === 'zh' ? '请选择日期' : '날짜를 선택하세요')}
          </strong>
        </div>
      </div>
      <DayPicker
        components={{ Chevron: CalendarChevron }}
        mode="single"
        locale={lang === 'zh' ? zhCN : ko}
        month={month}
        onMonthChange={setMonth}
        selected={selected ? dayjs(selected).toDate() : undefined}
        onSelect={(d) => d && onSelect(dayjs(d).format('YYYY-MM-DD'))}
        modifiers={modifiers}
        modifiersClassNames={modifiersClassNames}
        disabled={disabled}
        showOutsideDays
        className="assembly-calendar"
      />
      <div className="assembly-calendar-card__hint">
        <CheckCircle2 aria-hidden="true" />
        <span>
          {lang === 'zh'
            ? '仅可选择已有生产记录的日期。'
            : '생산 기록이 있는 날짜만 선택할 수 있습니다.'}
        </span>
      </div>
    </div>
  );
}
