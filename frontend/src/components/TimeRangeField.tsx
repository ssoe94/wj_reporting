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
    useModal: '달력 사용',
    useDirectInput: '직접 입력',
    startDateTime: '시작 날짜/시간',
    endDateTime: '종료 날짜/시간',
    inputPlaceholder: '숫자만 입력 (예: 202501011400)',
    inputHint: '숫자 12자리 입력하면 자동 변환 (년월일시분)',
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
    useModal: '使用日历',
    useDirectInput: '直接输入',
    startDateTime: '开始日期/时间',
    endDateTime: '结束日期/时间',
    inputPlaceholder: '输入数字 (例: 202501011400)',
    inputHint: '输入12位数字自动转换 (年月日时分)',
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

// 직접 입력을 위한 파싱 함수 (엄격한 검증 포함)
function parseDirectInput(value: string): Date | null {
  if (!value || value.length !== 16) return null; // "YYYY-MM-DD HH:mm" 정확한 길이만
  
  // 정규식으로 정확한 형식 검증
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) return null;
  
  const [, year, month, day, hour, minute] = match;
  const y = parseInt(year);
  const m = parseInt(month);
  const d = parseInt(day);
  const h = parseInt(hour);
  const min = parseInt(minute);
  
  // 범위 검증
  if (y < 1900 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  if (h < 0 || h > 23) return null; // 24시간 형식
  if (min < 0 || min > 59) return null;
  
  // Date 객체 생성 및 검증
  const date = new Date(y, m - 1, d, h, min, 0, 0);
  
  // 생성된 Date가 입력값과 일치하는지 확인 (예: 2월 30일 같은 잘못된 날짜 방지)
  if (date.getFullYear() !== y || 
      date.getMonth() !== m - 1 || 
      date.getDate() !== d ||
      date.getHours() !== h ||
      date.getMinutes() !== min) {
    return null;
  }
  
  return date;
}

// Date를 직접 입력 형식으로 변환
function formatDirectInput(date: Date): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm');
}

// YYYY-MM-DD HH:mm 형식으로 자동 변환
function formatDateTimeInput(value: string): string {
  // dayjs가 유연하게 파싱하도록 시도
  let d = dayjs(value);

  // 만약 파싱이 실패하면, 숫자만 추출해서 다시 시도 (YYYYMMDDHHmm 형식)
  if (!d.isValid()) {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 12) {
      d = dayjs(digits, 'YYYYMMDDHHmm');
    }
  }

  // 12자리 숫자가 아닌 다른 형식의 숫자 입력 처리
  if (!d.isValid()) {
    const digits = value.replace(/\D/g, '');
    if (digits.length > 4) {
        let dateString = digits.substring(0,4) + '-' + digits.substring(4,6) + '-' + digits.substring(6,8) + ' ' + digits.substring(8,10) + ':' + digits.substring(10,12);
        d = dayjs(dateString);
    }
  }

  if (d.isValid()) {
    return d.format('YYYY-MM-DD HH:mm');
  }

  return value; // 파싱 실패 시 원본 값 반환
}

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

  // 경량모드 상태 확인 (사이드바 토글 기반)
  const [isLightweightMode, setIsLightweightMode] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('lite') === '1';
  });

  // localStorage 변경사항 감지
  React.useEffect(() => {
    const handleStorageChange = () => {
      setIsLightweightMode(localStorage.getItem('lite') === '1');
    };

    // storage 이벤트 리스너 (다른 탭에서 변경 시)
    window.addEventListener('storage', handleStorageChange);
    
    // 동일 탭에서 변경 감지를 위한 주기적 체크
    const interval = setInterval(handleStorageChange, 100);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  // const [currentStep, setCurrentStep] = React.useState<'start' | 'end'>('start'); // 경량모드 모달에서 사용되었으나 현재 미사용
  const [useDirectInput, setUseDirectInput] = React.useState(false);
  
  // 직접 입력용 상태
  const [directStartInput, setDirectStartInput] = React.useState('');
  const [directEndInput, setDirectEndInput] = React.useState('');
  const [directInputError, setDirectInputError] = React.useState<string | null>(null);

  // 직접 입력 값 초기화 및 동기화
  React.useEffect(() => {
    setDirectStartInput(formatDirectInput(sDT));
    setDirectEndInput(formatDirectInput(eDT));
  }, [value?.startAt, value?.endAt]);

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

  // 커서 위치 추적을 위한 ref
  const startInputRef = React.useRef<HTMLInputElement>(null);
  const endInputRef = React.useRef<HTMLInputElement>(null);

  // 직접 입력 처리
  const handleDirectInputChange = (type: 'start' | 'end', value: string) => {
    if (type === 'start') {
      setDirectStartInput(value);
    } else {
      setDirectEndInput(value);
    }
  };

  const applyDirectInput = (type: 'start' | 'end') => {
    const value = type === 'start' ? directStartInput : directEndInput;
    const formatted = formatDateTimeInput(value);
    
    if (type === 'start') {
      setDirectStartInput(formatted);
    } else {
      setDirectEndInput(formatted);
    }

    const finalStartValue = type === 'start' ? formatted : directStartInput;
    const finalEndValue = type === 'end' ? formatted : directEndInput;

    if (finalStartValue.length >= 16 && finalEndValue.length >= 16) {
      const startDate = parseDirectInput(finalStartValue);
      const endDate = parseDirectInput(finalEndValue);

      if (!startDate || !endDate) {
        onValidate && onValidate({ ok: false, message: L.pickTime });
        setDirectInputError(L.pickTime);
        return;
      }

      const v = validate(startDate, endDate);
      onValidate && onValidate(v);
      setDirectInputError(v.ok ? null : v.message || null);
      
      if (v.ok) {
        emit(startDate, endDate);
        setSDate(startDate);
        setEDate(endDate);
        setSHour(dayjs(startDate).format('HH'));
        setSMin(dayjs(startDate).format('mm'));
        setEHour(dayjs(endDate).format('HH'));
        setEMin(dayjs(endDate).format('mm'));
      }
    } else {
      setDirectInputError(null);
    }
  };

  // 경량모드용 단순화된 UI (현재 사용되지 않음 - 직접 입력으로 대체)
  /*
  const lightweightDialogPanel = (
    <div className="w-full max-w-[400px] bg-white rounded-lg shadow-xl border max-h-[80vh] overflow-hidden">
      <div className={`bg-white p-4 border-b text-xs ${eDT.getTime() < sDT.getTime() ? 'text-red-600' : 'text-gray-500'}`}>
        {summary}
        <button type="button" className="float-right text-gray-400 hover:text-gray-600" onClick={()=> setOpen(false)}>✕</button>
      </div>
      
      <div className="p-4">
        <div className="flex justify-center mb-4">
          <div className="inline-flex rounded-md border" role="tablist">
            <button 
              type="button"
              className={`px-4 py-2 text-sm ${currentStep === 'start' ? 'bg-blue-100 text-blue-700' : 'bg-white text-gray-700'} border-r`}
              onClick={() => setCurrentStep('start')}
            >
              {L.start}
            </button>
            <button 
              type="button"
              className={`px-4 py-2 text-sm ${currentStep === 'end' ? 'bg-blue-100 text-blue-700' : 'bg-white text-gray-700'}`}
              onClick={() => setCurrentStep('end')}
            >
              {L.end}
            </button>
          </div>
        </div>

        {currentStep === 'start' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 mb-3">
              <Button type="button" size="sm" variant="secondary" onClick={()=>{ const d=dayjs(); setSDate(d.toDate()); setSHour(d.format('HH')); setSMin(d.format('mm')); }}>{L.now}</Button>
              <Button type="button" size="sm" variant="secondary" onClick={()=>{ const d=dayjs(); setSDate(d.toDate()); }}>{L.today}</Button>
              <Button type="button" size="sm" variant="secondary" onClick={()=>{ const d=dayjs().add(1,'day'); setSDate(d.toDate()); }}>{L.tomorrow}</Button>
            </div>
            
            <div className="text-center">
              <div className="flex items-center justify-center gap-3 mb-3">
                <button type="button" onClick={()=> setSMonth(dayjs(sMonth).subtract(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronLeft className="w-4 h-4"/></button>
                <div className="text-sm font-semibold min-w-[120px]">{dayjs(sMonth).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
                <button type="button" onClick={()=> setSMonth(dayjs(sMonth).add(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronRight className="w-4 h-4"/></button>
              </div>
              
              <div className="flex justify-center mb-4">
                <DayPicker 
                  mode="single"
                  month={sMonth}
                  onMonthChange={(d)=> setSMonth(d)}
                  selected={sDate}
                  onSelect={(d)=> d && setSDate(d)}
                  locale={locale==='zh'? zhCN : dfKo}
                  className="text-sm"
                  classNames={{
                    month: 'w-full',
                    day: 'h-8 w-8 rounded hover:bg-gray-100 text-sm',
                    day_selected: 'bg-blue-500 text-white rounded',
                    nav: 'hidden',
                    caption: 'hidden',
                  }}
                />
              </div>
              
              <div className="flex items-center justify-center gap-2">
                <select className="h-9 px-2 border rounded text-sm" value={sHour} onChange={(e)=> setSHour(e.target.value)}>
                  {hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}
                </select>
                <span>:</span>
                <select className="h-9 px-2 border rounded text-sm" value={sMin} onChange={(e)=> setSMin(e.target.value)}>
                  {minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {currentStep === 'end' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 mb-3">
              <Button type="button" size="sm" variant="secondary" onClick={()=> addToEnd('m15')}>{L.add15}</Button>
              <Button type="button" size="sm" variant="secondary" onClick={()=> addToEnd('m30')}>{L.add30}</Button>
              <Button type="button" size="sm" variant="secondary" onClick={()=> addToEnd('h1')}>{L.add1h}</Button>
            </div>
            
            <div className="text-center">
              <div className="flex items-center justify-center gap-3 mb-3">
                <button type="button" onClick={()=> setEMonth(dayjs(eMonth).subtract(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronLeft className="w-4 h-4"/></button>
                <div className="text-sm font-semibold min-w-[120px]">{dayjs(eMonth).format(locale==='zh' ? 'YYYY年 M月' : 'YYYY년 M월')}</div>
                <button type="button" onClick={()=> setEMonth(dayjs(eMonth).add(1,'month').toDate())} className="p-1 rounded hover:bg-gray-100"><ChevronRight className="w-4 h-4"/></button>
              </div>
              
              <div className="flex justify-center mb-4">
                <DayPicker 
                  mode="single"
                  month={eMonth}
                  onMonthChange={(d)=> setEMonth(d)}
                  selected={eDate} 
                  onSelect={(d)=> d && setEDate(d)} 
                  locale={locale==='zh'? zhCN : dfKo} 
                  className="text-sm"
                  classNames={{
                    month: 'w-full',
                    day: 'h-8 w-8 rounded hover:bg-gray-100 text-sm',
                    day_selected: 'bg-blue-500 text-white rounded',
                    nav: 'hidden',
                    caption: 'hidden',
                  }}
                />
              </div>
              
              <div className="flex items-center justify-center gap-2">
                <select className="h-9 px-2 border rounded text-sm" value={eHour} onChange={(e)=> setEHour(e.target.value)}>
                  {hourOptions.map(h=> <option key={h} value={h}>{h}</option>)}
                </select>
                <span>:</span>
                <select className="h-9 px-2 border rounded text-sm" value={eMin} onChange={(e)=> setEMin(e.target.value)}>
                  {minuteOptions(minuteStep).map(m=> <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
      
      <div className="bg-white border-t p-3 flex justify-between items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={()=>{ const n=dayjs(); setSDate(n.toDate()); setSHour(n.format('HH')); setSMin(n.format('mm')); const e=n.add(1,'hour'); setEDate(e.toDate()); setEHour(e.format('HH')); setEMin(e.format('mm')); setCurrentStep('start'); }}>Reset</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={()=> setOpen(false)}>{L.cancel}</Button>
          <Button type="button" size="sm" disabled={eDT.getTime() < sDT.getTime()} onClick={apply}>{L.confirm}</Button>
        </div>
      </div>
    </div>
  );
  */

  // 일반모드용 기존 UI (Grid 사용)
  const standardDialogPanel = (
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
          <div className="flex flex-col gap-2 items-center">
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
          <div className="flex flex-col gap-2 items-center">
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

  // 경량모드에서는 직접 입력만 제공
  if (isLightweightMode) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-gray-500 mb-2">{L.summary}</div>
        
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {L.startDateTime}
            </label>
            <input
              ref={startInputRef}
              type="text"
              value={directStartInput}
              onChange={(e) => handleDirectInputChange('start', e.target.value)}
              onBlur={() => applyDirectInput('start')}
              placeholder={L.inputPlaceholder}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {L.endDateTime}
            </label>
            <input
              ref={endInputRef}
              type="text"
              value={directEndInput}
              onChange={(e) => handleDirectInputChange('end', e.target.value)}
              onBlur={() => applyDirectInput('end')}
              placeholder={L.inputPlaceholder}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
        
        <div className="text-xs text-gray-500 space-y-1">
          <div>{summary}</div>
          {directInputError ? (
            <div className="text-red-600 font-semibold">{directInputError}</div>
          ) : (
            <div className="text-blue-600">{L.inputHint}</div>
          )}
        </div>
      </div>
    );
  }

  // 일반모드에서는 모달과 직접입력 둘 다 지원
  return (
    <div className="relative">
      {!useDirectInput ? (
        // 모달 사용 모드
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-gray-500">{L.summary}</span>
            <button
              type="button"
              onClick={() => setUseDirectInput(true)}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {L.useDirectInput}
            </button>
          </div>
          <button type="button" className="w-full text-left px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-50"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <div className="font-medium">{summary}</div>
          </button>
        </>
      ) : (
        // 직접 입력 모드
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{L.summary}</span>
            <button
              type="button"
              onClick={() => setUseDirectInput(false)}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              {L.useModal}
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {L.startDateTime}
              </label>
              <input
                ref={startInputRef}
                type="text"
                value={directStartInput}
                onChange={(e) => handleDirectInputChange('start', e.target.value)}
                onBlur={() => applyDirectInput('start')}
                placeholder={L.inputPlaceholder}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {L.endDateTime}
              </label>
              <input
                ref={endInputRef}
                type="text"
                value={directEndInput}
                onChange={(e) => handleDirectInputChange('end', e.target.value)}
                onBlur={() => applyDirectInput('end')}
                placeholder={L.inputPlaceholder}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          
          <div className="text-xs text-gray-500 space-y-1">
            <div>{summary}</div>
            {directInputError ? (
              <div className="text-red-600 font-semibold">{directInputError}</div>
            ) : (
              <div className="text-blue-600">{L.inputHint}</div>
            )}
          </div>
        </div>
      )}
      
      {open && !useDirectInput && (
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20">
            {standardDialogPanel}
          </div>,
          document.body
        )
      )}
    </div>
  );
}


