import React from 'react';
import ReactDOM from 'react-dom';
import dayjs from 'dayjs';
import 'dayjs/locale/ko';
import 'dayjs/locale/zh-cn';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko as dfKo, zhCN } from 'date-fns/locale';
import { Button } from './ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type LocaleCode = 'ko' | 'zh';

interface DateTimeFieldProps {
  value?: string; // 'YYYY-MM-DDTHH:mm'
  onChange: (value: string) => void;
  locale: LocaleCode;
  minuteStep?: 5 | 10 | 15;
}

const LABELS: Record<LocaleCode, Record<string, string>> = {
  ko: { confirm: '확인', cancel: '취소', now: '지금', today: '오늘', },
  zh: { confirm: '确定', cancel: '取消', now: '现在', today: '今天', },
};

const hourOptions = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const minuteOptions = (step: number) => Array.from({ length: Math.floor(60 / step) }, (_, i) => String(i * step).toString().padStart(2, '0'));

function toLocalIso(d: Date, hh: string, mm: string) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(hh), Number(mm), 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) +
    'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes())
  );
}

export default function DateTimeField({ value, onChange, locale, minuteStep = 5 }: DateTimeFieldProps) {
  const L = LABELS[locale];
  const selected = value ? dayjs(value).toDate() : new Date();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState<Date>(selected);
  const [month, setMonth] = React.useState<Date>(dayjs(selected).startOf('month').toDate());
  const [hh, setHh] = React.useState<string>(dayjs(selected).format('HH'));
  const [mm, setMm] = React.useState<string>(dayjs(selected).format('mm'));

  const dayjsLocale = locale === 'zh' ? 'zh-cn' : 'ko';
  const summary = locale === 'zh' 
    ? dayjs(toLocalIso(date, hh, mm)).locale(dayjsLocale).format('M月D日(ddd) HH:mm')
    : dayjs(toLocalIso(date, hh, mm)).locale(dayjsLocale).format('M월 D일(ddd) HH:mm');

  const dialogPanel = (
    <div className="w-[340px] bg-white rounded-lg shadow-xl border overflow-hidden">
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-2.5 border-b flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{summary}</span>
        <button type="button" className="text-gray-400 hover:text-gray-600 transition-colors" onClick={()=> setOpen(false)}>✕</button>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between px-2">
          <button type="button" onClick={()=> setMonth(dayjs(month).subtract(1,'month').toDate())} className="p-1.5 rounded hover:bg-gray-100 transition-colors"><ChevronLeft className="w-4 h-4 text-gray-600"/></button>
          <div className="text-sm font-semibold text-gray-800">{dayjs(month).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
          <button type="button" onClick={()=> setMonth(dayjs(month).add(1,'month').toDate())} className="p-1.5 rounded hover:bg-gray-100 transition-colors"><ChevronRight className="w-4 h-4 text-gray-600"/></button>
        </div>
        <DayPicker
          mode="single"
          month={month}
          onMonthChange={(d)=> setMonth(d)}
          selected={date}
          onSelect={(d)=> d && setDate(d)}
          locale={locale==='zh'? zhCN : dfKo}
          weekStartsOn={1}
          className="mx-auto"
          classNames={{
            month: 'w-full',
            day: 'h-8 w-8 text-sm rounded hover:bg-blue-50 transition-colors',
            day_selected: 'bg-blue-500 text-white font-semibold hover:bg-blue-600',
            day_today: 'font-bold text-blue-600',
            nav: 'hidden',
            caption: 'hidden',
            head_cell: 'text-xs font-medium text-gray-500 w-8',
            table: 'w-full border-collapse',
            row: 'mt-0.5',
          }}
        />
        <div className="flex items-center justify-center gap-2 pt-2 border-t">
          <select className="h-9 px-2 w-20 border rounded text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={hh} onChange={(e)=> setHh(e.target.value)}>{hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}</select>
          <span className="text-gray-400">:</span>
          <select className="h-9 px-2 w-20 border rounded text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={mm} onChange={(e)=> setMm(e.target.value)}>{minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}</select>
        </div>
      </div>
      <div className="bg-gray-50 border-t px-4 py-2.5 flex justify-between items-center">
        <Button type="button" size="sm" variant="ghost" onClick={()=>{ const n=dayjs(); setDate(n.toDate()); setHh(n.format('HH')); setMm(n.format('mm')); }}>{L.now}</Button>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={()=> setOpen(false)}>{L.cancel}</Button>
          <Button type="button" size="sm" onClick={()=>{ onChange(toLocalIso(date, hh, mm)); setOpen(false); }}>{L.confirm}</Button>
        </div>
      </div>
    </div>
  );

  const inputRef = React.useRef<HTMLButtonElement>(null);
  const [position, setPosition] = React.useState({ top: 0, left: 0 });

  React.useEffect(() => {
    if (open && inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      const dialogWidth = 340;
      const dialogHeight = 420;
      
      let left = rect.left;
      let top = rect.bottom + 8;
      
      // 화면 오른쪽을 벗어나는 경우
      if (left + dialogWidth > window.innerWidth) {
        left = window.innerWidth - dialogWidth - 16;
      }
      
      // 화면 왼쪽을 벗어나는 경우
      if (left < 16) {
        left = 16;
      }
      
      // 화면 아래를 벗어나는 경우 위쪽에 표시
      if (top + dialogHeight > window.innerHeight) {
        top = rect.top - dialogHeight - 8;
      }
      
      // 위쪽도 공간이 부족한 경우 화면 중앙에 표시
      if (top < 16) {
        top = (window.innerHeight - dialogHeight) / 2;
        left = (window.innerWidth - dialogWidth) / 2;
      }
      
      setPosition({ top, left });
    }
  }, [open]);

  return (
    <div className="relative">
      <button 
        ref={inputRef}
        type="button" 
        className="w-full text-left px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-50 transition-colors text-sm"
        onClick={()=> setOpen(true)}
      >
        {summary}
      </button>
      {open && ReactDOM.createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={()=> setOpen(false)} />
          <div 
            className="fixed z-[61]" 
            style={{ top: `${position.top}px`, left: `${position.left}px` }}
          >
            {dialogPanel}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}


