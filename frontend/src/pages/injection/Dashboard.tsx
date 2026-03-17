import ProductionConsole from '@/components/production/ProductionConsole';

export default function InjectionDashboardPage() {
  return (
    <div className="mx-auto max-w-[1680px] px-4 py-6 md:px-8">
      <ProductionConsole planType="injection" />
    </div>
  );
}
