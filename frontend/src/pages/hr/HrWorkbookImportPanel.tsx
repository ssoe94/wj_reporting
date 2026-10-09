import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FileSpreadsheet, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { getHrClassificationReference, getHrWorkspace, importHrWorkbookBatch, previewHrWorkbookBatch, saveHrClassificationReference } from '../../domains/hr/api';
import { readWorkbook } from '../../domains/hr/import';
import { parseClassificationReference, parseCompanyPayroll } from '../../domains/hr/workbook-import';
import { hrAssignmentPath } from '../../domains/hr/labels';
import type { HrWorkbook } from '../../domains/hr/import';
import type { HrClassificationReference, HrClassificationReferenceState, HrEmploymentType, HrWorkbookBatch, HrWorkbookBatchPreview, HrWorkbookIssue, HrWorkbookRow } from '../../domains/hr/workbook-types';
import type { HrWorkspace } from '../../domains/hr/types';
import { compactMoney, isHrConflict } from './hrCommon';
import './hr-workbook-import.css';

type PayrollInput = { id: string; book: HrWorkbook; employment_type: HrEmploymentType | '' };
type Props = { workspace: HrWorkspace; disabled: boolean; onImported: (workspace: HrWorkspace) => void; onBusyChange: (busy: boolean) => void; onConflict: () => void; onDraftChange?: (hasDraft: boolean) => void };
const MAX_FILES = 10;
const FILE_LIMIT = 10 * 1024 * 1024;
const monthPattern = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/;

export default function HrWorkbookImportPanel({ workspace, disabled, onImported, onBusyChange, onDraftChange }: Props) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState<HrClassificationReference | null>(null);
  const [storedReference, setStoredReference] = useState<HrClassificationReferenceState | null>(null);
  const [referenceStatus, setReferenceStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [referenceBaseVersion, setReferenceBaseVersion] = useState(0);
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [referenceConflict, setReferenceConflict] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const referenceRequest = useRef(0);
  const [inputs, setInputs] = useState<PayrollInput[]>([]);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [issueHistory, setIssueHistory] = useState<Record<string, HrWorkbookIssue>>({});
  const [referenceReviewRows, setReferenceReviewRows] = useState<number[]>([]);
  const [monthSelection, setMonthSelection] = useState<Record<string, boolean>>({});
  const [policy, setPolicy] = useState<'preserve' | 'reference'>('preserve');
  const [preview, setPreview] = useState<HrWorkbookBatchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [savedMonths, setSavedMonths] = useState<string[]>([]);
  const mounted = useRef(true);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;
  const draftChange = useRef(onDraftChange);
  draftChange.current = onDraftChange;
  const request = useRef(0);
  const busyRef = useRef(false);
  const previewPayload = useRef<HrWorkbookBatch | null>(null);
  const monthRef = useRef(workspace.month);
  monthRef.current = workspace.month;
  const referenceInput = useRef<HTMLInputElement>(null);
  const payrollInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; if (busyRef.current) busyChange.current(false); draftChange.current?.(false); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const id = ++referenceRequest.current;
    setReferenceStatus('loading');
    getHrClassificationReference(controller.signal).then((result) => {
      if (controller.signal.aborted || id !== referenceRequest.current) return;
      setStoredReference(result); setReference(result.reference); setReferenceBaseVersion(result.version);
      setReferenceStatus('ready'); setReferenceDirty(false); setReferenceConflict(false);
    }).catch(() => { if (!controller.signal.aborted && id === referenceRequest.current) setReferenceStatus('error'); });
    return () => controller.abort();
  }, []);
  const hasDraft = inputs.length > 0 || preview !== null || referenceDirty;
  useEffect(() => { draftChange.current?.(hasDraft); }, [hasDraft]);
  useEffect(() => { previewPayload.current = null; setPreview(null); setConflict(false); }, [workspace.month]);
  function invalidate() { request.current += 1; previewPayload.current = null; setPreview(null); setConflict(false); setError(''); setNotice(''); setSavedMonths([]); }
  function begin() { const id = ++request.current; busyRef.current = true; setBusy(true); busyChange.current(true); setError(''); return id; }
  function finish(id: number) { if (mounted.current && id === request.current) { busyRef.current = false; setBusy(false); busyChange.current(false); } }
  function valid(id: number) { return mounted.current && id === request.current; }
  const readableError = useCallback((failure: unknown, fallback: string) => {
    // Server responses may include employee identities. Display local parser
    // diagnostics only; remote errors use a name-free operational message.
    if (!(failure instanceof Error) || 'response' in failure) return fallback;
    if (ko) return failure.message;
    const context = failure.message.includes(': ') ? failure.message.split(': ')[0].replace(/(\d+)행/g, '$1行').replaceAll('사번', '工号') : '';
    return context ? `${context}：${fallback}` : fallback;
  }, [ko]);
  function assertFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) throw new Error(ko ? '원본 XLSX 파일을 선택해 주세요.' : '请选择原始 XLSX 文件。');
    if (file.size > FILE_LIMIT) throw new Error(ko ? '파일마다 10 MB 이하여야 합니다.' : '每个文件不得超过 10 MB。');
  }
  async function chooseReference(file: File | undefined) {
    if (!file || disabled || busy || referenceStatus !== 'ready') return;
    invalidate(); const id = begin();
    setReferenceError('');
    try {
      assertFile(file); const result = parseClassificationReference(await readWorkbook(file));
      if (valid(id)) {
        setReference(result); setReferenceReviewRows([]); setReferenceDirty(true);
        if (!referenceDirty) setReferenceBaseVersion(storedReference?.version ?? 0);
      }
    }
    catch (failure) { if (valid(id)) setReferenceError(readableError(failure, ko ? '분류표를 읽지 못했습니다. 기존 분류와 초안은 유지됩니다.' : '无法读取分类表，现有分类及草稿已保留。')); }
    finally { finish(id); if (referenceInput.current) referenceInput.current.value = ''; }
  }
  async function loadStoredReference() {
    if (disabled || busy) return;
    invalidate(); const id = begin(); ++referenceRequest.current; setReferenceStatus('loading'); setReferenceError('');
    try {
      const result = await getHrClassificationReference();
      if (valid(id)) {
        setStoredReference(result); setReferenceStatus('ready');
        if (referenceDirty) {
          setReferenceConflict(result.version !== referenceBaseVersion);
          setReferenceError(ko ? '작성 중인 분류는 유지했습니다. 서버 분류와 초안을 확인한 뒤 사용할 내용을 선택해 주세요.' : '已保留当前分类草稿，请核对服务器分类及草稿后选择要使用的内容。');
        } else {
          setReference(result.reference); setReferenceBaseVersion(result.version); setReferenceReviewRows([]); setReferenceConflict(false);
          setNotice(result.reference ? (ko ? '시스템 기본 분류를 다시 불러왔습니다.' : '已重新加载系统基础分类。') : (ko ? '기본 분류가 없습니다. 관리 영역에서 분류표를 등록해 주세요.' : '尚无基础分类，请在管理区域登记分类表。'));
        }
      }
    } catch { if (valid(id)) { setReferenceStatus('error'); setReferenceError(ko ? '시스템 기본 분류를 불러오지 못했습니다. 초안은 유지됩니다.' : '无法加载系统基础分类，草稿已保留。'); } }
    finally { finish(id); }
  }
  function useStoredReference() {
    if (!storedReference || busy) return;
    invalidate(); setReference(storedReference.reference); setReferenceBaseVersion(storedReference.version);
    setReferenceDirty(false); setReferenceConflict(false); setReferenceError(''); setReferenceReviewRows([]);
  }
  function keepReferenceDraft() {
    if (!storedReference || busy) return;
    invalidate(); setReferenceBaseVersion(storedReference.version); setReferenceConflict(false); setReferenceError('');
  }
  async function saveReference() {
    if (!reference || !referenceDirty || busy || disabled || referenceStatus !== 'ready' || referenceConflict) return;
    invalidate(); const id = begin(); setReferenceError('');
    try {
      const result = await saveHrClassificationReference({ version: referenceBaseVersion, reference });
      if (valid(id)) {
        setStoredReference(result); setReference(result.reference); setReferenceBaseVersion(result.version);
        setReferenceDirty(false); setReferenceConflict(false); setReferenceStatus('ready');
        setNotice(ko ? '기본 분류를 시스템에 등록했습니다. 이제 임금표만 선택하세요.' : '已在系统登记基础分类，现在只需选择工资表。');
      }
    } catch (failure) {
      if (valid(id)) {
        if (isHrConflict(failure)) {
          setReferenceConflict(true);
          setReferenceError(ko ? '다른 사용자가 기본 분류를 변경했습니다. 작성한 초안은 유지됩니다. 최신 분류를 조회한 뒤 서버 분류 사용 또는 초안 유지 후 저장 준비를 선택해 주세요.' : '其他用户已修改基础分类，当前草稿已保留。请查询最新分类，再选择使用服务器分类或保留草稿准备保存。');
        } else setReferenceError(ko ? '기본 분류를 저장하지 못했습니다. 작성한 초안은 유지됩니다.' : '无法保存基础分类，当前草稿已保留。');
      }
    } finally { finish(id); }
  }
  async function choosePayroll(fileList: FileList | null) {
    if (!fileList?.length || disabled || busy) return;
    const files = Array.from(fileList);
    if (files.length + inputs.length > MAX_FILES) { setError(ko ? '임금표는 최대 10개까지 선택할 수 있습니다.' : '最多可选择 10 个工资文件。'); if (payrollInput.current) payrollInput.current.value = ''; return; }
    invalidate(); const id = begin();
    try {
      const loaded: PayrollInput[] = [];
      for (const file of files) {
        assertFile(file); const book = await readWorkbook(file);
        const contract = file.name.includes('合同工'); const hourly = file.name.includes('小时工');
        loaded.push({ id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `payroll-${Date.now()}-${Math.random().toString(36).slice(2)}`, book,
          employment_type: contract !== hourly ? contract ? 'contract' : 'hourly' : '' });
      }
      if (valid(id)) setInputs((previous) => [...previous, ...loaded]);
    } catch (failure) { if (valid(id)) setError(readableError(failure, ko ? '임금표를 읽지 못했습니다.' : '无法读取工资表。')); }
    finally { finish(id); if (payrollInput.current) payrollInput.current.value = ''; }
  }

  const parsed = useMemo(() => {
    try {
      const ready = inputs.filter((input): input is PayrollInput & { employment_type: HrEmploymentType } => input.employment_type !== '');
      if (!ready.length) return { files: [], months: [], issues: [] as HrWorkbookIssue[], warnings: [] as string[], failure: '' };
      return { ...parseCompanyPayroll(ready, corrections), failure: '' };
    } catch (failure) { return { files: [], months: [], issues: [] as HrWorkbookIssue[], warnings: [] as string[], failure: readableError(failure, ko ? '원본 임금표를 확인해 주세요.' : '请检查原始工资表。') }; }
  }, [inputs, corrections, ko, readableError]);
  const detectedMonths = useMemo(() => [...new Set([...parsed.months.map((month) => month.month), ...parsed.issues.map((issue) => issue.month).filter((month) => monthPattern.test(month))])].sort(), [parsed]);
  const selectedMonths = detectedMonths.filter((month) => monthSelection[month] !== false);
  const selectedSet = new Set(selectedMonths);
  const selectedIssues = parsed.issues.filter((issue) => !monthPattern.test(issue.month) || selectedSet.has(issue.month));
  const payrollRows = parsed.months.flatMap((month) => month.rows);
  const rowKeys = useMemo(() => new Map<string, HrWorkbookRow>(parsed.months.flatMap((month) => month.rows).map((row) => {
    const input = inputs.find((item) => item.id === row.source_file);
    const index = input?.book.sheets.findIndex((sheet) => sheet.name === row.source_sheet) ?? -1;
    return [`${row.source_file}:${index}:${row.source_row}`, row] as const;
  })), [parsed.months, inputs]);
  useEffect(() => {
    setIssueHistory((current) => {
      const next = { ...current }; let changed = false;
      for (const issue of parsed.issues) {
        if (next[issue.key]) continue;
        next[issue.key] = { ...issue, code: rowKeys.get(issue.key)?.original_code ?? issue.code }; changed = true;
      }
      return changed ? next : current;
    });
  }, [parsed.issues, rowKeys]);
  // A valid first keystroke must not remove the correction input before the
  // user has finished typing the intended employee code.
  const issueRows = [...new Map([...Object.values(issueHistory).filter((issue) => rowKeys.has(issue.key)), ...parsed.issues].map((issue) => [issue.key, issue])).values()];
  for (const key of Object.keys(corrections)) {
    if (issueRows.some((issue) => issue.key === key)) continue;
    const row = rowKeys.get(key); if (!row) continue;
    const input = inputs.find((item) => item.id === row.source_file); if (!input) continue;
    issueRows.push({ key, file: input.book.filename, sheet: row.source_sheet, row: row.source_row, month: row.period, code: row.original_code, message: '' });
  }
  const unknownKind = inputs.some((input) => input.employment_type === '');
  const referenceRows = reference?.rows ?? [];
  const reviewReferenceIndexes = [...new Set([...referenceReviewRows, ...referenceRows.flatMap((row, index) => row.department_id === null ? [index] : [])])];
  const targetDepartments = workspace.company_structure.classification.nodes;
  const departmentPath = (id: string) => hrAssignmentPath(id, targetDepartments, lang);
  const referenceReady = referenceStatus === 'ready' && Boolean(storedReference?.reference) && !referenceDirty && !referenceConflict;
  const canPreview = Boolean(referenceReady && inputs.length && selectedMonths.length && !unknownKind && !parsed.failure && !selectedIssues.length && !disabled && !busy);
  async function inspect() {
    if (!canPreview || !storedReference?.reference) return;
    const payload: HrWorkbookBatch = { classification_version: storedReference.version, files: parsed.files,
      months: parsed.months.filter((month) => selectedSet.has(month.month)), assignment_policy: policy };
    const id = begin(); setNotice(''); setConflict(false);
    try {
      const result = await previewHrWorkbookBatch(payload);
      if (valid(id)) {
        previewPayload.current = payload; setPreview(result);
      }
    } catch (failure) {
      if (valid(id)) {
        if (isHrConflict(failure)) { setConflict(true); setError(ko ? '기본 분류 또는 월 자료가 변경되었습니다. 임금표와 수정 내용은 유지됩니다. 기본 분류를 다시 불러온 뒤 미리보기를 실행해 주세요.' : '基础分类或月度资料已变化，工资表及更正已保留。请重新加载基础分类后生成预览。'); }
        else setError(ko ? '미리보기를 만들지 못했습니다. 입력 자료는 유지됩니다.' : '无法生成预览，输入资料已保留。');
      }
    }
    finally { finish(id); }
  }
  function resolveReference(index: number, target: string) {
    if (!reference || busy || disabled) return;
    const source = reference;
    const rows = source.rows.map((row, rowIndex) => rowIndex === index ? { ...row, department_id: target || null } : { ...row });
    invalidate(); setReference({ ...source, rows }); setReferenceDirty(true);
    if (!referenceDirty) setReferenceBaseVersion(storedReference?.version ?? 0);
    setReferenceReviewRows((current) => current.includes(index) ? current : [...current, index]);
  }
  async function save() {
    const payload = previewPayload.current;
    if (!preview || !payload || busy || disabled || conflict || !referenceReady) return;
    const submittedMonth = workspace.month; const id = begin(); setNotice('');
    try {
      const result = await importHrWorkbookBatch({ ...payload, preview_token: preview.preview_token,
        confirmations: preview.months.map((month) => ({ month: month.month, version: month.version, expected_total: month.total, fingerprint: month.fingerprint })) });
      let current = result.workspaces.find((item) => item.month === submittedMonth);
      let reloadFailed = false;
      if (!current) {
        try { current = await getHrWorkspace(submittedMonth); }
        catch { reloadFailed = true; }
      }
      if (valid(id) && monthRef.current === submittedMonth) {
        const months = result.workspaces.map((item) => item.month).sort(); if (current) onImported(current); setSavedMonths(months);
        setNotice(ko ? `${months.join(', ')} 월 자료를 저장했습니다.` : `已保存 ${months.join(', ')} 月资料。`);
        if (reloadFailed) setError(ko ? '선택 월 저장은 완료했습니다. 현재 보고 있는 월을 새로 불러오지 못했으므로 저장한 월의 집계 링크에서 확인해 주세요.' : '所选月份已保存，但无法刷新当前查看月份，请通过已保存月份的汇总链接确认。');
        setPreview(null); previewPayload.current = null; setInputs([]); setCorrections({}); setIssueHistory({}); setMonthSelection({});
      }
    } catch (failure) {
      if (valid(id)) {
        if (isHrConflict(failure)) { setConflict(true); setError(ko ? '기본 분류 또는 월 자료가 변경되었습니다. 임금표·수정·미리보기는 유지됩니다. 기본 분류를 다시 불러온 뒤 최신 버전으로 미리보기를 실행해 주세요.' : '基础分类或月度资料已变化，工资表、更正和预览已保留。请重新加载基础分类后生成最新预览。'); }
        else setError(ko ? '저장하지 못했습니다. 입력 자료와 미리보기는 유지됩니다.' : '保存失败，输入资料及预览已保留。');
      }
    } finally { finish(id); }
  }
  function resetSelection() {
    if (busy) return;
    invalidate(); setInputs([]); setCorrections({}); setIssueHistory({}); setMonthSelection({});
    if (payrollInput.current) payrollInput.current.value = '';
    setNotice(ko ? '임금표 선택과 사번 수정 초안을 비웠습니다. 시스템 기본 분류는 유지됩니다.' : '已清除工资表选择及工号更正草稿，系统基础分类保持不变。');
  }
  function warningLabel(warning: string) {
    if (ko) return warning;
    const parts = warning.split(': '); const context = (parts[0] ?? '').replace(/(\d+)행/g, '$1行').replaceAll('사번', '工号');
    return `${context}：${warning.includes('소수') ? '已使用 Excel 显示的两位小数金额。' : '同一人员及用工类型在不同月份使用了不同工号，未自动更正。'}`;
  }
  function issueLabel(issue: HrWorkbookIssue | undefined) {
    if (!issue) return ko ? '수정 완료' : '已更正';
    if (ko) return issue.message;
    const notes: string[] = [];
    if (issue.message.includes('사번이 없습니다')) notes.push('缺少工号');
    if (issue.message.includes('여러 번')) notes.push('同一月份工号重复');
    if (issue.message.includes('화면 표시')) notes.push('显示工号与其他原始工号冲突');
    if (issue.message.includes('서로 다른 성명')) notes.push('工号关联不同人员');
    if (issue.message.includes('64자')) notes.push('工号超过 64 字符');
    return notes.join(' · ') || '请核对原始工号';
  }
  const registeredReference = storedReference?.reference;
  const storedUnassignedCount = registeredReference?.rows.filter((row) => row.department_id === null).length ?? 0;

  return <section className="hr-panel hr-workbook-import">
    <div className="hr-workbook-heading"><div><h2><FileSpreadsheet size={17} />{ko ? '회사 임금표 업로드' : '上传公司工资表'}</h2><span>{ko ? '계약직·시간제 원본 · 시스템 기본 분류로 월별 저장' : '合同工·小时工原始表 · 使用系统基础分类按月保存'}</span></div>
      <button className="hr-button" disabled={busy} aria-expanded={open} onClick={() => setOpen((value) => !value)}><Upload size={15} />{open ? (ko ? '접기' : '收起') : (ko ? '파일 선택' : '选择文件')}</button></div>
    <div className={`hr-workbook-system-status${referenceStatus === 'error' || referenceConflict ? ' is-error' : registeredReference ? ' is-ready' : ''}`} role="status">
      <span>{referenceStatus === 'loading' ? (ko ? '시스템 기본 분류를 확인하는 중입니다.' : '正在确认系统基础分类。')
        : referenceStatus === 'error' ? (ko ? '기본 분류를 확인하지 못했습니다. 다시 불러와 주세요.' : '无法确认基础分类，请重新加载。')
        : registeredReference ? (ko ? `기본 분류 ${registeredReference.rows.length}명 · 임금표만 선택하세요` : `基础分类 ${registeredReference.rows.length} 人 · 只需选择工资表`)
        : (ko ? '기본 분류가 아직 없습니다. 아래 관리 영역에서 먼저 등록해 주세요.' : '尚无基础分类，请先在下方管理区域登记。')}</span>
      {referenceStatus === 'ready' && registeredReference && <small>v{storedReference?.version}{storedUnassignedCount ? ` · ${ko ? '미분류' : '未分类'} ${storedUnassignedCount}${ko ? '명' : '人'}` : ''}</small>}
      {referenceStatus === 'error' && <button className="hr-button" disabled={busy || disabled} onClick={() => void loadStoredReference()}><RefreshCw size={14} />{ko ? '다시 불러오기' : '重新加载'}</button>}
    </div>
    {notice && <p role="status" className="hr-workbook-notice">{notice}</p>}
    {savedMonths.length > 0 && <div className="hr-workbook-month-links">{savedMonths.map((month) => <Link key={month} to={`/hr/labor-cost?month=${month}`}>{month} {ko ? '집계 보기' : '查看汇总'}</Link>)}</div>}
    {open && <div className="hr-workbook-body">
      {disabled && <p className="hr-muted">{ko ? '배치 변경을 저장하거나 되돌린 뒤 업로드하세요.' : '请保存或撤销配置更改后再上传。'}</p>}
      <label className="hr-field hr-workbook-payroll-picker">{ko ? '임금 원본 · 계약직 / 시간제 · 최대 10개' : '原始工资表 · 合同工 / 小时工 · 最多 10 个'}<input ref={payrollInput} type="file" accept=".xlsx" multiple disabled={busy || disabled || !referenceReady} onChange={(event) => void choosePayroll(event.target.files)} /><small>{ko ? '각 파일 최대 10 MB. 원본의 시트와 월을 자동으로 읽습니다.' : '每个文件最大 10 MB，自动读取原始工作表及月份。'}</small></label>
      {referenceDirty && <p className="hr-alert is-warning">{ko ? '기본 분류의 저장 전 변경이 있습니다. 먼저 분류를 저장하거나 변경을 취소해 주세요.' : '基础分类存在未保存更改，请先保存分类或撤销更改。'}</p>}
      <details className="hr-disclosure hr-workbook-reference-management" open={referenceDirty || referenceConflict || (referenceStatus === 'ready' && !registeredReference) ? true : undefined}>
        <summary>{ko ? '기본 분류표 관리' : '管理基础分类表'}{referenceDirty ? (ko ? ' · 저장 전 변경' : ' · 未保存更改') : ''}</summary>
        <p className="hr-muted">{ko ? '분류표는 시스템에 독립적으로 저장합니다. 이 작업으로 월별 급여 자료를 만들거나 기존 월의 인원 배치를 바꾸지 않습니다.' : '分类表独立保存到系统，此操作不会创建月度工资资料或改变已有月份的人员配置。'}</p>
        <div className="hr-workbook-reference-status"><span>{registeredReference ? `${registeredReference.filename} · ${registeredReference.rows.length}${ko ? '명' : '人'} · v${storedReference?.version}` : (ko ? '등록된 기본 분류 없음' : '尚无已登记基础分类')}</span><button className="hr-button" disabled={busy || disabled || referenceStatus === 'loading'} onClick={() => void loadStoredReference()}><RefreshCw size={14} />{ko ? '서버 최신 분류 조회' : '查询服务器最新分类'}</button></div>
        <label className="hr-field">{ko ? '분류표 등록·변경 · 部门划分.xlsx' : '登记或更新分类表 · 部门划分.xlsx'}<input ref={referenceInput} type="file" accept=".xlsx" disabled={busy || disabled || referenceStatus !== 'ready'} onChange={(event) => void chooseReference(event.target.files?.[0])} /></label>
        {reference && <div className="hr-workbook-reference-draft"><span>{reference.filename} · {reference.rows.length}{ko ? '행' : '行'}{referenceDirty ? (ko ? ' · 작성 중' : ' · 草稿') : ''}</span>
          <button className="hr-button is-primary" disabled={busy || disabled || !referenceDirty || referenceConflict || referenceStatus !== 'ready'} onClick={() => void saveReference()}>{ko ? '기본 분류로 저장' : '保存为基础分类'}</button>
          {referenceDirty && !referenceConflict && <button className="hr-button" disabled={busy || disabled || referenceStatus !== 'ready'} onClick={useStoredReference}>{ko ? '분류 변경 취소' : '撤销分类更改'}</button>}
        </div>}
        {referenceError && <p className="hr-alert is-error" role="alert">{referenceError}</p>}
        {referenceConflict && storedReference && storedReference.version !== referenceBaseVersion && referenceStatus === 'ready' && <div className="hr-workbook-reference-reconcile"><span>{ko ? `서버 v${storedReference.version}: ${registeredReference?.rows.length ?? 0}명 · 초안 ${reference?.rows.length ?? 0}명` : `服务器 v${storedReference.version}：${registeredReference?.rows.length ?? 0} 人 · 草稿 ${reference?.rows.length ?? 0} 人`}</span>
          <button className="hr-button" disabled={busy || disabled} onClick={useStoredReference}>{ko ? '서버 분류 사용' : '使用服务器分类'}</button><button className="hr-button" disabled={busy || disabled} onClick={keepReferenceDraft}>{ko ? '초안 유지 후 저장 준비' : '保留草稿准备保存'}</button>
        </div>}
        {reviewReferenceIndexes.length > 0 && <div className="hr-workbook-reference-review"><h3>{ko ? '분류 확인·수정' : '确认及更正分类'} ({reviewReferenceIndexes.length})</h3><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '원본 행' : '原始行'}</th><th>{ko ? '부문' : '部门'}</th><th>{ko ? '기능' : '职能'}</th><th>{ko ? '적용할 분류' : '目标分类'}</th></tr></thead><tbody>{referenceRows.map((row, index) => !reviewReferenceIndexes.includes(index) ? null : <tr key={`${row.source_row}-${index}`}><td>{row.source_row} · {row.employment_type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시간제' : '小时工')}</td><td>{row.source_department}</td><td>{row.source_function}</td><td><select aria-label={`${row.source_row}${ko ? '행 적용할 분류' : '行目标分类'}`} value={row.department_id ?? ''} disabled={busy || disabled || referenceStatus !== 'ready'} onChange={(event) => resolveReference(index, event.target.value)}><option value="">{ko ? '미분류 유지' : '保持未分类'}</option>{targetDepartments.map((department) => <option key={department.id} value={department.id}>{departmentPath(department.id)}</option>)}</select></td></tr>)}</tbody></table></div></div>}
      </details>
      {inputs.length > 0 && <div className="hr-table-scroll"><table className="hr-workbook-file-table"><thead><tr><th>{ko ? '파일' : '文件'}</th><th>{ko ? '고용 형태' : '用工类型'}</th><th>{ko ? '시트' : '工作表'}</th><th>{ko ? '읽은 행·월' : '读取行数·月份'}</th><th /></tr></thead><tbody>{inputs.map((input) => {
        const rows = payrollRows.filter((row) => row.source_file === input.id); const months = [...new Set(rows.map((row) => row.period))];
        return <tr key={input.id}><td>{input.book.filename}</td><td><select aria-label={`${input.book.filename} ${ko ? '고용 형태' : '用工类型'}`} value={input.employment_type} disabled={busy || disabled} onChange={(event) => { invalidate(); setInputs((items) => items.map((item) => item.id === input.id ? { ...item, employment_type: event.target.value as HrEmploymentType | '' } : item)); }}><option value="">{ko ? '직접 선택' : '请选择'}</option><option value="contract">{ko ? '계약직 · 合同工' : '合同工'}</option><option value="hourly">{ko ? '시간제 · 小时工' : '小时工'}</option></select></td><td>{input.book.sheets.length}</td><td>{rows.length} {ko ? '행' : '行'}{months.length ? ` · ${months.join(', ')}` : ''}</td><td><button className="hr-icon-button" aria-label={`${input.book.filename} ${ko ? '파일 제거' : '移除文件'}`} disabled={busy} onClick={() => { invalidate(); setInputs((items) => items.filter((item) => item.id !== input.id)); }}><X size={16} /></button></td></tr>;
      })}</tbody></table></div>}
      {unknownKind && <p className="hr-alert is-warning">{ko ? '파일명에서 고용 형태를 확인하지 못한 파일은 계약직·시간제를 직접 선택해 주세요.' : '无法从文件名确定类型的文件，请手动选择合同工或小时工。'}</p>}
      {parsed.failure && <p role="alert" className="hr-alert is-error">{parsed.failure}</p>}
      {parsed.warnings.length > 0 && <details className="hr-disclosure"><summary>{ko ? '원본 확인 사항' : '原始资料提示'} ({parsed.warnings.length})</summary><ul className="hr-workbook-warning-list">{parsed.warnings.map((warning, index) => <li key={index}>{warningLabel(warning)}</li>)}</ul></details>}
      {detectedMonths.length > 0 && <div className="hr-workbook-months"><strong>{ko ? '저장할 월' : '保存月份'}</strong>{detectedMonths.map((month) => <label key={month} className="hr-checkbox"><input type="checkbox" checked={monthSelection[month] !== false} disabled={busy || disabled} onChange={(event) => { invalidate(); setMonthSelection((current) => ({ ...current, [month]: event.target.checked })); }} />{month}</label>)}</div>}
      {issueRows.length > 0 && <details className="hr-disclosure" open><summary>{ko ? '사번 확인·수정' : '确认及更正工号'} ({selectedIssues.length} {ko ? '선택 월 문제' : '所选月份问题'})</summary><p className="hr-muted">{ko ? '선택한 월의 문제만 저장을 막습니다. 원본 행으로 확인하고 올바른 사번을 입력하세요.' : '仅所选月份的问题会阻止保存，请核对原始行并输入正确工号。'}</p><div className="hr-table-scroll hr-workbook-issue-scroll"><table><thead><tr><th>{ko ? '파일' : '文件'}</th><th>{ko ? '시트·행' : '工作表·行'}</th><th>{ko ? '월' : '月份'}</th><th>{ko ? '원본 사번' : '原始工号'}</th><th>{ko ? '확인 사항' : '确认事项'}</th><th>{ko ? '수정 사번' : '更正工号'}</th></tr></thead><tbody>{issueRows.map((issue) => <tr key={issue.key} className={selectedSet.has(issue.month) || !monthPattern.test(issue.month) ? '' : 'is-excluded'}><td>{issue.file}</td><td>{issue.sheet} · {issue.row}</td><td>{issue.month || '—'}</td><td>{rowKeys.get(issue.key)?.original_code || '—'}</td><td>{issueLabel(parsed.issues.find((current) => current.key === issue.key))}</td><td><div className="hr-workbook-correction"><input maxLength={64} aria-label={`${issue.file} ${issue.sheet} ${issue.row}${ko ? '행 사번 수정' : '行更正工号'}`} value={corrections[issue.key] ?? ''} placeholder={issue.suggested_code ?? ''} disabled={busy || disabled} onChange={(event) => { invalidate(); setCorrections((current) => ({ ...current, [issue.key]: event.target.value })); }} /><button className="hr-icon-button" aria-label={`${issue.row}${ko ? '행 수정 취소' : '行取消更正'}`} disabled={busy || disabled || !Object.hasOwn(corrections, issue.key)} onClick={() => { invalidate(); setCorrections((current) => { const next = { ...current }; delete next[issue.key]; return next; }); }}><RotateCcw size={15} /></button></div></td></tr>)}</tbody></table></div></details>}
      <div className="hr-workbook-policy"><label className="hr-field">{ko ? '인원 배치 적용' : '人员配置方式'}<select value={policy} disabled={busy || disabled} onChange={(event) => { invalidate(); setPolicy(event.target.value as 'preserve' | 'reference'); }}><option value="preserve">{ko ? '같은 월의 기존 배치 유지 · 신규 인원은 기본 분류 적용' : '保留同月现有配置 · 新人员按基础分类配置'}</option><option value="reference">{ko ? '저장된 기본 분류로 다시 배치' : '按已保存基础分类重新配置'}</option></select></label><button className="hr-button" disabled={!canPreview} onClick={() => void inspect()}>{busy ? (ko ? '처리 중…' : '处理中…') : (ko ? '선택 월 미리보기' : '预览所选月份')}</button></div>
      {error && <p role="alert" className="hr-alert is-error">{error}</p>}
      {preview && <div className="hr-workbook-preview"><h3><CheckCircle2 size={16} />{ko ? '선택 월 검증 결과' : '所选月份验证结果'}</h3><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '월' : '月份'}</th><th>{ko ? '가져올 인원' : '导入人数'}</th><th>{ko ? '다른 고용 형태 유지' : '保留其他用工类型'}</th><th>{ko ? '미분류' : '未分类'}</th><th>{ko ? '금액 미입력' : '金额未填写'}</th><th className="hr-number">{ko ? '월 합계 (CNY)' : '月合计（CNY）'}</th></tr></thead><tbody>{preview.months.map((month) => <tr key={month.month}><td>{month.month}</td><td>{month.imported_count}</td><td>{month.retained_count}</td><td>{month.unassigned_count}</td><td>{month.missing_cost_count}</td><td className="hr-number">{month.total === null ? (ko ? '미확정' : '待确认') : compactMoney(month.total, 'CNY', lang)}{month.total === null && <small className="hr-workbook-known-total">{ko ? '입력분' : '已录入'} {compactMoney(month.known_total, 'CNY', lang)}</small>}</td></tr>)}</tbody></table></div>
        {preview.months.some((month) => month.version > 0) && <p className="hr-muted">{ko ? '기존 자료가 있는 월은 올린 고용 형태의 자료를 교체합니다. 다른 고용 형태의 인원은 유지합니다.' : '已存在资料的月份会替换此次上传类型的数据，其他用工类型人员予以保留。'}</p>}
        <div className="hr-workbook-save"><span>{ko ? '선택 월의 원본·기본 분류·합계를 확인한 뒤 저장하세요.' : '核对所选月份的原始资料、基础分类及合计后保存。'}</span><button className="hr-button is-primary" disabled={busy || disabled || conflict || !referenceReady || !preview.months.length} onClick={() => void save()}>{busy ? (ko ? '저장 중…' : '正在保存…') : (ko ? `선택 ${preview.months.length}개월 저장` : `保存所选 ${preview.months.length} 个月`)}</button></div>
      </div>}
      <button className="hr-button is-quiet" disabled={busy} onClick={resetSelection}><RotateCcw size={15} />{ko ? '임금표 선택 초기화' : '清除工资表选择'}</button>
    </div>}
  </section>;
}
