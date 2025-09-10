import React from 'react';
import ReactDOM from 'react-dom';
import { Button } from './ui/button';
import dayjs from 'dayjs';
import { ko as dfKo, zhCN } from 'date-fns/locale';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export type ProductionTime = {
  startAt: string; // ISO-like string (local time, seconds=00)
  endAt: string;
};

type LocaleCode = 'ko' | 'zh';

type Validation = { ok: boolean; message?: string };

interface TimeRangeFieldProps {
  value: ProductionTime;
  onChange: (value: ProductionTime & { durationMin: number }) => void;
  onValidate?: (v: Validation) => void;
  locale: LocaleCode;
  minuteStep?: 5 | 10 | 15;
}

const LABELS: Record<LocaleCode, Record<string, string>> = {
  ko: {
    summary: '생산시간',
    start: '시작 시간',
    end: '종료 시간',
    today: '오늘',
    tomorrow: '내일',
    dayAfter: '모레',
    now: '지금',
    add15: '+15m',
    add30: '+30m',
    add1h: '+1h',
    add3h: '+3h',
    confirm: '확인',
    cancel: '취소',
    errEndLtStart: '종료 시간은 시작 시간 이후여야 합니다.',
    pickTime: '시간을 선택하세요.',
  },
  zh: {
    summary: '生产时间',
    start: '开始时间',
    end: '结束时间',
    today: '今天',
    tomorrow: '明天',
    dayAfter: '后天',
    now: '现在',
    add15: '+15m',
    add30: '+30m',
    add1h: '+1h',
    add3h: '+3h',
    confirm: '确定',
    cancel: '取消',
    errEndLtStart: '结束时间必须晚于开始时间。',
    pickTime: '请选择时间。',
  },
};

function toLocalIso(y: number, m: number, d: number, hh: number, mm: number): string {
  // seconds=0, keep local-time without forcing Z
  const dt = new Date(y, m, d, hh, mm, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    dt.getFullYear() +
    '-' + pad(dt.getMonth() + 1) +
    '-' + pad(dt.getDate()) +
    'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes())
  );
}

function parseLocal(value?: string): Date | null {
  if (!value) return null;
  // Accept YYYY-MM-DDTHH:mm
  const d = dayjs(value);
  return d.isValid() ? d.toDate() : null;
}

const hourOptions = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const minuteOptions = (step: number) => Array.from({ length: Math.floor(60 / step) }, (_, i) => String(i * step).toString().padStart(2, '0'));

export default function TimeRangeField({ value, onChange, onValidate, locale, minuteStep = 5 }: TimeRangeFieldProps) {
  const L = LABELS[locale];
  const [open, setOpen] = React.useState(false);
  const now = dayjs();
  const start = parseLocal(value?.startAt) || now.toDate();
  const end = parseLocal(value?.endAt) || now.add(1, 'hour').toDate();

  const [sDate, setSDate] = React.useState<Date>(start);
  const [sHour, setSHour] = React.useState<string>(dayjs(start).format('HH'));
  const [sMin, setSMin] = React.useState<string>(dayjs(start).format('mm'));

  const [eDate, setEDate] = React.useState<Date>(end);
  const [eHour, setEHour] = React.useState<string>(dayjs(end).format('HH'));
  const [eMin, setEMin] = React.useState<string>(dayjs(end).format('mm'));

  // const localeObj = locale === 'zh' ? zhCN : dfKo; // Currently unused
  const sDT = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), Number(sHour), Number(sMin), 0);
  const eDT = new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate(), Number(eHour), Number(eMin), 0);
  const durMin = Math.max(0, Math.floor((eDT.getTime() - sDT.getTime()) / 60000));
  const summary = `${dayjs(sDT).format('M/D(dd) HH:mm')} ~ ${dayjs(eDT).format('M/D(dd) HH:mm')} · ${Math.floor(durMin/60)}h ${durMin%60}m`;
  const [sMonth, setSMonth] = React.useState<Date>(dayjs(sDate).startOf('month').toDate());
  const [eMonth, setEMonth] = React.useState<Date>(dayjs(eDate).startOf('month').toDate());

  const validate = React.useCallback((s: Date, e: Date): Validation => {
    if (!s || !e) return { ok: false, message: L.pickTime };
    if (e.getTime() < s.getTime()) return { ok: false, message: L.errEndLtStart };
    return { ok: true };
  }, [L]);

  const emit = (s: Date, e: Date) => {
    const v: ProductionTime & { durationMin: number } = {
      startAt: toLocalIso(s.getFullYear(), s.getMonth(), s.getDate(), Number(dayjs(s).format('HH')), Number(dayjs(s).format('mm'))),
      endAt: toLocalIso(e.getFullYear(), e.getMonth(), e.getDate(), Number(dayjs(e).format('HH')), Number(dayjs(e).format('mm'))),
      durationMin: Math.max(0, Math.floor((e.getTime() - s.getTime())/60000)),
    };
    const res = validate(s, e);
    onValidate && onValidate(res);
    onChange(v);
  };

  const addToEnd = (unit: 'm15' | 'm30' | 'h1' | 'h3') => {
    const base = dayjs(Math.max(new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), Number(sHour), Number(sMin)).getTime(), new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate(), Number(eHour), Number(eMin)).getTime()));
    let next = base;
    if (unit === 'm15') next = base.add(15, 'minute');
    if (unit === 'm30') next = base.add(30, 'minute');
    if (unit === 'h1') next = base.add(1, 'hour');
    if (unit === 'h3') next = base.add(3, 'hour');
    setEDate(next.toDate());
    setEHour(next.format('HH'));
    setEMin(next.format('mm'));
  };

  const apply = () => {
    const s = sDT;
    const e = eDT;
    const v = validate(s, e);
    onValidate && onValidate(v);
    if (v.ok) emit(s, e);
    setOpen(false);
  };

  const dialogPanel = (
    <div className="w-full md:w-[740px] bg-white rounded-2xl shadow-xl border max-h-[80vh] overflow-hidden">
      <div className={`sticky top-0 z-10 bg-white p-4 border-b text-xs ${eDT.getTime() < sDT.getTime() ? 'text-red-600' : 'text-gray-500'}`}>{summary}
        <button type="button" className="float-right text-gray-400 hover:text-gray-600" onClick={()=> setOpen(false)}>✕</button>
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6 overflow-auto">
        {/* Start */}
        <div className="min-w-[320px] p-4">
          <div className="text-sm font-semibold mb-3">{L.start}</div>
          <div className="flex flex-wrap gap-2 mb-3">
            <Button type="button" variant="secondary" onClick={()=>{ const d=dayjs(); setSDate(d.toDate()); setSHour(d.format('HH')); setSMin(d.format('mm')); }}>{L.now}</Button>
            <Button type="button" variant="secondary" onClick={()=>{ const d=dayjs(); setSDate(d.toDate()); }}>{L.today}</Button>
            <Button type="button" variant="secondary" onClick={()=>{ const d=dayjs().add(1,'day'); setSDate(d.toDate()); }}>{L.tomorrow}</Button>
            <Button type="button" variant="secondary" onClick={()=>{ const d=dayjs().add(2,'day'); setSDate(d.toDate()); }}>{L.dayAfter}</Button>
          </div>
          <div className="grid grid-rows-[24px_320px_48px] gap-2 justify-items-center">
            <div className="flex items-center justify-center gap-3 w-[300px]">
              <button type="button" onClick={()=> setSMonth(dayjs(sMonth).subtract(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronLeft className="w-4 h-4"/></button>
              <div className="text-sm font-semibold">{dayjs(sMonth).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
              <button type="button" onClick={()=> setSMonth(dayjs(sMonth).add(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronRight className="w-4 h-4"/></button>
            </div>
            <DayPicker 
              mode="single"
              month={sMonth}
              onMonthChange={(d)=> setSMonth(d)}
              selected={sDate}
              onSelect={(d)=> d && setSDate(d)}
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
              <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={sHour} onChange={(e)=> setSHour(e.target.value)}>{hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}</select>
              <span className="text-lg">:</span>
              <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={sMin} onChange={(e)=> setSMin(e.target.value)}>{minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}</select>
            </div>
          </div>
        </div>
        {/* End */}
        <div className="min-w-[320px] p-4">
          <div className="text-sm font-semibold mb-3">{L.end}</div>
          <div className="flex flex-wrap gap-2 mb-3">
            <Button type="button" variant="secondary" onClick={()=> addToEnd('m15')}>{L.add15}</Button>
            <Button type="button" variant="secondary" onClick={()=> addToEnd('m30')}>{L.add30}</Button>
            <Button type="button" variant="secondary" onClick={()=> addToEnd('h1')}>{L.add1h}</Button>
            <Button type="button" variant="secondary" onClick={()=> addToEnd('h3')}>{L.add3h}</Button>
          </div>
          <div className="grid grid-rows-[24px_320px_48px] gap-2 justify-items-center">
            <div className="flex items-center justify-center gap-3 w-[300px]">
              <button type="button" onClick={()=> setEMonth(dayjs(eMonth).subtract(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronLeft className="w-4 h-4"/></button>
              <div className="text-sm font-semibold">{dayjs(eMonth).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
              <button type="button" onClick={()=> setEMonth(dayjs(eMonth).add(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronRight className="w-4 h-4"/></button>
            </div>
            <DayPicker 
              mode="single"
              month={eMonth}
              onMonthChange={(d)=> setEMonth(d)}
              selected={eDate} 
              onSelect={(d)=> d && setEDate(d)} 
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
              <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={eHour} onChange={(e)=> setEHour(e.target.value)}>{hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}</select>
              <span className="text-lg">:</span>
              <select className="h-10 px-3 min-w-[96px] border rounded text-mono" value={eMin} onChange={(e)=> setEMin(e.target.value)}>{minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}</select>
            </div>
          </div>
        </div>
      </div>
      <div className="sticky bottom-0 bg-white border-t p-3 flex justify-between items-center gap-2">
        <Button type="button" variant="ghost" onClick={()=>{ const n=dayjs(); setSDate(n.toDate()); setSHour(n.format('HH')); setSMin(n.format('mm')); const e=n.add(1,'hour'); setEDate(e.toDate()); setEHour(e.format('HH')); setEMin(e.format('mm')); }}>Reset</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={()=> setOpen(false)}>{L.cancel}</Button>
          <Button type="button" disabled={eDT.getTime() < sDT.getTime()} onClick={apply}>{L.confirm}</Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button type="button" className="w-full text-left px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-50"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <div className="text-xs text-gray-500">{L.summary}</div>
        <div className="font-medium">{summary}</div>
      </button>
      {open && (
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20">
            {dialogPanel}
          </div>,
          document.body
        )
      )}
    </div>
  );
}


