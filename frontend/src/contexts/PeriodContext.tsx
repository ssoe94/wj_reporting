import React, { createContext, useContext, useState } from 'react';

interface PeriodContextType {
  startDate: string;
  endDate: string;
  excludeWeekends: boolean;
  setStartDate: (date: string) => void;
  setEndDate: (date: string) => void;
  setExcludeWeekends: (v: boolean) => void;
  reset: () => void;
}

const PeriodContext = createContext<PeriodContextType | undefined>(undefined);

export const PeriodProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 기본값: 최근 7일
  const today = new Date();
  const defaultEnd = today.toISOString().slice(0, 10);
  const defaultStart = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [excludeWeekends, setExcludeWeekends] = useState(false);

  const reset = () => {
    setStartDate(defaultStart);
    setEndDate(defaultEnd);
    setExcludeWeekends(false);
  };

  return (
    <PeriodContext.Provider value={{ startDate, endDate, excludeWeekends, setStartDate, setEndDate, setExcludeWeekends, reset }}>
      {children}
    </PeriodContext.Provider>
  );
};

export function usePeriod() {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod must be used within a PeriodProvider');
  return ctx;
} 