import React, { useState } from 'react';
import OEEDashboard from '@/components/OEEDashboard';
import DowntimeAnalysis from '@/components/DowntimeAnalysis';
import { PeriodProvider } from '@/contexts/PeriodContext';
import PeriodSelector from '@/components/PeriodSelector';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useLang } from '@/i18n';
import { useNavItems } from '@/App';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Menu as MenuIcon, X as XIcon, Home as HomeIcon, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useReports } from '@/hooks/useReports';
import { useMemo } from 'react';

export default function AnalysisPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t, lang, setLang } = useLang();
  const navItems = useNavItems();
  const { data: reports = [] } = useReports();

  // 파싱 함수
  const parseDowntimeFromNote = (note: string): Array<{ reason: string; duration: number }> => {
    if (!note) return [];
    const results: Array<{ reason: string; duration: number }> = [];
    const patterns = [
      /([가-힣A-Za-z0-9]+)[\s:]*([0-9]+) ?분/g, // 한글/영문
      /([a-zA-Z\s]+)\s*([0-9]+)min/g, // 영어
      /([^，\d]+)([0-9]+)分钟/g, // 중국어
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(note)) !== null) {
        const reason = match[1].trim();
        const duration = parseInt(match[2], 10);
        if (reason && duration > 0) {
          results.push({ reason, duration });
        }
      }
    });
    return results;
  };

  // downtimeRecords 생성
  const downtimeRecords = useMemo(() => {
    const list: any[] = [];
    reports.forEach((r: any) => {
      const parsed = parseDowntimeFromNote(r.note || '');
      parsed.forEach(({ reason, duration }) => {
        list.push({
          date: r.date,
          machine_no: r.machine_no,
          model: r.model || r.product || '-',
          reason,
          duration,
          note: r.note || '',
        });
      });
    });
    return list;
  }, [reports]);

  // downtimeSummary 집계
  const downtimeSummary = useMemo(() => {
    const summaryMap = new Map<string, { totalDuration: number; count: number }>();
    let total = 0;
    downtimeRecords.forEach((rec) => {
      const prev = summaryMap.get(rec.reason) || { totalDuration: 0, count: 0 };
      prev.totalDuration += rec.duration;
      prev.count += 1;
      summaryMap.set(rec.reason, prev);
      total += rec.duration;
    });
    return Array.from(summaryMap.entries()).map(([reason, { totalDuration, count }]) => ({
      reason,
      totalDuration,
      count,
      percentage: total > 0 ? Math.round((totalDuration / total) * 100) : 0,
    })).sort((a, b) => b.totalDuration - a.totalDuration);
  }, [downtimeRecords]);

  return (
    <PeriodProvider>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur shadow-xs md:hidden">
          <div className="flex items-center justify-between px-4 py-2">
            <Link to="/" className="flex items-center">
              <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
            </Link>
            <div className="flex items-center gap-2">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as any)}
                className="border rounded text-sm px-1 py-0.5"
              >
                <option value="ko">KOR</option>
                <option value="zh">中文</option>
              </select>
              <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
                <MenuIcon className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </header>

        {/* Breadcrumb */}
        <div className="sticky top-14 md:top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200 h-14 px-4 flex items-center gap-2 md:ml-56">
          <Link to="/">
            <HomeIcon className="w-4 h-4 text-gray-500" />
          </Link>
          <ChevronRight className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">{t('nav_analysis')}</span>
        </div>

        {/* Sidebar (Desktop) */}
        <aside className="fixed left-0 top-0 hidden h-screen w-56 overflow-y-auto border-r border-gray-200 bg-white shadow-md md:flex flex-col">
          {/* Top logo/title */}
          <div className="h-14 flex items-center justify-center gap-2 px-4 border-b border-gray-200">
            <Link to="/" className="flex items-center gap-2">
              <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
              <span className="font-semibold text-blue-700">{t('brand')}</span>
            </Link>
          </div>
          {/* Menu */}
          <nav className="flex-1 py-4 px-2 flex flex-col gap-1">
            {navItems.map((item) => {
              const Icon = item.icon as any;
              return item.to.startsWith('#') ? (
                <Link key={item.to} to={`/${item.to}`} className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium">
                  {Icon && <Icon className="w-4 h-4" />} {item.label}
                </Link>
              ) : (
                <Link key={item.to} to={item.to} className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium">
                  {Icon && <Icon className="w-4 h-4" />} {item.label}
                </Link>
              );
            })}
          </nav>
          {/* language selector bottom */}
          <div className="mt-auto border-t border-gray-200 px-4 py-3 flex flex-col gap-2">
            <select value={lang} onChange={(e)=>setLang(e.target.value as any)} className="w-full border rounded text-sm px-2 py-1">
              <option value="ko">KOR</option>
              <option value="zh">中文</option>
            </select>
            <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
              <input type="checkbox" checked={typeof window!=='undefined' && localStorage.getItem('lite')==='1'} onChange={(e)=>{if(e.target.checked){localStorage.setItem('lite','1');}else{localStorage.removeItem('lite');}location.reload();}} /> {t('lite_mode')}
            </label>
          </div>
        </aside>

        {/* Sidebar (Mobile) */}
        <AnimatePresence>
          {sidebarOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          {sidebarOpen && (
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed left-0 top-0 z-50 h-screen w-64 bg-white shadow-xl"
            >
              <div className="flex items-center justify-between p-4 border-b">
                <Link to="/" className="flex items-center gap-2">
                  <img src="/logo.jpg" alt="logo" className="h-8 w-8 rounded-full" />
                  <span className="font-semibold text-blue-700">{t('brand')}</span>
                </Link>
                <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
                  <XIcon className="h-6 w-6" />
                </Button>
              </div>
              <nav className="py-4 px-2 flex flex-col gap-1">
                {navItems.map((item) => {
                  const Icon = item.icon as any;
                  return item.to.startsWith('#') ? (
                    <Link key={item.to} to={`/${item.to}`} className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium" onClick={() => setSidebarOpen(false)}>
                      {Icon && <Icon className="w-4 h-4" />} {item.label}
                    </Link>
                  ) : (
                    <Link key={item.to} to={item.to} className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-600 font-medium" onClick={() => setSidebarOpen(false)}>
                      {Icon && <Icon className="w-4 h-4" />} {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="mt-auto border-t border-gray-200 px-4 py-3 flex flex-col gap-2">
                <select value={lang} onChange={(e)=>setLang(e.target.value as any)} className="w-full border rounded text-sm px-2 py-1">
                  <option value="ko">KOR</option>
                  <option value="zh">中文</option>
                </select>
                <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
                  <input type="checkbox" checked={typeof window!=='undefined' && localStorage.getItem('lite')==='1'} onChange={(e)=>{if(e.target.checked){localStorage.setItem('lite','1');}else{localStorage.removeItem('lite');}location.reload();}} /> {t('lite_mode')}
                </label>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Main Content */}
        <main className="mx-auto max-w-7xl px-4 py-10 md:ml-56 md:px-8 flex flex-col gap-10">
          <PeriodSelector />
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold text-blue-700">{t('nav_analysis')}</h1>
            </div>

            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">{t('oee_title')}</h2>
                <p className="text-sm text-gray-600">
                  {t('oee_desc')}
                </p>
              </CardHeader>
              <CardContent>
                <OEEDashboard />
              </CardContent>
            </Card>

            {/* 다운타임 분석 */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">{t('downtime_title')}</h2>
                <p className="text-sm text-gray-600">
                  {t('downtime_desc')}
                </p>
              </CardHeader>
              <CardContent>
                <DowntimeAnalysis />
              </CardContent>
            </Card>

            {/* 향후 확장을 위한 플레이스홀더 */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold">{t('spc_title')}</h3>
                <p className="text-sm text-gray-600">{t('spc_desc')}</p>
              </CardHeader>
              <CardContent>
                <p className="text-gray-500 text-sm">{t('preparing')}</p>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </PeriodProvider>
  );
} 