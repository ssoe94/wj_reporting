import React from 'react';
import ReactDOM from 'react-dom';
import dayjs from 'dayjs';
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

  const summary = dayjs(toLocalIso(date, hh, mm)).format('M/D(dd) HH:mm');

  const dialogPanel = (
    <div className="w-full md:w-[420px] bg-white rounded-2xl shadow-xl border max-h-[80vh] overflow-hidden">
      <div className="sticky top-0 z-10 bg-white p-4 border-b text-xs text-gray-600">
        {summary}
        <button type="button" className="float-right text-gray-400 hover:text-gray-600" onClick={()=> setOpen(false)}>✕</button>
      </div>
      <div className="p-5 grid grid-rows-[24px_320px_48px] gap-2 justify-items-center">
        <div className="flex items-center justify-center gap-3 w-[300px]">
          <button type="button" onClick={()=> setMonth(dayjs(month).subtract(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronLeft className="w-4 h-4"/></button>
          <div className="text-sm font-semibold">{dayjs(month).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
          <button type="button" onClick={()=> setMonth(dayjs(month).add(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronRight className="w-4 h-4"/></button>
        </div>
        <DayPicker
          mode="single"
          month={month}
          onMonthChange={(d)=> setMonth(d)}
          selected={date}
          onSelect={(d)=> d && setDate(d)}
          locale={locale==='zh'? zhCN : dfKo}
          className="text-sm w-[300px]"
          classNames={{
            month: 'w-full',
            day: 'h-9 w-9 rounded-md hover:bg-gray-100',
            day_selected: 'bg-blue-100 text-blue-700 rounded-md',
            nav: 'hidden',
            caption: 'hidden',
          }}
        />
        <div className="flex items-center justify-center gap-3">
          <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={hh} onChange={(e)=> setHh(e.target.value)}>{hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}</select>
          <span className="text-lg">:</span>
          <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={mm} onChange={(e)=> setMm(e.target.value)}>{minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}</select>
        </div>
      </div>
      <div className="sticky bottom-0 bg-white border-t p-3 flex justify-between items-center gap-2">
        <Button type="button" variant="ghost" onClick={()=>{ const n=dayjs(); setDate(n.toDate()); setHh(n.format('HH')); setMm(n.format('mm')); }}>{L.now}</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={()=> setOpen(false)}>{L.cancel}</Button>
          <Button type="button" onClick={()=>{ onChange(toLocalIso(date, hh, mm)); setOpen(false); }}>{L.confirm}</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button type="button" className="w-full text-left px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-50"
        onClick={()=> setOpen(true)}
      >
        <div className="font-medium">{summary}</div>
      </button>
      {open && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20">
          {dialogPanel}
        </div>,
        document.body
      )}
    </div>
  );
}


