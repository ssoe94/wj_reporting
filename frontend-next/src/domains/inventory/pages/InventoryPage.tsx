import { useQuery } from "@tanstack/react-query";
import { getInventoryLastUpdate, getWarehouses } from "@/domains/inventory/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";

export function InventoryPage() {
  const lastUpdateQuery = useQuery({
    queryKey: ["inventory", "last-update"],
    queryFn: getInventoryLastUpdate,
  });

  const warehousesQuery = useQuery({
    queryKey: ["inventory", "warehouses"],
    queryFn: getWarehouses,
  });

  return (
    <section className="page">
      <PageHeader
        eyebrow="Inventory"
        title="재고 화면의 공통 패턴 검증"
        description="재고 영역은 조회 중심 기능이 많아서 새 공통 테이블과 필터 패턴을 검증하기 좋은 후보입니다. 현재는 최소 카드와 응답 확인 블록만 붙여둔 상태입니다."
      />

      {lastUpdateQuery.isLoading || warehousesQuery.isLoading ? (
        <LoadingBlock label="재고 기초 데이터를 불러오는 중입니다." />
      ) : null}

      <div className="stats-grid">
        <StatCard
          hint="기존 inventory last-update API를 그대로 읽습니다."
          title="Last Update"
          value={String(lastUpdateQuery.data?.last_update ?? "-")}
        />
        <StatCard
          hint="창고 목록은 새 필터 패턴의 기준 데이터가 됩니다."
          title="Warehouses"
          value={String(Array.isArray(warehousesQuery.data) ? warehousesQuery.data.length : 0)}
        />
        <StatCard
          hint="일일 보고와 현재고 화면을 같은 모듈 안에서 정리할 준비 단계입니다."
          title="Next Step"
          value="Daily Report"
        />
      </div>

      <div className="panel panel--split">
        <div>
          <h3 className="panel__title">Last Update Payload</h3>
          <pre className="code-block">{JSON.stringify(lastUpdateQuery.data ?? {}, null, 2)}</pre>
        </div>
        <div>
          <h3 className="panel__title">Warehouse Payload</h3>
          <pre className="code-block">{JSON.stringify(warehousesQuery.data ?? [], null, 2)}</pre>
        </div>
      </div>
    </section>
  );
}
