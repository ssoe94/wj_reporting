import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, FileUp, LockKeyhole, LogOut, Monitor } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { getFieldMaterials, type FieldMaterialModel } from '@/domains/field/api';
import { getProductionPlanSummary } from '@/lib/api';
import {
  injectionStations,
  machiningStations,
  matchesFieldStation,
  parseFieldTerminalUser,
  type FieldStation,
} from '@/lib/fieldTerminal';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';

import './Launcher.css';

type Language = 'zh' | 'ko';

type PlanItem = {
  machine_name: string;
  planned_quantity: number;
};

type MachineMaterialStatus = 'complete' | 'missing' | 'no-plan' | 'unknown';

type MachineMaterialSummary = {
  status: MachineMaterialStatus;
  plannedModels: number;
  missingModels: number;
};

const COPY = {
  zh: {
    eyebrow: 'WJ DATA CENTER · 现场终端',
    title: '现场看板',
    description: '选择注塑机后，打开该设备的作业指导书、图纸和品质Issue。',
    account: '当前账号',
    baseStation: '基本工位',
    boardCenter: '看板中心',
    logout: '登出',
    injectionTitle: '选择注塑机',
    injectionDescription: '1–17 号机 · 点击后打开现场触摸屏',
    machiningTitle: '加工线',
    machiningDescription: '保留现有 A–D 加工终端入口',
    machineUnit: '号机',
    todayPlan: '今日有计划',
    noPlan: '今日无计划',
    planStatusUnknown: '计划读取中',
    materialComplete: '资料完整',
    materialMissing: '资料缺失',
    statusUnknown: '资料状态未确认',
    modelsUnit: '个型号',
    legendComplete: '资料完整',
    legendMissing: '资料缺失',
    legendNoPlan: '无计划',
    legendUnknown: '读取中/无权限',
    materialsTitle: '现场资料统一管理',
    materialsDescription: '检查今日计划型号，并上传或更换作业指导书与图纸。',
    manageMaterials: '更新资料',
    viewMaterials: '查看资料状态',
    developmentPermissionRequired: '仅开发 / 管理员账号可管理',
    assignedStationOnly: '仅限指定机台',
  },
  ko: {
    eyebrow: 'WJ DATA CENTER · 현장 터미널',
    title: '현장 칸반',
    description: '사출기를 선택하면 해당 설비의 작업지도서·도면·품질Issue 화면을 엽니다.',
    account: '현재 계정',
    baseStation: '기본 작업장',
    boardCenter: '현황판 센터',
    logout: '로그아웃',
    injectionTitle: '사출기 선택',
    injectionDescription: '1–17호기 · 누르면 현장 터치스크린 열기',
    machiningTitle: '가공 라인',
    machiningDescription: '기존 A–D 가공 터미널 입구 유지',
    machineUnit: '호기',
    todayPlan: '오늘 계획 있음',
    noPlan: '오늘 계획 없음',
    planStatusUnknown: '계획 확인 중',
    materialComplete: '자료 완비',
    materialMissing: '자료 누락',
    statusUnknown: '자료 상태 미확인',
    modelsUnit: '개 모델',
    legendComplete: '자료 완비',
    legendMissing: '자료 누락',
    legendNoPlan: '계획 없음',
    legendUnknown: '조회 중/권한 없음',
    materialsTitle: '현장 자료 통합 관리',
    materialsDescription: '오늘 계획 모델을 확인하고 작업지도서와 도면을 업로드·교체합니다.',
    manageMaterials: '자료 업데이트',
    viewMaterials: '자료 현황 보기',
    developmentPermissionRequired: '개발 / 관리자 계정에서 관리 가능',
    assignedStationOnly: '지정 호기 전용',
  },
} as const;

const EMPTY_MATERIAL_SUMMARY: MachineMaterialSummary = {
  status: 'unknown',
  plannedModels: 0,
  missingModels: 0,
};

function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  try {
    return window.localStorage.getItem('wj-field-language') === 'ko' ? 'ko' : 'zh';
  } catch {
    return 'zh';
  }
}

function summarizeMachineMaterials(models: FieldMaterialModel[] | undefined) {
  const byMachine = new Map<number, FieldMaterialModel[]>();
  for (const model of models ?? []) {
    for (const machineNumber of model.machine_numbers) {
      const rows = byMachine.get(machineNumber) ?? [];
      rows.push(model);
      byMachine.set(machineNumber, rows);
    }
  }

  return new Map(injectionStations.map((station, index) => {
    const machineNumber = index + 1;
    const plannedModels = byMachine.get(machineNumber) ?? [];
    const missingModels = plannedModels.filter((model) => !model.readiness.complete).length;
    return [station.id, {
      status: plannedModels.length === 0 ? 'no-plan' : missingModels === 0 ? 'complete' : 'missing',
      plannedModels: plannedModels.length,
      missingModels,
    } satisfies MachineMaterialSummary] as const;
  }));
}

function MaterialLegend({ language }: { language: Language }) {
  const c = COPY[language];
  return (
    <div className="field-launcher-legend" aria-label={c.materialsTitle}>
      <span className="is-complete"><i />{c.legendComplete}</span>
      <span className="is-missing"><i />{c.legendMissing}</span>
      <span className="is-no-plan"><i />{c.legendNoPlan}</span>
      <span className="is-unknown"><i />{c.legendUnknown}</span>
    </div>
  );
}

export default function FieldLauncherPage() {
  const navigate = useNavigate();
  const { hasPermission, user, logout } = useAuth();
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const c = COPY[language];
  const currentFieldUser = useMemo(() => parseFieldTerminalUser(user?.username), [user?.username]);
  const businessDate = useShanghaiBusinessDate();
  const canReadMaterialStatus = Boolean(
    user
    && (user.is_staff || hasPermission('can_view_development')),
  );
  const canEditMaterials = Boolean(
    user
    && !currentFieldUser
    && (user.is_staff || hasPermission('can_edit_development')),
  );
  const canOpenMaterialsPage = canReadMaterialStatus && !currentFieldUser;
  const assignedInjectionStationId = currentFieldUser?.type === 'injection'
    ? currentFieldUser.stationId
    : null;

  useEffect(() => {
    try {
      window.localStorage.setItem('wj-field-language', language);
    } catch {
      // Locked-down kiosk profiles can disable storage; keep the live choice.
    }
  }, [language]);

  const planQuery = useQuery({
    queryKey: ['field-launcher-plan-status', businessDate],
    queryFn: async () => {
      const summary = await getProductionPlanSummary(businessDate);
      return {
        injection: Array.isArray(summary?.injection?.records) ? (summary.injection.records as PlanItem[]) : [],
        machining: Array.isArray(summary?.machining?.records) ? (summary.machining.records as PlanItem[]) : [],
      };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const materialsQuery = useQuery({
    queryKey: ['field-materials', businessDate],
    queryFn: () => getFieldMaterials(businessDate),
    enabled: canReadMaterialStatus,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const activeStationIds = useMemo(() => {
    const active = new Set<string>();
    for (const station of injectionStations) {
      if ((planQuery.data?.injection ?? []).some(
        (item) => Number(item.planned_quantity || 0) > 0 && matchesFieldStation(item.machine_name, station),
      )) active.add(station.id);
    }
    for (const station of machiningStations) {
      if ((planQuery.data?.machining ?? []).some(
        (item) => Number(item.planned_quantity || 0) > 0 && matchesFieldStation(item.machine_name, station),
      )) active.add(station.id);
    }
    return active;
  }, [planQuery.data]);
  const materialStatusByStation = useMemo(
    () => summarizeMachineMaterials(materialsQuery.data?.models),
    [materialsQuery.data?.models],
  );

  const openStation = (station: FieldStation) => navigate(`/field/${station.id}`);

  return (
    <main className="field-launcher" data-language={language} data-testid="field-launcher-page">
      <div className="field-launcher-shell">
        <header className="field-launcher-header">
          <span className="field-launcher-mark" aria-hidden="true"><Monitor /></span>
          <div className="field-launcher-heading">
            <small>{c.eyebrow}</small>
            <h1>{c.title}</h1>
            <p>{c.description}</p>
          </div>
          <div className="field-launcher-account">
            <span>{c.account}: <strong>{currentFieldUser?.username || user?.username || '-'}</strong></span>
            <span>{c.baseStation}: <strong>{currentFieldUser?.stationLabel || '-'}</strong></span>
          </div>
          <div className="field-launcher-actions">
            <Link className="field-launcher-back" to="/boards"><ArrowLeft />{c.boardCenter}</Link>
            <div className="field-launcher-language" role="group" aria-label={language === 'zh' ? '语言' : '언어'}>
              <button aria-pressed={language === 'zh'} className={language === 'zh' ? 'is-active' : ''} onClick={() => setLanguage('zh')} type="button">中文</button>
              <button aria-pressed={language === 'ko'} className={language === 'ko' ? 'is-active' : ''} onClick={() => setLanguage('ko')} type="button">KOR</button>
            </div>
            <button className="field-launcher-logout" onClick={logout} type="button"><LogOut />{c.logout}</button>
          </div>
        </header>

        <section className="field-launcher-panel field-launcher-injection" aria-labelledby="field-injection-title">
          <header className="field-launcher-section-header">
            <div><h2 id="field-injection-title">{c.injectionTitle}</h2><p>{c.injectionDescription}</p></div>
            <MaterialLegend language={language} />
          </header>
          <div className="field-launcher-machine-grid">
            {injectionStations.map((station, index) => {
              const hasPlan = activeStationIds.has(station.id);
              const canOpenStation = !assignedInjectionStationId || station.id === assignedInjectionStationId;
              const planLabel = planQuery.isSuccess ? (hasPlan ? c.todayPlan : c.noPlan) : c.planStatusUnknown;
              const summary = canReadMaterialStatus && materialsQuery.isSuccess
                ? materialStatusByStation.get(station.id) ?? { ...EMPTY_MATERIAL_SUMMARY, status: 'no-plan' }
                : EMPTY_MATERIAL_SUMMARY;
              const materialLabel = summary.status === 'complete'
                ? `${c.materialComplete} · ${summary.plannedModels}${c.modelsUnit}`
                : summary.status === 'missing'
                  ? `${c.materialMissing} · ${summary.missingModels}${c.modelsUnit}`
                  : summary.status === 'no-plan'
                    ? c.noPlan
                    : c.statusUnknown;
              return (
                <button
                  aria-label={`${index + 1}${c.machineUnit} · ${planLabel} · ${materialLabel}${canOpenStation ? '' : ` · ${c.assignedStationOnly}`}`}
                  className={`field-launcher-machine is-${summary.status}`}
                  data-active={hasPlan}
                  disabled={!canOpenStation}
                  key={station.id}
                  onClick={() => openStation(station)}
                  title={canOpenStation ? materialLabel : c.assignedStationOnly}
                  type="button"
                >
                  <i aria-hidden="true" />
                  <span className="field-launcher-machine-number">{String(index + 1).padStart(2, '0')}</span>
                  <strong>{c.machineUnit}</strong>
                  <small>{planLabel}</small>
                  <em>{canOpenStation ? materialLabel : c.assignedStationOnly}</em>
                </button>
              );
            })}
          </div>
        </section>

        <section className="field-launcher-lower-grid">
          <article className="field-launcher-materials">
            <span className="field-launcher-material-icon"><FileUp /></span>
            <div><h2>{c.materialsTitle}</h2><p>{c.materialsDescription}</p></div>
            {canOpenMaterialsPage ? (
              <Link to="/development/field-materials">
                {canEditMaterials ? c.manageMaterials : c.viewMaterials}<ArrowUpRight />
              </Link>
            ) : (
              <span className="field-launcher-permission"><LockKeyhole />{c.developmentPermissionRequired}</span>
            )}
          </article>

          <article className="field-launcher-machining">
            <header><div><h2>{c.machiningTitle}</h2><p>{c.machiningDescription}</p></div></header>
            <div>
              {machiningStations.map((station) => {
                const hasPlan = activeStationIds.has(station.id);
                const planLabel = planQuery.isSuccess ? (hasPlan ? c.todayPlan : c.noPlan) : c.planStatusUnknown;
                return (
                  <button
                    className={hasPlan ? 'is-active' : ''}
                    disabled={Boolean(assignedInjectionStationId)}
                    key={station.id}
                    onClick={() => openStation(station)}
                    title={assignedInjectionStationId ? c.assignedStationOnly : planLabel}
                    type="button"
                  >
                    <strong>{station.shortLabel}</strong><span>{assignedInjectionStationId ? c.assignedStationOnly : planLabel}</span>
                  </button>
                );
              })}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
