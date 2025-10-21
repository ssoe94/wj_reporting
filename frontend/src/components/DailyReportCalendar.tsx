import { useState, useEffect } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns';
import { ko, zhCN } from 'date-fns/locale';
import api from '../lib/api';
import { useLang } from '../i18n';

interface CalendarData {
  [date: string]: {
    has_snapshot: boolean;
    has_summary: boolean;
    email_sent: boolean;
    status: 'completed' | 'partial';
  };
}

interface DailyReportCalendarProps {
  onDateSelect: (date: string) => void;
  selectedDate?: string;
}

export default function DailyReportCalendar({ onDateSelect, selectedDate }: DailyReportCalendarProps) {
  const { lang } = useLang();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarData, setCalendarData] = useState<CalendarData>({});
  const [, setIsLoading] = useState(false);

  // 달력 데이터 가져오기
  const fetchCalendarData = async (year: number, month: number) => {
    setIsLoading(true);
    try {
      const response = await api.get(`/inventory/daily-report/calendar/`, {
        params: { year, month }
      });
      setCalendarData(response.data.calendar_data || {});
    } catch (error: any) {
      console.error('달력 데이터 가져오기 실패:', error);
      console.error('에러 상세:', error.response?.data);
      console.error('상태 코드:', error.response?.status);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCalendarData(currentDate.getFullYear(), currentDate.getMonth() + 1);
  }, [currentDate]);

  const previousMonth = () => {
    setCurrentDate(subMonths(currentDate, 1));
  };

  const nextMonth = () => {
    setCurrentDate(addMonths(currentDate, 1));
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // 주차별로 날짜 그룹화
  const weeks: (Date | null)[][] = [];
  let week: (Date | null)[] = [];
  
  // 이전 달의 날짜들로 첫 주 채우기
  const firstDayOfWeek = monthStart.getDay();
  for (let i = 0; i < firstDayOfWeek; i++) {
    week.push(null);
  }

  days.forEach(day => {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  });

  // 마지막 주 채우기
  if (week.length > 0) {
    while (week.length < 7) {
      week.push(null);
    }
    weeks.push(week);
  }

  const getDayStatus = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return calendarData[dateStr];
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 border-green-300 text-green-800';
      case 'partial':
        return 'bg-yellow-100 border-yellow-300 text-yellow-800';
      default:
        return 'bg-gray-50 border-gray-200 text-gray-500';
    }
  };

  const getStatusIcon = (dateData: any) => {
    if (!dateData) return null;
    
    if (dateData.email_sent) {
      return (
        <div className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full flex items-center justify-center">
          <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
        </div>
      );
    }
    
    if (dateData.has_summary) {
      return (
        <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full"></div>
      );
    }
    
    if (dateData.has_snapshot) {
      return (
        <div className="absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full"></div>
      );
    }
    
    return null;
  };

  return (
    <div className="bg-white rounded-lg border p-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={previousMonth}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        
        <h2 className="text-lg font-semibold">
          {format(
            currentDate,
            lang === 'zh' ? 'yyyy年 M月' : 'yyyy년 M월',
            { locale: lang === 'zh' ? zhCN : ko }
          )}
        </h2>
        
        <button
          onClick={nextMonth}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {(lang === 'zh' ? ['日','一','二','三','四','五','六'] : ['일','월','화','수','목','금','토']).map(day => (
          <div key={day} className="text-center text-sm font-medium text-gray-600 py-2">
            {day}
          </div>
        ))}
      </div>

      {/* 달력 그리드 */}
      <div className="grid grid-cols-7 gap-1">
        {weeks.map((week, weekIndex) =>
          week.map((day, dayIndex) => {
            if (!day) {
              return <div key={`empty-${weekIndex}-${dayIndex}`} className="h-12"></div>;
            }

            const dateData = getDayStatus(day);
            const isSelected = selectedDate === format(day, 'yyyy-MM-dd');
            const isToday = isSameDay(day, new Date());
            const isCurrentMonth = isSameMonth(day, currentDate);

            return (
              <button
                key={day.toISOString()}
                onClick={() => onDateSelect(format(day, 'yyyy-MM-dd'))}
                disabled={!dateData?.has_snapshot}
                className={`
                  relative h-12 rounded-lg border transition-all duration-200 text-sm font-medium
                  ${isSelected 
                    ? 'bg-blue-100 border-blue-300 text-blue-800' 
                    : dateData?.has_snapshot 
                      ? getStatusColor(dateData.status)
                      : 'bg-gray-50 border-gray-200 text-gray-400'
                  }
                  ${isToday ? 'ring-2 ring-blue-400' : ''}
                  ${dateData?.has_snapshot ? 'hover:bg-blue-50 cursor-pointer' : 'cursor-not-allowed'}
                  ${!isCurrentMonth ? 'opacity-50' : ''}
                `}
              >
                <span className={isToday ? 'font-bold' : ''}>
                  {format(day, 'd', { locale: lang === 'zh' ? zhCN : ko })}
                </span>
                {getStatusIcon(dateData)}
              </button>
            );
          })
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 pt-4 border-t">
        <div className="flex flex-wrap gap-4 text-xs">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
            <span>{lang === 'zh' ? '已生成快照' : '스냅샷 생성됨'}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-green-500 rounded-full"></div>
            <span>{lang === 'zh' ? '已完成汇总' : '요약 완료'}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 bg-blue-500 rounded-full flex items-center justify-center">
              <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
            </div>
            <span>{lang === 'zh' ? '已发送邮件' : '이메일 발송됨'}</span>
          </div>
        </div>
      </div>
    </div>
  );
} 
