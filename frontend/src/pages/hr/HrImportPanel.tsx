import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Upload, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { importHrWorkspace, previewHrImport } from '../../domains/hr/api';
import { getClassificationLabel } from '../../domains/hr/company-structure';
import { downloadTemplate, getHeaderColumns, parsePayrollRows, readWorkbook, suggestColumnMapping } from '../../domains/hr/import';
import type { HrCostBasis, HrCurrency, HrImportPreview, HrWorkspace } from '../../domains/hr/types';
import { isHrConflict, localHrError, money, safeHrError } from './hrCommon';

type Workbook = Awaited<ReturnType<typeof readWorkbook>>;
type ColumnMapping = ReturnType<typeof suggestColumnMapping>;
const emptyColumns: ColumnMapping = {
  code: null, name: null, title: null, amount: null, period: null, source_department: null,
  classification_group: null, classification_function: null, classification_code: null,
};

export default function HrImportPanel({ workspace, disabled, onImported, onBusyChange, onConflict }: {
  workspace: HrWorkspace; disabled: boolean; onImported: (workspace: HrWorkspace) => void;
  onBusyChange: (busy: boolean) => void; onConflict: () => void;
}) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<ColumnMapping>(emptyColumns);
  const [currency, setCurrency] = useState<HrCurrency>(workspace.currency);
  const [basis, setBasis] = useState<HrCostBasis>(workspace.source ? workspace.cost_basis : 'gross_salary');
  const [basisLabel, setBasisLabel] = useState(workspace.cost_basis_label);
  const [classificationMode, setClassificationMode] = useState<'preserve' | 'file'>('preserve');
  const [classificationInput, setClassificationInput] = useState<'pair' | 'code'>('pair');
  const [allowMissingCost, setAllowMissingCost] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState<HrImportPreview | null>(null);
  const [excludedRows, setExcludedRows] = useState(0);
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
  useEffect(() => {
    const suggested = suggestColumnMapping(headers);
    setColumns(suggested); setPreview(null); setError('');
    setClassificationMode(suggested.classification_group !== null && suggested.classification_function !== null ? 'file' : 'preserve');
  }, [headers]);
  useEffect(() => { setPreview(null); }, [columns, currency, basis, basisLabel, classificationMode, classificationInput, allowMissingCost, workspace.month]);
  useEffect(() => {
    const label = headers.find((header) => header.index === columns.amount)?.label.replace(/\s+/g, '') ?? '';
    if (label === '应发工资' || label === '應發工資') { setBasis('gross_salary'); setBasisLabel('应发工资'); }
    if (label === '实发工资' || label === '實發工資') { setBasis('custom'); setBasisLabel('实发工资'); }
  }, [columns.amount, headers]);
  const start = () => { setBusy(true); onBusyChange(true); setError(''); };
  const finish = () => { if (mounted.current) setBusy(false); onBusyChange(false); };

  async function selectFile(file: File | undefined) {
    if (!file) return;
    start(); setPreview(null); setBook(null); setExcludedRows(0); setAllowMissingCost(false);
    try {
      if (!/\.(xlsx|csv|tsv|txt)$/i.test(file.name)) throw new Error(ko ? 'XLSX, CSV, TSV 또는 TXT 파일을 선택해 주세요.' : '请选择 XLSX、CSV、TSV 或 TXT 文件。');
      if (file.size > 10 * 1024 * 1024) throw new Error(ko ? '파일 크기는 10 MB 이하여야 합니다.' : '文件大小不得超过 10 MB。');
      const parsed = await readWorkbook(file);
      if (!parsed.sheets.length) throw new Error(ko ? '읽을 수 있는 시트가 없습니다.' : '没有可读取的工作表。');
      if (mounted.current) {
        setBook(parsed); setSheetIndex(Math.max(0, parsed.sheets.findIndex((item) => item.rows.length > 0))); setHeaderRow(1);
      }
    } catch (failure) {
      if (mounted.current) setError(localHrError(failure, lang, ko ? '파일을 읽지 못했습니다.' : '无法读取文件，请检查格式与大小。'));
    } finally { finish(); }
  }

  async function inspect() {
    if (!book || !sheet) return;
    start(); setPreview(null);
    try {
      if (columns.code === null || columns.name === null) throw new Error(ko ? '사번과 이름 열을 선택해 주세요.' : '请选择员工编号与姓名列。');
      if (columns.amount === null && !allowMissingCost) throw new Error(ko ? '인건비 열을 선택하거나 인원 명단만 가져오기를 확인해 주세요.' : '请选择成本列，或确认仅导入人员名单。');
      if (classificationMode === 'file' && (classificationInput === 'pair'
        ? columns.classification_group === null || columns.classification_function === null
        : columns.classification_code === null)) {
        throw new Error(ko ? '새 분류의 부문·기능 두 열을 선택해 주세요. 코드 방식은 고급 설정에서 선택할 수 있습니다.' : '请选择新分类的部门与职能两列，代码方式可在高级设置中选择。');
      }
      if (basis === 'custom' && !basisLabel.trim()) throw new Error(ko ? '인건비 기준을 적어 주세요.' : '请填写成本口径。');
      const activeColumns = {
        ...columns,
        classification_group: classificationMode === 'file' && classificationInput === 'pair' ? columns.classification_group : null,
        classification_function: classificationMode === 'file' && classificationInput === 'pair' ? columns.classification_function : null,
        classification_code: classificationMode === 'file' && classificationInput === 'code' ? columns.classification_code : null,
      };
      const parsed = parsePayrollRows(sheet.rows, {
        headerRowIndex: headerRow - 1, columns: activeColumns, targetMonth: workspace.month,
        classificationMode, allowMissingCost,
      });
      const result = await previewHrImport({
        month: workspace.month, rows: parsed.rows, currency, cost_basis: basis,
        cost_basis_label: basisLabel.trim(), source_filename: book.filename,
        apply_classification: classificationMode === 'file', allow_missing_cost: allowMissingCost,
      });
      if (mounted.current) { setPreview(result); setExcludedRows(parsed.excluded_row_count); }
    } catch (failure) {
      if (mounted.current) setError(ko
        ? safeHrError(failure, localHrError(failure, lang, '자료 검증에 실패했습니다.'))
        : localHrError(failure, lang, '资料验证失败，请检查数据、月份及列映射。'));
    } finally { finish(); }
  }

  async function confirmImport() {
    if (!preview || !book) return;
    start();
    try {
      const result = await importHrWorkspace(workspace.month, {
        month: workspace.month, version: workspace.version, currency,
        cost_basis: basis, cost_basis_label: basisLabel.trim(), rows: preview.rows,
        source_filename: book.filename, expected_total: preview.total,
        apply_classification: classificationMode === 'file', allow_missing_cost: allowMissingCost,
      });
      if (mounted.current) {
        onImported(result); setBook(null); setPreview(null); setPasteText(''); setOpen(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    } catch (failure) {
      if (mounted.current) {
        if (isHrConflict(failure)) {
          onConflict(); setError(ko ? '다른 사용자가 먼저 저장했습니다. 미리보기는 유지됩니다. 최신 자료를 불러온 뒤 다시 확인해 주세요.' : '其他用户已先行保存。预览已保留，请加载最新资料后再次确认。');
        } else setError(safeHrError(failure, ko ? '가져오지 못했습니다. 파일과 미리보기는 유지됩니다.' : '导入失败，文件与预览已保留。'));
      }
    } finally { finish(); }
  }

  const columnLabels: Record<keyof ColumnMapping, string> = {
    code: ko ? '사번' : '员工编号',
    name: ko ? '이름' : '姓名',
    title: ko ? '직책' : '职务',
    amount: ko ? '월 인건비' : '月人工成本',
    period: ko ? '원본 월' : '原始月份',
    source_department: ko ? '원본 부서' : '原始部门',
    classification_group: ko ? '새 부문' : '新部门',
    classification_function: ko ? '새 기능' : '新职能',
    classification_code: ko ? '분류 코드' : '分类代码',
  };
  function columnSelect(key: keyof ColumnMapping) {
    return <label key={key} className="hr-field">{columnLabels[key]}
      <select disabled={busy} value={columns[key] ?? ''}
        onChange={(event) => setColumns((current) => ({ ...current, [key]: event.target.value === '' ? null : Number(event.target.value) }))}>
        <option value="">{ko ? '열 선택 안 함' : '不选择列'}</option>
        {headers.map((header) => <option key={header.index} value={header.index}>{header.label}</option>)}
      </select>
    </label>;
  }
  function classificationLabel(id: string | null | undefined) {
    if (!id) return ko ? '미배치' : '待配置';
    const department = workspace.departments.find((item) => item.id === id);
    const label = getClassificationLabel(id);
    return department ? `${department.name} (${id})` : `${label || id}${label && label !== id ? ` (${id})` : ''}`;
  }
  const missingCount = preview?.missing_cost_count ?? 0;
  const knownCount = preview?.known_cost_count ?? 0;

  return <section className="hr-panel hr-import is-compact">
    <div className="hr-import-heading">
      <h2>{ko ? '월별 자료' : '月度资料'}</h2><span className="hr-muted">{workspace.month}{book ? ` · ${book.filename}` : ''}</span>
      <div className="hr-actions"><button className="hr-button" onClick={downloadTemplate} disabled={busy}><Download size={15} />{ko ? '양식' : '模板'}</button>
        <button className="hr-button" disabled={disabled || busy} aria-expanded={open} onClick={() => setOpen(!open)}><Upload size={15} />{open ? (ko ? '접기' : '收起') : (ko ? '자료 올리기' : '上传资料')}</button></div>
    </div>
    {disabled && <p className="hr-muted">{ko ? '배치 변경을 저장하거나 버린 뒤 업로드하세요.' : '保存或放弃配置更改后再上传。'}</p>}
    {open && <div className="hr-import-body">
      <label className="hr-field hr-file-field">{ko ? '파일 · XLSX / CSV / TSV / TXT · 최대 10 MB' : '文件 · XLSX / CSV / TSV / TXT · 最大 10 MB'}
        <input ref={fileInput} type="file" accept=".xlsx,.csv,.tsv,.txt" disabled={busy || disabled} onChange={(event) => void selectFile(event.target.files?.[0])} /></label>
      <details className="hr-disclosure"><summary>{ko ? '표 붙여넣기' : '粘贴表格'}</summary>
        <label className="hr-field">{ko ? '제목 행 포함' : '包含表头'}<textarea rows={3} maxLength={10 * 1024 * 1024} value={pasteText} disabled={busy || disabled}
          onChange={(event) => setPasteText(event.target.value)} placeholder={ko ? 'Excel에서 복사한 표' : '从 Excel 复制的表格'} /></label>
        <button className="hr-button" disabled={busy || disabled || !pasteText.trim()}
          onClick={() => void selectFile(new File([pasteText], 'pasted-payroll.tsv', { type: 'text/tab-separated-values;charset=utf-8' }))}>{ko ? '표 읽기' : '读取表格'}</button>
      </details>
      {book && <>
        <div className="hr-import-mapping">
          {(['code', 'name', 'amount'] as const).map(columnSelect)}
          <label className="hr-field">{ko ? '배치 분류' : '配置分类'}<select value={classificationMode} disabled={busy} onChange={(event) => setClassificationMode(event.target.value as 'preserve' | 'file')}>
            <option value="preserve">{ko ? '기존 배치 유지' : '保留现有配置'}</option><option value="file">{ko ? '새 부문·기능 적용' : '应用新部门·职能'}</option>
          </select></label>
          {classificationMode === 'file' && classificationInput === 'pair' && (['classification_group', 'classification_function'] as const).map(columnSelect)}
        </div>
        <details className="hr-disclosure hr-import-settings"><summary>{ko ? '원본 월·부서·급여 기준 설정' : '原始月份·部门·工资口径设置'}
          <span className="hr-mapping-summary"> · {columns.period === null ? (ko ? '월 열 없음' : '无月份列') : headers.find((header) => header.index === columns.period)?.label} · {currency} · {basis === 'gross_salary' ? (ko ? '세전 급여' : '税前工资') : basis === 'employer_total' ? (ko ? '회사 부담 총액' : '公司承担总额') : basisLabel || (ko ? '직접 정의' : '自定义')}</span>
        </summary>
          <div className="hr-import-mapping">
            <label className="hr-field">{ko ? '시트' : '工作表'}<select disabled={busy} value={sheetIndex} onChange={(event) => { setSheetIndex(Number(event.target.value)); setHeaderRow(1); }}>{book.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>
            <label className="hr-field">{ko ? '제목 행' : '表头行'}<input type="number" min="1" step="1" max={Math.max(1, sheet?.rows.length ?? 1)} disabled={busy} value={headerRow} onChange={(event) => setHeaderRow(Math.min(Math.max(1, Math.trunc(Number(event.target.value)) || 1), Math.max(1, sheet?.rows.length ?? 1)))} /></label>
            {(['period', 'source_department', 'title'] as const).map(columnSelect)}
            <label className="hr-field">{ko ? '통화' : '币种'}<select disabled={busy} value={currency} onChange={(event) => setCurrency(event.target.value as HrCurrency)}><option value="CNY">CNY</option><option value="KRW">KRW</option><option value="USD">USD</option></select></label>
            <label className="hr-field">{ko ? '인건비 기준' : '成本口径'}<select disabled={busy} value={basis} onChange={(event) => setBasis(event.target.value as HrCostBasis)}><option value="employer_total">{ko ? '회사 부담 총인건비' : '公司承担总成本'}</option><option value="gross_salary">{ko ? '세전 급여' : '税前工资'}</option><option value="custom">{ko ? '직접 정의' : '自定义'}</option></select></label>
            {basis === 'custom' && <label className="hr-field">{ko ? '기준 설명' : '口径说明'}<input maxLength={100} value={basisLabel} disabled={busy} onChange={(event) => setBasisLabel(event.target.value)} /></label>}
          </div>
          {classificationMode === 'file' && <>
            <label className="hr-checkbox"><input type="checkbox" checked={classificationInput === 'code'} disabled={busy}
              onChange={(event) => setClassificationInput(event.target.checked ? 'code' : 'pair')} />{ko ? '고급: 두 열 대신 분류 코드 사용' : '高级：使用分类代码替代两列'}</label>
            {classificationInput === 'code' && columnSelect('classification_code')}
          </>}
          <p className="hr-muted">{ko ? '원본 부서는 별도 보관합니다. 새 분류가 비면 미배치입니다.' : '原始部门单独保留，新分类为空时待配置。'}</p>
        </details>
        <div className="hr-compact-toolbar">
          <label className="hr-checkbox"><input type="checkbox" checked={allowMissingCost} disabled={busy} onChange={(event) => setAllowMissingCost(event.target.checked)} />{ko ? '인원만 먼저 가져오기 · 빈 금액은 미입력' : '先导入人员 · 空金额记为未填写'}</label>
          <button className="hr-button" disabled={busy || disabled || !headers.length} onClick={() => void inspect()}>{busy ? (ko ? '처리 중…' : '处理中…') : (ko ? '월 자료 검증' : '验证月度资料')}</button>
        </div>
        {columns.period === null && <p className="hr-muted">{ko ? `월 열 없음: 모든 행을 ${workspace.month} 자료로 가져옵니다.` : `无月份列：所有记录按 ${workspace.month} 导入。`}</p>}
        {allowMissingCost && <p className="hr-muted">{ko ? '금액 미입력이 있으면 월 총계는 미확정입니다.' : '存在未填写金额时，月总计为未确认。'}</p>}
        {Boolean(headerResult.error) && <p role="alert" className="hr-alert is-error">{localHrError(headerResult.error, lang, ko ? '제목 행을 확인해 주세요.' : '请检查表头行。')}</p>}
        {sheet && !sheet.rows.length && <p className="hr-muted">{ko ? '빈 시트입니다. 자료가 있는 시트를 선택하세요.' : '空工作表，请选择有资料的工作表。'}</p>}
      </>}
      {error && <p role="alert" className="hr-alert is-error">{error}</p>}
      {preview && <div className="hr-import-preview">
        <div className="hr-import-review"><CheckCircle2 size={16} /><strong>{workspace.month}</strong>
          <span>{preview.row_count.toLocaleString()} {ko ? '명' : '人'}</span><span>{ko ? '다른 월 제외' : '排除其他月份'} {excludedRows.toLocaleString()}</span><span>{ko ? '금액 미입력' : '金额未填写'} {missingCount.toLocaleString()}</span></div>
        <div className="hr-import-values"><span>{ko ? '월 총계' : '月总计'} <strong>{preview.total === null ? (ko ? '미확정' : '未确认') : money(preview.total, currency, lang)}</strong></span>
          {missingCount > 0 && <span>{ko ? '확인 소계' : '已确认小计'} <strong>{money(preview.known_total, currency, lang)}</strong> · {knownCount.toLocaleString()} {ko ? '명' : '人'}</span>}</div>
        <details className="hr-disclosure"><summary>{ko ? `직원 미리보기 · 첫 ${Math.min(5, preview.row_count)}명` : `人员预览 · 前 ${Math.min(5, preview.row_count)} 人`}</summary>
          <div className="hr-table-scroll"><table><thead><tr><th>{ko ? '사번' : '编号'}</th><th>{ko ? '이름' : '姓名'}</th><th>{ko ? '직책' : '职务'}</th><th>{ko ? '원본 부서' : '原始部门'}</th><th>{ko ? '새 분류·배치' : '新分类·配置'}</th><th className="hr-number">{ko ? '월 인건비' : '月人工成本'}</th></tr></thead>
            <tbody>{preview.rows.slice(0, 5).map((row) => <tr key={row.code}><td>{row.code}</td><td>{row.name}</td><td>{row.title || '—'}</td><td>{row.source_department || '—'}</td><td>{classificationMode === 'file' ? classificationLabel(row.department_id) : classificationLabel(workspace.employees.find((employee) => employee.code === row.code)?.department_id)}</td><td className="hr-number">{row.amount === null ? (ko ? '미입력' : '未填写') : money(row.amount, currency, lang)}</td></tr>)}</tbody>
          </table></div>
        </details>
        <div className="hr-compact-toolbar"><span>{ko ? `기존 ${workspace.employees.length}명 → ${preview.row_count}명 교체` : `现有 ${workspace.employees.length} 人 → ${preview.row_count} 人替换`} · {classificationMode === 'file' ? (ko ? '새 분류 적용 · 빈 분류 미배치' : '应用新分类 · 空分类待配置') : (ko ? '기존 배치 유지' : '保留现有配置')}</span>
          <button className="hr-button is-primary" disabled={busy || disabled} onClick={() => void confirmImport()}>{busy ? (ko ? '가져오는 중…' : '正在导入…') : (ko ? '확인 후 가져오기' : '确认导入')}</button></div>
      </div>}
      <button className="hr-button is-quiet" disabled={busy} onClick={() => { setOpen(false); setBook(null); setPreview(null); setPasteText(''); setError(''); }}><X size={15} />{ko ? '업로드 닫기' : '关闭上传'}</button>
    </div>}
  </section>;
}
