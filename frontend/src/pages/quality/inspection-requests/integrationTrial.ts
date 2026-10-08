/** Trial identity comes from persisted server metadata, never names or verdicts. */
export type TrialIdentity = { source_kind?: string; mes_workflow?: { test_only?: boolean } };
export function isIntegrationTrial(value: TrialIdentity): boolean {
  return value.source_kind === 'integration_test' || value.mes_workflow?.test_only === true;
}

export type IntegrationTrial = {
  request_id: string; qc_code: string | null; test_label: string; phase: string;
  trial_verdict: 'pass' | 'fail' | null; observed_at: string | null;
  test_only: true; production_counted: false;
};

/** Copy the trial allowlist only. Unclassified/malformed rows never become production evidence. */
export function parseIntegrationTrials(value: unknown): IntegrationTrial[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((row): IntegrationTrial[] => {
    if (!row || typeof row !== 'object' || row.test_only !== true || row.production_counted !== false
      || typeof row.request_id !== 'string' || !/^[1-9]\d{0,18}$/.test(row.request_id) || seen.has(row.request_id)
      || (row.qc_code !== null && (typeof row.qc_code !== 'string' || row.qc_code.length > 128))
      || typeof row.test_label !== 'string' || row.test_label.length > 500
      || typeof row.phase !== 'string' || row.phase.length > 40
      || ![null, 'pass', 'fail'].includes(row.trial_verdict)
      || (row.observed_at !== null && (typeof row.observed_at !== 'string' || !Number.isFinite(Date.parse(row.observed_at))))
      || (row.trial_verdict !== null && row.observed_at === null)) return [];
    seen.add(row.request_id);
    return [{ request_id: row.request_id, qc_code: row.qc_code, test_label: row.test_label,
      phase: row.phase, trial_verdict: row.trial_verdict, observed_at: row.observed_at,
      test_only: true, production_counted: false }];
  });
}

export const integrationTrialCopy = {
  ko: { badge: '연동시험 · 실측 아님', title: '연동시험', excluded: '생산 합격 집계 제외',
    verdict: '시험 판정', pass: '시험 통과', fail: '시험 불통과', unknown: '미확인',
    observed: '관측', empty: '표시할 연동시험 없음', unavailable: '연동시험 자료 미확인',
    phases: { unbound: '시험 미연결', ready: '시험 준비', save_pending: '시험값 저장 중', save_unknown: '시험값 저장 미확인',
      saved: '시험값 저장 확인', finish_pending: '시험 완료 처리 중', finish_unknown: '시험 완료 미확인', completed: '연동시험 완료', blocked: '시험 확인 필요' },
  },
  zh: { badge: '接口测试 · 非实测', title: '接口测试', excluded: '不计入生产合格统计',
    verdict: '测试判定', pass: '测试通过', fail: '测试未通过', unknown: '待确认',
    observed: '观测', empty: '暂无接口测试记录', unavailable: '接口测试资料待确认',
    phases: { unbound: '测试未关联', ready: '测试准备', save_pending: '正在保存测试值', save_unknown: '测试值保存待确认',
      saved: '测试值保存已确认', finish_pending: '正在完成测试', finish_unknown: '测试完成待确认', completed: '接口测试完成', blocked: '测试需确认' },
  },
} as const;
