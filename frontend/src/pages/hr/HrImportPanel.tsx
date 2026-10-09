import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Upload, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { importHrWorkspace, previewHrImport } from '../../domains/hr/api';
import { downloadTemplate, getHeaderColumns, parseMappedRows, readWorkbook, suggestColumnMapping } from '../../domains/hr/import';
import type { HrCostBasis, HrCurrency, HrImportPreview, HrWorkspace } from '../../domains/hr/types';
import { isHrConflict, localHrError, money, safeHrError } from './hrCommon';

type Workbook = Awaited<ReturnType<typeof readWorkbook>>;
type ColumnMapping = ReturnType<typeof suggestColumnMapping>;

export default function HrImportPanel({ workspace, disabled, onImported, onBusyChange, onConflict }: {
  workspace: HrWorkspace; disabled: boolean; onImported: (workspace: HrWorkspace) => void;
  onBusyChange: (busy: boolean) => void; onConflict: () => void;
}) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<ColumnMapping>({ code: null, name: null, title: null, amount: null });
  const [currency, setCurrency] = useState<HrCurrency>(workspace.currency);
  const [basis, setBasis] = useState<HrCostBasis>(workspace.cost_basis);
  const [basisLabel, setBasisLabel] = useState(workspace.cost_basis_label);
  const [preview, setPreview] = useState<HrImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sheet = book?.sheets[sheetIndex];
  const headerResult = useMemo(() => {
    if (!sheet || !sheet.rows.length) return { headers: [], error: null };
    try { return { headers: getHeaderColumns(sheet, headerRow - 1), error: null }; }
    catch (failure) { return { headers: [], error: failure }; }
  }, [sheet, headerRow]);
  const headers = headerResult.headers;
  useEffect(() => { setColumns(suggestColumnMapping(headers)); setPreview(null); setError(''); }, [headers]);
  useEffect(() => { setPreview(null); }, [columns, currency, basis, basisLabel]);
  const start = () => { setBusy(true); onBusyChange(true); setError(''); };
  const finish = () => { if (mounted.current) setBusy(false); onBusyChange(false); };

  async function selectFile(file: File | undefined) {
    if (!file) return;
    start(); setPreview(null); setBook(null);
    try {
      if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error(ko ? 'XLSX 또는 CSV 파일을 선택해 주세요.' : '请选择 XLSX 或 CSV 文件。');
      if (file.size > 10 * 1024 * 1024) throw new Error(ko ? '파일 크기는 10 MB 이하여야 합니다.' : '文件大小不得超过 10 MB。');
      const parsed = await readWorkbook(file);
      if (!parsed.sheets.length) throw new Error(ko ? '읽을 수 있는 시트가 없습니다.' : '没有可读取的工作表。');
      if (mounted.current) { setBook(parsed); setSheetIndex(Math.max(0, parsed.sheets.findIndex((item) => item.rows.length > 0))); setHeaderRow(1); }
    } catch (failure) { if (mounted.current) setError(localHrError(failure, lang, ko ? '파일을 읽지 못했습니다.' : '无法读取文件，请检查格式与大小。')); }
    finally { finish(); }
  }

  async function inspect() {
    if (!book || !sheet) return;
    start(); setPreview(null);
    try {
      if (columns.code === null || columns.name === null || columns.amount === null) throw new Error(ko ? '사번, 이름, 인건비 열을 모두 선택해 주세요.' : '请选择员工编号、姓名及人工成本列。');
      if (basis === 'custom' && !basisLabel.trim()) throw new Error(ko ? '인건비 기준을 적어 주세요.' : '请填写成本口径。');
      const rows = parseMappedRows(sheet.rows, { headerRowIndex: headerRow - 1, columns: { code: columns.code, name: columns.name, title: columns.title, amount: columns.amount } });
      const result = await previewHrImport({ rows, currency, cost_basis: basis, cost_basis_label: basisLabel.trim(), source_filename: book.filename });
      if (mounted.current) setPreview(result);
    } catch (failure) { if (mounted.current) setError(ko ? safeHrError(failure, localHrError(failure, lang, '자료 검증에 실패했습니다.')) : localHrError(failure, lang, '资料验证失败，请检查数据及列映射。')); }
    finally { finish(); }
  }

  async function confirmImport() {
    if (!preview || !book) return;
    start();
    try {
      const result = await importHrWorkspace(workspace.month, {
        version: workspace.version, currency, cost_basis: basis, cost_basis_label: basisLabel.trim(),
        rows: preview.rows, source_filename: book.filename, expected_total: preview.total,
      });
      if (mounted.current) { onImported(result); setBook(null); setPreview(null); setOpen(false); if (fileInput.current) fileInput.current.value = ''; }
    } catch (failure) {
      if (mounted.current) {
        if (isHrConflict(failure)) { onConflict(); setError(ko ? '다른 사용자가 먼저 저장했습니다. 미리보기는 유지됩니다. 최신 자료를 불러온 뒤 다시 확인해 주세요.' : '其他用户已先行保存。预览已保留，请加载最新资料后再次确认。'); }
        else setError(safeHrError(failure, ko ? '가져오지 못했습니다. 파일과 미리보기는 유지됩니다.' : '导入失败，文件与预览已保留。'));
      }
    } finally { finish(); }
  }

  return <section className="hr-panel hr-import">
    <div className="hr-section-heading"><div><h2>{ko ? '월별 인건비 테이블' : '月度人工成本表'}</h2>
      <p>{ko ? '사번으로 같은 사람을 연결합니다. 다시 올리면 이 월의 인건비를 교체하고, 일치하는 사번의 부서 배치를 유지합니다.' : '按员工编号关联同一人员。重新导入将替换本月成本，并保留匹配编号的部门配置。'}</p></div>
      <div className="hr-actions"><button className="hr-button" onClick={downloadTemplate} disabled={busy}><Download size={16} />{ko ? '양식' : '模板'}</button>
        <button className="hr-button" disabled={disabled || busy} aria-expanded={open} onClick={() => setOpen(!open)}><Upload size={16} />{ko ? '자료 올리기' : '上传资料'}</button></div></div>
    {disabled && <p className="hr-muted">{ko ? '배치 변경을 저장하거나 버린 뒤 자료를 올릴 수 있습니다.' : '请保存或放弃配置更改后再上传资料。'}</p>}
    {open && <div className="hr-import-body">
      <label className="hr-field hr-file-field">{ko ? '인건비 파일 (XLSX / CSV · 최대 10 MB)' : '人工成本文件（XLSX / CSV · 最大 10 MB）'}
        <input ref={fileInput} type="file" accept=".xlsx,.csv" disabled={busy || disabled} onChange={(event) => void selectFile(event.target.files?.[0])} /></label>
      {book && <>
        <div className="hr-form-grid">
          <label className="hr-field">{ko ? '시트' : '工作表'}<select disabled={busy} value={sheetIndex} onChange={(event) => { setSheetIndex(Number(event.target.value)); setHeaderRow(1); }}>{book.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>
          <label className="hr-field">{ko ? '제목 행 번호' : '表头行号'}<input type="number" min="1" step="1" max={Math.max(1, sheet?.rows.length ?? 1)} disabled={busy} value={headerRow} onChange={(event) => setHeaderRow(Math.min(Math.max(1, Math.trunc(Number(event.target.value)) || 1), Math.max(1, sheet?.rows.length ?? 1)))} /></label>
          <label className="hr-field">{ko ? '통화' : '币种'}<select disabled={busy} value={currency} onChange={(event) => setCurrency(event.target.value as HrCurrency)}><option value="CNY">CNY · 人民币</option><option value="KRW">KRW · 원</option><option value="USD">USD · Dollar</option></select></label>
          <label className="hr-field">{ko ? '인건비 기준' : '成本口径'}<select disabled={busy} value={basis} onChange={(event) => setBasis(event.target.value as HrCostBasis)}><option value="employer_total">{ko ? '회사 부담 총인건비' : '公司承担的人工总成本'}</option><option value="gross_salary">{ko ? '세전 급여' : '税前工资'}</option><option value="custom">{ko ? '직접 정의' : '自定义'}</option></select></label>
        </div>
        {basis === 'custom' && <label className="hr-field">{ko ? '인건비 기준 설명' : '成本口径说明'}<input maxLength={100} value={basisLabel} disabled={busy} onChange={(event) => setBasisLabel(event.target.value)} placeholder={ko ? '예: 급여 + 회사 부담 사회보험' : '例如：工资 + 公司承担的社保'} /></label>}
        <div className="hr-form-grid">{(['code', 'name', 'title', 'amount'] as const).map((key) => <label key={key} className="hr-field">{{ code: ko ? '사번 (필수)' : '员工编号（必填）', name: ko ? '이름 (필수)' : '姓名（必填）', title: ko ? '직책 (선택)' : '职务（可选）', amount: ko ? '월 인건비 (필수)' : '月人工成本（必填）' }[key]}
          <select disabled={busy} value={columns[key] ?? ''} onChange={(event) => setColumns((current) => ({ ...current, [key]: event.target.value === '' ? null : Number(event.target.value) }))}><option value="">{ko ? '열 선택' : '选择列'}</option>{headers.map((header) => <option key={header.index} value={header.index}>{header.label}</option>)}</select>
        </label>)}</div>
        <p className="hr-muted">{ko ? '각 인원에 월 인건비 한 값을 사용합니다. 부서별 금액은 배치한 인원의 합계이며, 금액이 비어 있거나 사번이 중복되면 가져올 수 없습니다.' : '每位员工使用一个月度人工成本值。部门金额为已配置人员的合计，金额为空或编号重复时无法导入。'}</p>
        {Boolean(headerResult.error) && <p role="alert" className="hr-alert is-error">{localHrError(headerResult.error, lang, ko ? '제목 행을 확인해 주세요.' : '请检查表头行。')}</p>}
        {sheet && !sheet.rows.length && <p className="hr-muted">{ko ? '빈 시트입니다. 자료가 있는 시트를 선택해 주세요.' : '这是空工作表，请选择包含数据的工作表。'}</p>}
        <button className="hr-button" disabled={busy || disabled || !headers.length} onClick={() => void inspect()}>{busy ? (ko ? '처리 중…' : '处理中…') : (ko ? '자료 검증·미리보기' : '验证资料·预览')}</button>
      </>}
      {error && <p role="alert" className="hr-alert is-error">{error}</p>}
      {preview && <div className="hr-import-preview">
        <div className="hr-section-heading"><div><h3><CheckCircle2 size={18} />{ko ? '서버 검증 완료' : '服务器验证完成'}</h3><p>{preview.row_count.toLocaleString()} {ko ? '명' : '人'} · {money(preview.total, currency, lang)}</p></div></div>
        <div className="hr-table-scroll"><table><thead><tr><th>{ko ? '사번' : '编号'}</th><th>{ko ? '이름' : '姓名'}</th><th>{ko ? '직책' : '职务'}</th><th className="hr-number">{ko ? '월 인건비' : '月人工成本'}</th></tr></thead><tbody>{preview.rows.slice(0, 5).map((row) => <tr key={row.code}><td>{row.code}</td><td>{row.name}</td><td>{row.title || '—'}</td><td className="hr-number">{money(row.amount, currency, lang)}</td></tr>)}</tbody></table></div>
        <p>{ko ? `미리보기는 앞 ${Math.min(5, preview.row_count)}명입니다. 확인하면 ${workspace.month} 자료 ${workspace.employees.length}명을 검증한 ${preview.row_count}명으로 교체합니다.` : `预览显示前 ${Math.min(5, preview.row_count)} 人。确认后将以已验证的 ${preview.row_count} 人替换 ${workspace.month} 现有 ${workspace.employees.length} 人资料。`}</p>
        <button className="hr-button is-primary" disabled={busy || disabled} onClick={() => void confirmImport()}>{busy ? (ko ? '가져오는 중…' : '正在导入…') : (ko ? '확인하고 이 월의 자료 가져오기' : '确认并导入本月资料')}</button>
      </div>}
      <button className="hr-button is-quiet" disabled={busy} onClick={() => { setOpen(false); setBook(null); setPreview(null); setError(''); }}><X size={16} />{ko ? '업로드 닫기' : '关闭上传'}</button>
    </div>}
  </section>;
}
