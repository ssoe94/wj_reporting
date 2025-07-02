import ModelsManager from '@/components/ModelsManager';
import { Link } from 'react-router-dom';

export default function ModelsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <Link to="/">
              <img src="/logo.jpg" alt="로고" className="h-10 w-10 rounded-full shadow-sm" />
            </Link>
            <span className="whitespace-nowrap text-lg font-bold text-blue-700 md:text-2xl">
              모델 관리
            </span>
          </div>
          <Link to="/" className="text-sm text-blue-600 hover:underline">
            ← 메인으로
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-10 md:px-8 flex flex-col gap-6">
        <ModelsManager />
      </main>
    </div>
  );
} 