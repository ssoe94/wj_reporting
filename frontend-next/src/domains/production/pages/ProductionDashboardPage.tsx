import { useQuery } from "@tanstack/react-query";
import { getProductionStatus } from "@/domains/production/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
import { getSeoulDateString } from "@/shared/utils/date";

export function ProductionDashboardPage() {
  const businessDate = getSeoulDateString();
  const statusQuery = useQuery({
    queryKey: ["production", "status", businessDate],
    queryFn: () => getProductionStatus(businessDate),
  });

  const payload = statusQuery.data ?? {};

  return (
    <section className="page">
      <PageHeader
        eyebrow="Production"
        title="생산 현황 화면의 새 골격"
        description="기존 production status API를 읽어오되, 페이지 구조와 API 계층은 새 기준으로 분리합니다. 이후 계획 화면과 통계 화면도 같은 패턴으로 확장하면 됩니다."
      />

      {statusQuery.isLoading ? <LoadingBlock label="생산 현황을 불러오는 중입니다." /> : null}

      <div className="stats-grid">
        <StatCard
          hint="일자 기준은 우선 서울 업무일로 고정해 테스트합니다."
          title="Business Date"
          value={businessDate}
        />
        <StatCard
          hint="응답 구조를 새 프런트에서 어떻게 adapter 할지 확인합니다."
          title="Response Keys"
          value={String(Object.keys(payload).length)}
        />
        <StatCard
          hint="새 프런트는 read-heavy 화면부터 먼저 안정화합니다."
          title="Migration Phase"
          value="Phase 2"
        />
      </div>

      <div className="panel">
        <h3 className="panel__title">응답 스냅샷</h3>
        <pre className="code-block">{JSON.stringify(payload, null, 2)}</pre>
      </div>
    </section>
  );
}
