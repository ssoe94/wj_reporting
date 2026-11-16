import { useLang } from '@/i18n';

export default function FieldMonitoringPage() {
  const { lang, t } = useLang();
  const tx = (ko: string, zh: string) => lang === 'zh' ? zh : ko;
  // These are requested program categories, not registered devices or live status.
  const programs = [
    {
      id: 'barcode',
      name: tx('바코드 리더', '条码读取'),
      workflow: tx('바코드 리딩 → 기준 정보 대조', '读取条码 → 核对基准信息'),
      checks: tx('불일치·중복 리딩, 누락, 예외 처리', '不匹配、重复读取、漏扫、异常处理'),
    },
    {
      id: 'weight-label',
      name: tx('중량 측정·라벨 검증', '称重与标签核验'),
      workflow: tx('중량 측정 → 바코드 인쇄 → 재리딩', '称重 → 打印条码 → 再次扫码'),
      checks: tx('중량 기준, 측정·인쇄·재리딩 연결, 재인쇄', '重量标准、称重与打印及复扫关联、补打'),
    },
    {
      id: 'vision-jig',
      name: tx('비전·지그 장착검사', '视觉与治具装配检查'),
      workflow: tx('검사 촬영 → 지그 장착 판정', '检查拍摄 → 治具装配判定'),
      checks: tx('검사 실행, OK/NG, 재검사·검사 우회', '检查执行、OK/NG、复检与跳过检查'),
    },
  ];

  return <div className="mx-auto max-w-[1440px] px-4 py-4 text-[var(--wj-text)] md:px-8">
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('nav_injection_field_monitoring')}</h1>
        <p className="mt-2 text-sm text-[var(--wj-muted)]">{tx('현장 프로그램의 운영 상태와 작업 절차 준수 현황을 확인합니다.', '查看现场程序运行状态与作业流程执行情况。')}</p>
      </div>
      <span className="rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface-muted)] px-3 py-1.5 text-sm font-semibold">{tx('연동 준비', '接入准备')}</span>
    </header>

    <section aria-labelledby="field-programs-title" className="overflow-hidden rounded-2xl border border-[var(--wj-border)] bg-[var(--wj-surface)]">
      <div className="border-b border-[var(--wj-border)] px-4 py-3">
        <h2 id="field-programs-title" className="text-base font-semibold">{tx('연동 대상 프로그램', '待接入程序')}</h2>
        <p className="mt-1 text-sm text-[var(--wj-muted)]">{tx('상세 자료를 취합 중입니다. 아래 항목은 확인 예정이며, 실제 PC 연결과 운영 집계는 아직 시작하지 않았습니다.', '正在收集详细资料。以下为待确认项目，尚未连接现场电脑或汇总运行数据。')}</p>
      </div>
      <div className="overflow-x-auto" role="region" aria-label={tx('연동 대상 목록', '待接入程序列表')} tabIndex={0}>
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-[var(--wj-surface-muted)] text-[var(--wj-muted)]">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">{tx('프로그램', '程序')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{tx('작업 흐름 · 확인 예정', '作业流程 · 待确认')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{tx('모니터링 항목 · 확인 예정', '监控项目 · 待确认')}</th>
              <th scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">{tx('준비 상태', '准备状态')}</th>
            </tr>
          </thead>
          <tbody>
            {programs.map(program => <tr key={program.id} className="border-t border-[var(--wj-border)]">
              <th scope="row" className="px-4 py-4 font-semibold">{program.name}</th>
              <td className="px-4 py-4">{program.workflow}</td>
              <td className="px-4 py-4">{program.checks}</td>
              <td className="whitespace-nowrap px-4 py-4 text-[var(--wj-muted)]">{tx('자료 취합 중', '资料收集中')}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>

    <section aria-labelledby="field-scope-title" className="mt-4 rounded-2xl border border-[var(--wj-border)] bg-[var(--wj-surface)] px-4 py-3">
      <h2 id="field-scope-title" className="text-base font-semibold">{tx('연동 후 확인할 현황', '接入后确认的情况')}</h2>
      <dl className="mt-3 grid gap-4 text-sm md:grid-cols-3">
        <div><dt className="font-semibold">{tx('프로그램 운영', '程序运行')}</dt><dd className="mt-1 leading-6 text-[var(--wj-muted)]">{tx('설치 위치·버전, 마지막 접속과 작업 시각, 장치 오류', '安装位置与版本、最后连接与作业时间、设备错误')}</dd></div>
        <div><dt className="font-semibold">{tx('작업 절차 준수', '流程执行')}</dt><dd className="mt-1 leading-6 text-[var(--wj-muted)]">{tx('필수 단계 완료, 누락·중복·재작업, 예외와 조치 이력', '必需步骤完成、遗漏与重复及返工、异常与处理记录')}</dd></div>
        <div><dt className="font-semibold">{tx('판정 정확성 검증', '判定准确性验证')}</dt><dd className="mt-1 leading-6 text-[var(--wj-muted)]">{tx('기준 샘플·교정·별도 검사 결과와 대조하여 확인', '通过标准样件、校准和独立检验结果进行核对')}</dd></div>
      </dl>
    </section>
  </div>;
}
