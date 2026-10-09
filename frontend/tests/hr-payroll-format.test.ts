import assert from 'node:assert/strict';
import test from 'node:test';
import { getHeaderColumns, suggestColumnMapping, parsePayrollRows, parsePayrollPeriod, readWorkbook, createTemplateCsv } from '../src/domains/hr/import.ts';
import { COMPANY_CLASSIFICATION, COMPANY_ORGANIZATION, resolveClassification } from '../src/domains/hr/company-structure.ts';

const headers = ['2026年','工号','姓名','职务','部门','应发工资','实发工资','可视化部门','可视化职能'];
const columns = suggestColumnMapping(getHeaderColumns({ name: '工资', rows: [headers] }, 0));
const parse = (rows: unknown[][], month='2026-01', allowMissingCost=false) => parsePayrollRows([headers,...rows], {headerRowIndex:0,columns,targetMonth:month,classificationMode:'file',allowMissingCost});

test('year header and employee-month grouping preserve codes and exclude other months before duplicates', () => {
  const result = parse([['1月','0001','样例 A','负责人','品质','10.10','9.00','品质管理','CS'], ['2月','0001','样例 A','负责人','品质','20.20','18.00','营业管理','CS']]);
  assert.equal(result.rows.length,1); assert.equal(result.excluded_row_count,1);
  assert.equal(result.rows[0].period,'2026-01'); assert.equal(result.rows[0].amount,'10.10');
  assert.equal(result.rows[0].source_department,'品质'); assert.equal(result.rows[0].department_id,'quality-cs');
  assert.equal(parse([['2月','0001','样例 A','','品质','20.20','','营业管理','CS']], '2026-02').rows[0].department_id,'sales-cs');
  assert.throws(()=>parse([['1月','E','A','','','1','','品质管理','CS'],['1月','E','A','','','1','','品质管理','CS']]),/중복 사번/);
});

test('classification is explicit and duplicate functional names remain department scoped', () => {
  assert.equal(resolveClassification({group:'注塑管理',function:'操作工'}),'injection-operator');
  assert.equal(resolveClassification({group:'加工管理',function:'操作工'}),'machining-operator');
  assert.equal(resolveClassification({group:'管理部门',function:'人事/总务'}),'admin-hr');
  assert.equal(resolveClassification({group:'품질관리',function:'CS'}),'quality-cs');
  assert.equal(resolveClassification({group:'品质管理',function:'管理'}),'quality');
  assert.equal(resolveClassification({} ),null);
  assert.throws(()=>resolveClassification({function:'CS'}),/부문/);
  assert.throws(()=>resolveClassification({group:'品质管理',function:'操作工'}),/조합/);
  assert.throws(()=>resolveClassification({code:'nonexistent'}),/코드/);
});

test('development managers and staff import separately while IQC and OQC share the existing inspection cell', () => {
  const result = parse([
    ['1月','11','샘플 A','','','100.10','','개발','관리자'],
    ['1月','12','샘플 B','','','200.20','','开发部','开发人员'],
    ['1月','13','샘플 C','','','10.10','','품질','입출고 검사'],
    ['1月','14','샘플 D','','','20.20','','品质','IQC'],
    ['1月','15','샘플 E','','','30.30','','品质管理','OQC'],
  ]);
  assert.deepEqual(result.rows.map(row => row.department_id), ['development','development-staff','quality-oqc','quality-oqc','quality-oqc']);
  assert.equal(resolveClassification({group:'개발 부문',function:'개발 실무'}),'development-staff');
  for (const label of ['출고 검사','출하검사','입고검사','进出货检验','IQC/OQC']) {
    assert.equal(resolveClassification({group:'품질',function:label}),'quality-oqc');
  }
  assert.throws(()=>resolveClassification({group:'개발',function:'IQC'}),/조합/);
});

test('blank cost is unknown only with explicit roster intake; zero remains a real zero', () => {
  const rows=[['1月','E','A','','注塑','','','注塑管理','操作工']];
  assert.throws(()=>parse(rows),/인건비가 비어/);
  assert.equal(parse(rows,'2026-01',true).rows[0].amount,null);
  assert.equal(parse(rows,'2026-01',true).missing_cost_count,1);
  assert.equal(parse([['1月','E','A','','注塑','0','','注塑管理','操作工']]).rows[0].amount,'0.00');
  const noAmount={...columns,amount:null};
  assert.equal(parsePayrollRows([headers,...rows],{headerRowIndex:0,columns:noAmount,targetMonth:'2026-01',classificationMode:'file',allowMissingCost:true}).rows[0].amount,null);
});

test('original department/title never infer classification and preserve mode never submits a hidden target', () => {
  const result=parse([['1月','E','A','操作工','注塑','10','','','']]);
  assert.equal(result.rows[0].department_id,null);
  const preserved=parsePayrollRows([headers,['1月','E','A','','注塑','10','','bad group','bad function']],{headerRowIndex:0,columns,targetMonth:'2026-01',classificationMode:'preserve',allowMissingCost:false});
  assert.equal('department_id' in preserved.rows[0],false);
});

test('period ambiguity, cross-year selection, unmapped costs and negative gross pay cannot silently enter a month', () => {
  assert.equal(parsePayrollPeriod('12月','2026-01','2025年'),'2025-12');
  assert.equal(parsePayrollPeriod('2026年2月','2026-02','月份'),'2026-02');
  assert.throws(()=>parsePayrollPeriod('13月','2026-01','2026年'),/급여 월/);
  assert.throws(()=>parse([['1月','E','A','','','1','','','']], '2025-01'),/선택한 월/);
  assert.throws(()=>parse([['1月','E','A','','','-1','','','']]),/인건비는/);
});

test('company template and multi-line tab paste are readable without private fixtures', async () => {
  const book=await readWorkbook(new File([createTemplateCsv()],'payroll.csv'));
  const mapped=suggestColumnMapping(getHeaderColumns(book.sheets[0],0));
  assert.throws(()=>parsePayrollRows(book.sheets[0].rows,{headerRowIndex:0,columns:mapped,targetMonth:'2026-01',classificationMode:'file',allowMissingCost:false}),/가져올 직원이 없습니다/);
  const completed=await readWorkbook(new File([createTemplateCsv()+'2026-01,00001,样例员工,职员,注塑,10.00,注塑管理,操作工\r\n'],'payroll.csv'));
  const imported=parsePayrollRows(completed.sheets[0].rows,{headerRowIndex:0,columns:mapped,targetMonth:'2026-01',classificationMode:'file',allowMissingCost:false});
  assert.equal(imported.rows[0].code,'00001'); assert.equal(imported.rows[0].department_id,'injection-operator');
  const tab='2026年\t工号\t姓名\t职务\t部门\t应发工资\t可视化部门\t可视化职能\r\n1月\t0007\t样例员工\t"财务部长兼\n办公室主任"\t管理部\t\t管理部门\t财务\r\n2月\t0007\t样例员工\t职员\t管理部\t\t管理部门\t财务\r\n';
  const parsed=await readWorkbook(new File([tab],'copied-table.txt'));
  const mapping=suggestColumnMapping(getHeaderColumns(parsed.sheets[0],0));
  const data=parsePayrollRows(parsed.sheets[0].rows,{headerRowIndex:0,columns:mapping,targetMonth:'2026-01',classificationMode:'file',allowMissingCost:true});
  assert.equal(data.rows[0].code,'0007'); assert.equal(data.rows[0].title,'财务部长兼\n办公室主任'); assert.equal(data.excluded_row_count,1);
});

test('cost-cell geometry and reporting hierarchy stay separate and contain every supplied function', () => {
  assert.equal(COMPANY_CLASSIFICATION.groups.length,8); assert.equal(COMPANY_CLASSIFICATION.leaders.length,3);
  assert.equal(COMPANY_CLASSIFICATION.groups.filter(g=>g.row===1).length,5);
  const qa=COMPANY_ORGANIZATION.nodes.find(n=>n.id==='qa'); assert.equal(qa?.parent_id,'chairman');
  assert.equal(COMPANY_ORGANIZATION.nodes.find(n=>n.id==='finance')?.parent_id,'office');
  assert.equal(COMPANY_ORGANIZATION.nodes.find(n=>n.id==='purchasing')?.parent_id,'sales-operations');
});
