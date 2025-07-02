import ModelsManager from '@/components/ModelsManager';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Menu as MenuIcon, X as XIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { useLang } from '@/i18n';

export default function ModelsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { t, lang, setLang } = useLang();

  const navItems = [
    { to: '/', label: t('dashboard') },
    { to: '/models', label: t('nav_models') },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <img src="/logo.jpg" alt="로고" className="h-10 w-10 rounded-full shadow-sm" />
            <span className="whitespace-nowrap text-lg font-bold text-blue-700 md:text-2xl">
              {t('modelsTitle')}
            </span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as any)}
              className="ml-3 border rounded text-sm px-1 py-0.5"
            >
              <option value="ko">KOR</option>
              <option value="zh">中文</option>
            </select>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="메뉴 열기"
          >
            <MenuIcon className="h-6 w-6" />
          </Button>
        </div>
      </header>

      {/* Sidebar (Desktop) */}
      <aside className="fixed left-0 top-[72px] hidden h-[calc(100vh-72px)] w-56 overflow-y-auto border-r bg-white py-8 px-4 shadow-md md:flex flex-col gap-2">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="px-3 py-2 rounded-lg font-medium text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition"
          >
            {item.label}
          </Link>
        ))}
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
            className="fixed left-0 top-0 z-50 h-full w-64 bg-white p-8 shadow-lg"
          >
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4"
              aria-label="메뉴 닫기"
              onClick={() => setSidebarOpen(false)}
            >
              <XIcon className="h-6 w-6" />
            </Button>
            <nav className="mt-8 flex flex-col gap-4">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setSidebarOpen(false)}
                  className="px-3 py-2 rounded-lg font-medium text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="mx-auto max-w-7xl px-4 py-10 md:ml-56 md:px-8 flex flex-col gap-6">
        <ModelsManager />
      </main>
    </div>
  );
} 