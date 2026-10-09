import { inspectionDisplayLabel } from './displayLabel';
import { useEffect, useState } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getInspectionRoleSettings } from './api';
import type { InspectionRoleSetting } from './roleModel';
import { currentInspectionShifts } from './roomTeamModel';

export default function InspectionRoomTeam({ sessionId, lang, now, refreshKey }: {
  sessionId: string | null; lang: 'ko' | 'zh'; now: Date; refreshKey: boolean;
}) {
  const [settings, setSettings] = useState<InspectionRoleSetting[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    const current = () => { try { assertAuthSessionCurrent(sessionId); return active; } catch { return false; } };
    if (!current()) return;
    void getInspectionRoleSettings(sessionId).then((data) => { if (current()) { setSettings(data.settings); setState('ready'); } }).catch(() => { if (current()) setState('error'); });
    return () => { active = false; };
  }, [sessionId, refreshKey]);
  const shifts = currentInspectionShifts(settings, now);
  const ko = lang === 'ko';
  return <section className="inspection-room-team" aria-label={ko ? '검사실 담당자' : '检验室负责人'}>
    <span className="inspection-room-team-title">{ko ? '검사실' : '检验室'}</span>
    {state === 'ready' && shifts.length ? shifts.map((shift) => <div className="inspection-room-shift" key={shift.id}>
      <span>{inspectionDisplayLabel(shift.label, lang)} · {shift.start_time?.slice(0, 5)}–{shift.end_time?.slice(0, 5)}</span>
      <span className="inspection-room-owner"><small>{ko ? '치수' : '尺寸'}</small><strong>{shift.dimension_assignee_name || '—'}</strong></span>
      <span className="inspection-room-owner"><small>{ko ? '외관' : '外观'}</small><strong>{shift.appearance_assignee_name || '—'}</strong></span>
    </div>) : <span className="inspection-muted">{state === 'loading' ? (ko ? '담당자 확인 중…' : '正在确认负责人…') : state === 'error' ? (ko ? '담당자 조회 실패' : '负责人查询失败') : (ko ? '현재 교대 담당자 미설정' : '当前班次未设置负责人')}</span>}
  </section>;
}
