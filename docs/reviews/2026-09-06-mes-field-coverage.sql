-- Local SQLite transform of the audited UI field-presence aggregate.
-- This is not a query against MES or a sample of fabricated production records.
WITH ui_field_observations(ordinal, field, source_field, present, sample_size) AS (
  VALUES (0, '설비', '设备', 20, 20),
  (1, '생산 작업', '生产任务编号', 20, 20),
  (2, '공정코드', '工序编号', 20, 20),
  (3, '품질상태', '质量状态', 20, 20),
  (4, '보고수량', '报工数量', 20, 20),
  (5, '보고단위', '报工单位', 20, 20),
  (6, '식별코드', '标识码', 20, 20),
  (7, '작업지시', '工单编号', 20, 20),
  (8, 'LOT', '批次号', 0, 20),
  (9, '실제 시작', '开始时间', 0, 20),
  (10, '실제 종료', '结束时间', 0, 20),
  (11, '공수', '工时', 0, 20),
  (12, '고객 주문', '订单编号', 0, 20)
)
SELECT field, source_field, present, sample_size, sample_size-present AS missing,
  '기본 목록 첫 페이지 20행 · 편의표본' AS scope,
  '2026-09-06' AS observed_date
FROM ui_field_observations ORDER BY ordinal;
