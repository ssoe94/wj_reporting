import React from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { useLang } from '../../i18n';
import { ko } from 'date-fns/locale';

interface PlanCalendarProps {
  planDates: {
    injection: Date[];
    machining: Date[];
  };
  selectedDate: Date | undefined;
  onSelectDate: (date: Date | undefined) => void;
  className?: string;
}

const PlanCalendar: React.FC<PlanCalendarProps> = ({
  planDates,
  selectedDate,
  onSelectDate,
  className,
}) => {
  const { lang, t } = useLang();

  const modifiers = {
    injection: planDates.injection,
    machining: planDates.machining,
    both: planDates.injection.filter(d1 =>
      planDates.machining.some(d2 => d1.getTime() === d2.getTime())
    ),
  };

  const modifiersStyles = {
    injection: {
      color: '#2563eb',
      fontWeight: 'bold',
    },
    machining: {
      color: '#16a34a',
      fontWeight: 'bold',
    },
    both: {
      color: '#9333ea',
      fontWeight: 'bold',
      textDecoration: 'underline',
    },
  };

  const dayPickerStyles = {
    root: { width: '100%' },
    months: { width: '100%' },
  };

  return (
    <div className={`bg-white rounded-xl shadow p-4 flex flex-col items-center ${className ?? ''}`}>
        <style>{`
        .rdp,
        .rdp-root {
            display: block;
            width: 100%;
            max-width: 320px;
            margin: 0 auto;
        }
        .rdp-months {
            width: 100%;
            max-width: 320px;
            margin: 0 auto;
        }
        .rdp-month {
            width: 100%;
            flex: 1 1 auto;
        }
        .rdp-day_both {
            position: relative;
            text-decoration: none !important;
        }
        .rdp-day_both::after {
            content: '';
            position: absolute;
            bottom: 2px;
            left: 15%;
            right: 15%;
            height: 3px;
            background: linear-gradient(to right, ${modifiersStyles.injection.color} 50%, ${modifiersStyles.machining.color} 50%);
        }
        `}</style>
      <DayPicker
        styles={dayPickerStyles}
        mode="single"
        selected={selectedDate}
        onSelect={onSelectDate}
        modifiers={modifiers}
        modifiersStyles={modifiersStyles}
        locale={lang === 'ko' ? ko : undefined}
        footer={
            <div className="mt-4 text-sm flex items-center justify-center gap-4">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full" style={{backgroundColor: modifiersStyles.injection.color}}></div>{t('plan_toggle_injection')}</div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full" style={{backgroundColor: modifiersStyles.machining.color}}></div>{t('plan_toggle_machining')}</div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full" style={{background: `linear-gradient(to right, ${modifiersStyles.injection.color} 50%, ${modifiersStyles.machining.color} 50%)`}}></div>{t('plan_both')}</div>
            </div>
        }
      />
    </div>
  );
};

export default PlanCalendar;
