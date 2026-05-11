import { useQuery } from "@tanstack/react-query";
import { getInjectionSummary } from "@/domains/analysis/api";
import { PageHeader } from "@/shared/components/PageHeader";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { StatCard } from "@/shared/components/StatCard";
import { getSeoulDateString } from "@/shared/utils/date";

export function AnalysisPage() {
  const businessDate = getSeoulDateString();
  const summaryQuery = useQuery({
    queryKey: ["analysis", "injection-summary", businessDate],
    queryFn: () => getInjectionSummary(businessDate),
  });

  const summary = summaryQuery.data ?? {};
  const cards = [
    {
      title: "Business Date",
      value: businessDate,
      hint: "새 프런트는 먼저 업무일 기준을 드러내는 방향으로 시작합니다.",
    },
    {
      title: "Injection Total",
      value: String(summary.total_reports ?? "-"),
      hint: "기존 사출 summary API를 읽어 구조를 검증합니다.",
    },
    {
      title: "Data Contract",
      value: summaryQuery.isSuccess ? "Connected" : "Pending",
      hint: "새 화면은 공통 API 계층을 통해서만 데이터를 읽습니다.",
    },
  ];

  return (
    <section className="page">
      <PageHeader
        eyebrow="Analysis"
        title="새 구조의 첫 번째 읽기 화면"
        description="대시보드는 입력보다 먼저 이관하기 좋은 영역입니다. 이 화면은 사출 요약 API를 읽으면서, 새 앱 셸과 권한 가드가 함께 동작하는지 확인하는 용도입니다."
      />

      {summaryQuery.isLoading ? <LoadingBlock label="요약 지표를 불러오는 중입니다." /> : null}

      <div className="stats-grid">
        {cards.map((card) => (
          <StatCard key={card.title} hint={card.hint} title={card.title} value={card.value} />
        ))}
      </div>

      {summaryQuery.isError ? (
        <div className="notice notice--warning">
          현재 계정으로 사출 summary API를 읽지 못했습니다. 권한 또는 개발 서버 연결 상태를
          확인해주세요.
        </div>
      ) : null}
    </section>
  );
}
