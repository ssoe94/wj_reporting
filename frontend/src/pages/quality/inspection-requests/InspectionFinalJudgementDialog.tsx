import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type FinalInspectionChoice = 'pass' | 'fail' | 'concession';
export default function InspectionFinalJudgementDialog({ lang, busy, blocked = false, error, passAllowed, concessionEnabled, onClose, onConfirm }: {
  lang: 'ko' | 'zh'; busy: boolean; blocked?: boolean; error?: string; passAllowed: boolean; concessionEnabled: boolean;
  onClose: () => void; onConfirm: (choice: FinalInspectionChoice, reason: string) => void;
}) {
  const [choice, setChoice] = useState<FinalInspectionChoice | ''>('');
  const [reason, setReason] = useState('');
  const prefix = useId(); const dialog = useRef<HTMLDivElement>(null);
  const text = lang === 'ko' ? { title: '최종 검사 판정', hint: '치수·외관의 입력과 저장이 완료되었습니다. 최종 판정을 선택하세요.', pass: '합격', fail: '불합격', concession: '한도승인', reason: '한도승인 근거', close: '나중에 판정', confirm: '판정 저장·제출', failHint: '불합격 항목이 있어 합격을 선택할 수 없습니다.', concessionHint: '한도승인 저장 계약 확인 중' } : { title: '最终检验判定', hint: '尺寸与外观已填写并保存。请选择最终判定。', pass: '合格', fail: '不合格', concession: '让步合格', reason: '让步依据', close: '稍后判定', confirm: '保存并提交判定', failHint: '存在不合格项目，不可选择合格。', concessionHint: '让步判定保存合同待确认' };
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (prior?.isConnected) prior.focus(); };
  }, []);
  return createPortal(<div className="inspection-route-dialog-backdrop"><div ref={dialog} tabIndex={-1} className="inspection-route-dialog inspection-final-dialog" role="dialog" aria-modal="true" aria-labelledby={`${prefix}-title`} aria-describedby={`${prefix}-hint`} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') || []);
    const first = controls[0], last = controls[controls.length - 1];
    if (!controls.includes(document.activeElement as HTMLElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  }}><h2 id={`${prefix}-title`}>{text.title}</h2><p id={`${prefix}-hint`}>{text.hint}</p><div className="inspection-final-options" role="group" aria-label={text.title}>{(['pass', 'fail', 'concession'] as const).map((value) => <button key={value} type="button" className="inspection-final-option" aria-pressed={choice === value} data-verdict={value} disabled={busy || (value === 'pass' && !passAllowed) || (value === 'concession' && !concessionEnabled)} title={value === 'pass' && !passAllowed ? text.failHint : value === 'concession' && !concessionEnabled ? text.concessionHint : undefined} onClick={() => setChoice(value)}>{text[value]}</button>)}</div>{!passAllowed && <p>{text.failHint}</p>}{choice === 'concession' && <p>{lang === 'ko' ? '근거를 기록하고 독립 검수자의 승인을 받습니다.' : '记录依据后，须由独立审核人批准。'}</p>}{choice === 'concession' && <label>{text.reason} *<textarea autoFocus maxLength={500} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>}{error && <p role="alert">{error}</p>}<div className="inspection-actions"><button type="button" className="inspection-button" disabled={busy} onClick={onClose}>{text.close}</button><button type="button" className="inspection-button is-primary" disabled={busy || blocked || !choice || (choice === 'concession' && !reason.trim())} onClick={() => { if (choice) onConfirm(choice, reason.trim()); }}>{text.confirm}</button></div></div></div>, document.body);
}
