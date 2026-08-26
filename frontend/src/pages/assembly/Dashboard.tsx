import { lazy, Suspense } from 'react';

const ProductionConsole = lazy(() => import('@/components/production/ProductionConsole'));

export default function AssemblyDashboardPage() {
  return (
    <div className="mx-auto max-w-[1680px] px-4 py-6 md:px-8">
      <Suspense fallback={<div className="flex min-h-96 items-center justify-center text-lg font-bold text-slate-600">가공 생산 실행 화면을 불러오는 중입니다…</div>}>
        <ProductionConsole planType="machining" />
      </Suspense>
    </div>
  );
}
