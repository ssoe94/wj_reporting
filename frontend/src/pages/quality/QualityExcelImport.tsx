import axios from 'axios';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileSpreadsheet,
  FileWarning,
  Images,
  Layers3,
  Loader2,
  RefreshCw,
  Rows3,
  Save,
  ShieldCheck,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import PermissionButton from '../../components/common/PermissionButton';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import {
  QUALITY_IMPORT_MAX_FILE_BYTES,
  getQualityImportBatch,
  getQualityImportMediaObjectUrl,
  listQualityImportBatches,
  listQualityImportRows,
  publishQualityImportRow,
  retryQualityImportBatch,
  updateQualityImportRow,
  uploadQualityImportBatch,
} from './importApi';
import type {
  QualityImportBatch,
  QualityImportClientUploadProgress,
  QualityImportDuplicateAction,
  QualityImportDuplicateMatch,
  QualityImportDeltaStatus,
  QualityImportEditableReviewStatus,
  QualityImportMedia,
  QualityImportReviewStatus,
  QualityImportRow,
  QualityImportRowUpdate,
  QualityImportScopeRequest,
} from './importTypes';

const PAGE_SIZE = 20;
const PENDING_NOTIFICATION_STORAGE_KEY_PREFIX = 'wj-quality-import-pending-batches-v1';

function loadPendingNotificationIds(storageKey: string): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((value): value is number => Number.isSafeInteger(value) && value > 0));
  } catch {
    return new Set();
  }
}

function persistPendingNotificationIds(storageKey: string, ids: Set<number>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([...ids].sort((left, right) => left - right)),
    );
  } catch {
    // Completion remains visible in the batch list if storage is unavailable.
  }
}

const copy = {
  ko: {
    title: 'Excel 품질 자료 가져오기',
    description: '품질팀 Excel 한 파일을 서버에서 읽어 행과 내장 사진을 검토용 초안으로 정리합니다.',
    sourcePolicy: 'Excel 원본은 처리가 끝나면 폐기하고, 추출한 사진만 규격에 맞게 정규화해 저장합니다. 자동으로 확정할 수 없는 값은 임의로 채우지 않고 검토 필요로 남깁니다.',
    noPublish: '가져온 자료는 자동 등록되지 않습니다. 행을 먼저 검토 완료한 뒤, 별도의 ‘품질 보고서로 승인·등록’ 버튼을 눌러야 기존 불량 보고서가 생성됩니다.',
    drop: '.xlsx 파일을 놓거나 클릭해 선택하세요',
    scopeTitle: '업데이트 기간 설정',
    scopeDescription: 'Excel에서 이 기간의 불량 행과 연결 사진만 가져옵니다. 날짜를 확인할 수 없는 행은 별도 검토 대상으로 보존합니다.',
    scopeYesterday: '어제',
    scopeCustom: '직접 기간 설정',
    scopeFull: '전체 기간',
    scopeFullHelp: '최초 등록이나 과거 기록 보강에 사용합니다.',
    scopeStart: '시작일',
    scopeEnd: '종료일',
    scopeConfirm: '이 기간으로 업로드',
    scopeRequired: '시작일과 종료일을 모두 선택하세요.',
    scopeInvalid: '시작일은 종료일보다 늦을 수 없습니다.',
    scopeRangeEmpty: '선택한 기간에 해당하는 불량 행이 없습니다.',
    scopeApplied: '가져오기 범위',
    scopeFullLabel: '전체 기간',
    scopeRowsSummary: '원본 {source}행 · 선택 {selected}행 · 날짜 확인 필요 {undated}행 · 제외 {excluded}행',
    largeFile: '최대 80MB · 업로드 후 서버에서 행과 사진을 처리합니다.',
    uploading: '업로드 중',
    accepted: '업로드가 완료되었습니다. 서버에서 행과 사진을 정리하는 동안 페이지를 닫거나 다른 업무를 해도 됩니다.',
    recent: '최근 가져오기',
    recentEmpty: '아직 가져온 Excel 파일이 없습니다.',
    refresh: '새로고침',
    duplicate: '같은 내용의 파일이 이미 있어 기존 결과를 불러왔습니다.',
    invalidFile: '.xlsx 형식의 Excel 파일만 선택할 수 있습니다.',
    emptyFile: '내용이 없는 파일은 접수할 수 없습니다.',
    oversizedFile: 'Excel 파일은 최대 80MB까지 업로드할 수 있습니다.',
    permissionDenied: '품질 자료를 업로드할 권한이 없습니다.',
    authRequired: '로그인 정보가 만료되었습니다. 다시 로그인한 뒤 업로드해 주세요.',
    invalidWorkbook: 'Excel 파일 형식이나 내용을 확인한 뒤 다시 업로드해 주세요.',
    retryUpload: '다시 업로드',
    rows: '추출 행',
    images: '내장 사진',
    warnings: '확인 사항',
    sheets: '시트',
    processingTitle: '서버 처리 중',
    processingDesc: '행과 사진을 정리하고 있습니다. 페이지를 닫아도 계속 진행되며, 다시 열면 최신 상태를 확인할 수 있습니다.',
    reviewNotice: '자동 정리 중 확인이 필요한 항목이 있습니다. 아래 검토 목록에서 원본값과 사진을 확인하세요.',
    readyCompleted: 'Excel 품질 자료의 사진 추출과 정규화가 완료되었습니다.',
    failedTitle: '이 파일을 처리하지 못했습니다',
    failedDesc: '파일 형식과 내용을 확인한 뒤 다시 처리하거나 원본 파일을 다시 업로드해 주세요.',
    retry: '다시 처리',
    retrying: '재처리 요청 중',
    retrySuccess: '서버에서 다시 처리하도록 요청했습니다.',
    retryFailed: '재처리를 시작하지 못했습니다. 원본 파일을 다시 올려주세요.',
    drafts: '정규화 초안',
    draftsDescription: '원본 시트와 행 번호를 유지한 상태로 추출되었습니다. 확인 사항이 있는 행부터 검토하세요.',
    allSheets: '전체 시트',
    allStatuses: '전체 검토 상태',
    allDeltas: '전체 증분 구분',
    draft: '검토 필요',
    reviewed: '검토 완료',
    rejected: '제외',
    published: '보고서 등록',
    unchangedReview: '변경 없음',
    deltaAdded: '신규',
    deltaChanged: '수정',
    deltaUnchanged: '동일',
    loadingRows: '정규화 초안을 불러오는 중입니다.',
    emptyRows: '조건에 맞는 초안이 없습니다.',
    source: '원본',
    date: '발생일',
    modelPart: '모델 / P/N',
    phenomenon: '불량 현상',
    quantity: '수량',
    media: '사진',
    status: '검토 상태',
    action: '검토',
    unknown: '미확인',
    lot: 'LOT',
    inspection: '검사',
    defect: '불량',
    previous: '이전',
    next: '다음',
    page: '페이지',
    reviewTitle: '정규화 초안 검토',
    reviewDescription: 'Excel 원본값과 사진을 확인하고 필요한 필드만 보정하세요. 저장 전에는 변경되지 않습니다.',
    rowWarnings: '이 행의 확인 사항',
    sheetRow: '시트 / 원본 행',
    reportDate: '발생일',
    section: '발생 부서·공정',
    occurrenceLocation: '발생 위치',
    model: '모델',
    partNo: 'Part No.',
    itemName: '품명',
    lotQty: 'LOT 수량',
    inspectionQty: '검사 수량',
    defectQty: '불량 수량',
    defectRate: '불량률 (%)',
    judgement: '판정',
    disposition: '처리 방식',
    actionResult: '처리 결과',
    photos: '연결 사진',
    noPhotos: '이 행에 연결된 사진이 없습니다.',
    photoNeedsReview: '사진 확인 필요',
    photoPolicy: 'Excel에 연결된 사진은 3장을 초과해도 가져오기 기록에 모두 보존됩니다. 품질 보고서 승인·등록 시 기존 보고서에는 순서상 앞의 3장만 연결됩니다.',
    raw: 'Excel 원본값 보기',
    cancel: '취소',
    saveDraft: '초안으로 저장',
    markReviewed: '검토 완료로 저장',
    markRejected: '제외로 저장',
    publishAction: '품질 보고서로 승인·등록',
    publishGuide: '검토 완료 상태이며 저장하지 않은 변경이 없어야 승인·등록할 수 있습니다. 발생일·부서·모델 또는 P/N·불량 현상은 필수입니다.',
    publishSuccess: '기존 품질 보고서로 승인·등록했습니다.',
    publishUpdated: '기존 품질 보고서를 최신 수정 내용으로 갱신했습니다.',
    publishReplay: '이미 등록된 품질 보고서를 확인했습니다.',
    publishFailed: '품질 보고서 승인·등록에 실패했습니다.',
    publishValidation: '필수값 또는 길이 제한을 확인하세요',
    duplicatePublished: '동일한 Excel 원본 행이 이미 다른 가져오기에서 등록되었습니다.',
    duplicateCandidate: '기존 보고서 중복 의심',
    duplicateConfirmed: '일치 근거가 강한 기존 건',
    duplicateLikely: '표현이 유사한 기존 건',
    duplicateCompare: '기존 보고서와 비교',
    duplicateExisting: '기존 보고서',
    duplicateCurrent: '이번 Excel 행',
    duplicateSourceManual: '웹 수동 등록',
    duplicateSourceExcel: '이전 Excel 등록',
    duplicateDecision: '처리 선택',
    duplicateScore: '일치 점수',
    duplicateLink: '기존 건에 연결',
    duplicateUpdate: '기존 건을 이번 내용으로 보완',
    duplicateSeparate: '별도 발생 건으로 등록',
    duplicateDecisionReason: '판단 사유',
    duplicateDecisionReasonPlaceholder: '예: 같은 생산 건이며 표현만 다름',
    duplicateCandidateChanged: '기존 중복 후보가 변경되었습니다. 다시 확인해 주세요.',
    reasonSameDate: '발생일 동일',
    reasonSamePart: 'Part No. 동일',
    reasonSameModel: '모델 동일',
    reasonSameSection: '공정 동일',
    reasonSameCategory: '불량 유형 동의어 일치',
    reasonVerySimilar: '불량 표현 매우 유사',
    reasonSimilar: '불량 표현 유사',
    reasonRelated: '불량 표현 연관',
    reasonSameQty: '불량 수량 동일',
    reasonSameJudgement: '판정 동일',
    reasonSimilarDisposition: '처리 방식 유사',
    duplicateConfirmInfo: '실제 별도 발생 건이 맞다면 아래 기존 기록을 확인한 뒤 중복 허용 등록을 선택하세요.',
    duplicateReason: '별도 발생 사유',
    duplicateReasonPlaceholder: '예: 다른 생산일에 별도로 발생한 OQC 이슈',
    duplicateReasonRequired: '감사 기록을 위해 3자 이상의 판단 사유를 입력하세요.',
    priorImportRow: '기존 가져오기 행',
    confirmDuplicateAction: '별도 발생 건으로 등록',
    dismissDuplicate: '중복 경고 닫기',
    approvedReport: '등록 보고서',
    saving: '저장 중',
    saved: '검토 상태를 저장했습니다.',
    loadFailed: '가져오기 자료를 불러오지 못했습니다.',
    uploadFailed: 'Excel 파일을 업로드하거나 처리하지 못했습니다.',
    saveFailed: '초안 변경 사항을 저장하지 못했습니다.',
    processing: '처리 중',
    ready: '검토 가능',
    readyWarnings: '확인 필요',
    failed: '처리 실패',
    fileSize: '파일 크기',
    createdAt: '업로드',
    comparisonTitle: '이전 파일 대비 증분 결과',
    comparisonDataset: '데이터 묶음',
    comparisonBaseline: '비교 기준',
    comparisonInitial: '첫 업로드',
    comparisonMultiple: '여러 이전 가져오기 ({count}개)',
    sourceRows: '최신 파일 전체 행',
    comparisonCounts: '신규 {added} · 변경 {changed} · 동일 {unchanged} · 최신 파일에서 미확인 {missing}',
    comparisonScope: '신규·변경 행만 검토 대상이며, 동일 행은 ‘변경 없음’으로 구분되어 수정·발행 대상에서 제외됩니다.',
    missingDisclaimer: '‘최신 파일에서 미확인’은 이전 파일에는 있었지만 이번 파일에서 찾지 못했다는 뜻이며, 삭제를 의미하지 않습니다.',
    mediaCounts: '사진 신규 {added} · 기존 사진 재사용 {reused}',
  },
  zh: {
    title: '导入 Excel 品质资料',
    description: '将品质团队的一份 Excel 文件交由服务器读取，并把行与内嵌图片整理成待审核草稿。',
    sourcePolicy: 'Excel 原文件处理完成后即删除，仅保存按规格规范化后的提取图片。无法自动确认的值不会被猜测填写，而会保留为待审核。',
    noPublish: '导入内容不会自动登记。请先将行标记为审核完成，再单独点击“审批登记为品质报告”按钮，才会生成现有不良报告。',
    drop: '拖入或点击选择 .xlsx 文件',
    scopeTitle: '设置更新期间',
    scopeDescription: '仅导入 Excel 中该期间的不良行及关联图片。日期无法确认的行会保留为单独待审核项目。',
    scopeYesterday: '昨天',
    scopeCustom: '自定义期间',
    scopeFull: '全部期间',
    scopeFullHelp: '用于首次导入或补充历史记录。',
    scopeStart: '开始日期',
    scopeEnd: '结束日期',
    scopeConfirm: '按此期间上传',
    scopeRequired: '请同时选择开始日期和结束日期。',
    scopeInvalid: '开始日期不能晚于结束日期。',
    scopeRangeEmpty: '所选期间内没有品质问题行。',
    scopeApplied: '导入范围',
    scopeFullLabel: '全部期间',
    scopeRowsSummary: '源文件 {source} 行 · 已选 {selected} 行 · 日期待确认 {undated} 行 · 排除 {excluded} 行',
    largeFile: '最大 80MB · 上传后由服务器处理行与图片。',
    uploading: '正在上传',
    accepted: '上传完成。服务器整理行与图片期间，可以关闭页面或继续其他工作。',
    recent: '最近导入',
    recentEmpty: '尚未导入 Excel 文件。',
    refresh: '刷新',
    duplicate: '相同内容的文件已存在，已载入原有结果。',
    invalidFile: '只能选择 .xlsx 格式的 Excel 文件。',
    emptyFile: '无法受理空文件。',
    oversizedFile: 'Excel 文件最大可上传 80MB。',
    permissionDenied: '您没有上传品质资料的权限。',
    authRequired: '登录信息已过期，请重新登录后上传。',
    invalidWorkbook: '请检查 Excel 文件格式和内容后重新上传。',
    retryUpload: '重新上传',
    rows: '提取行数',
    images: '内嵌图片',
    warnings: '待确认',
    sheets: '工作表',
    processingTitle: '服务器处理中',
    processingDesc: '正在整理行与图片。关闭页面后仍会继续处理，重新打开即可查看最新状态。',
    reviewNotice: '自动整理中发现需要确认的项目，请在下方审核列表中核对原始值与图片。',
    readyCompleted: 'Excel 品质资料的图片提取与规范化已完成。',
    failedTitle: '无法处理此文件',
    failedDesc: '请检查文件格式和内容后重新处理，或再次上传原始文件。',
    retry: '重新处理',
    retrying: '正在请求重新处理',
    retrySuccess: '已请求服务器重新处理。',
    retryFailed: '无法开始重新处理，请重新上传源文件。',
    drafts: '规范化草稿',
    draftsDescription: '已保留原工作表与行号。请优先审核带确认事项的行。',
    allSheets: '全部工作表',
    allStatuses: '全部审核状态',
    allDeltas: '全部增量类型',
    draft: '待审核',
    reviewed: '审核完成',
    rejected: '排除',
    published: '已登记报告',
    unchangedReview: '无变更',
    deltaAdded: '新增',
    deltaChanged: '修订',
    deltaUnchanged: '相同',
    loadingRows: '正在载入规范化草稿。',
    emptyRows: '没有符合条件的草稿。',
    source: '来源',
    date: '发生日期',
    modelPart: '型号 / P/N',
    phenomenon: '不良现象',
    quantity: '数量',
    media: '图片',
    status: '审核状态',
    action: '审核',
    unknown: '未确认',
    lot: 'LOT',
    inspection: '检验',
    defect: '不良',
    previous: '上一页',
    next: '下一页',
    page: '页',
    reviewTitle: '审核规范化草稿',
    reviewDescription: '请对照 Excel 原始值与图片，只修正必要字段。保存前不会发生变更。',
    rowWarnings: '本行确认事项',
    sheetRow: '工作表 / 原始行',
    reportDate: '发生日期',
    section: '发生部门·工序',
    occurrenceLocation: '发生位置',
    model: '型号',
    partNo: 'Part No.',
    itemName: '品名',
    lotQty: 'LOT 数量',
    inspectionQty: '检验数量',
    defectQty: '不良数量',
    defectRate: '不良率 (%)',
    judgement: '判定',
    disposition: '处理方式',
    actionResult: '处理结果',
    photos: '关联图片',
    noPhotos: '本行没有关联图片。',
    photoNeedsReview: '图片待确认',
    photoPolicy: 'Excel 关联图片即使超过3张，也会全部保留在导入记录中。审批登记为品质报告时，现有报告仅关联排序在前的3张。',
    raw: '查看 Excel 原始值',
    cancel: '取消',
    saveDraft: '保存为草稿',
    markReviewed: '保存为审核完成',
    markRejected: '保存为排除',
    publishAction: '审批登记为品质报告',
    publishGuide: '仅审核完成且没有未保存修改的行可审批登记。发生日期、部门、型号或P/N、不良现象为必填项。',
    publishSuccess: '已审批登记为现有品质报告。',
    publishUpdated: '已按最新修订内容更新原品质报告。',
    publishReplay: '已确认该品质报告此前已经登记。',
    publishFailed: '品质报告审批登记失败。',
    publishValidation: '请检查必填项或字段长度限制',
    duplicatePublished: '相同的 Excel 原始行已在其他导入批次中登记。',
    duplicateCandidate: '疑似与既有报告重复',
    duplicateConfirmed: '与既有事件高度一致',
    duplicateLikely: '与既有事件表述相似',
    duplicateCompare: '与既有报告对比',
    duplicateExisting: '既有报告',
    duplicateCurrent: '本次 Excel 行',
    duplicateSourceManual: '网页手工登记',
    duplicateSourceExcel: '之前 Excel 登记',
    duplicateDecision: '处理选择',
    duplicateScore: '匹配评分',
    duplicateLink: '关联到既有事件',
    duplicateUpdate: '用本次内容补充既有事件',
    duplicateSeparate: '作为另一次事件登记',
    duplicateDecisionReason: '判断理由',
    duplicateDecisionReasonPlaceholder: '例：属于同一生产事件，仅表述不同',
    duplicateCandidateChanged: '重复候选已发生变化，请重新确认。',
    reasonSameDate: '发生日期相同',
    reasonSamePart: 'Part No. 相同',
    reasonSameModel: '型号相同',
    reasonSameSection: '工序相同',
    reasonSameCategory: '不良类型同义匹配',
    reasonVerySimilar: '不良描述高度相似',
    reasonSimilar: '不良描述相似',
    reasonRelated: '不良描述相关',
    reasonSameQty: '不良数量相同',
    reasonSameJudgement: '判定相同',
    reasonSimilarDisposition: '处理方式相似',
    duplicateConfirmInfo: '如确认是另一次实际发生，请核对下方既有记录后选择允许重复登记。',
    duplicateReason: '另一次发生原因',
    duplicateReasonPlaceholder: '例：不同生产日期另行发生的 OQC 问题',
    duplicateReasonRequired: '为保留审核记录，请输入至少3个字符的判断理由。',
    priorImportRow: '既有导入行',
    confirmDuplicateAction: '作为另一次事件登记',
    dismissDuplicate: '关闭重复提示',
    approvedReport: '登记报告',
    saving: '保存中',
    saved: '审核状态已保存。',
    loadFailed: '无法载入导入资料。',
    uploadFailed: '无法上传或处理 Excel 文件。',
    saveFailed: '无法保存草稿变更。',
    processing: '处理中',
    ready: '可审核',
    readyWarnings: '需要确认',
    failed: '处理失败',
    fileSize: '文件大小',
    createdAt: '上传时间',
    comparisonTitle: '与上次文件的增量结果',
    comparisonDataset: '数据集',
    comparisonBaseline: '比较基准',
    comparisonInitial: '首次上传',
    comparisonMultiple: '多个历史导入（{count}个）',
    sourceRows: '最新文件总行数',
    comparisonCounts: '新增 {added} · 变更 {changed} · 相同 {unchanged} · 最新文件未发现 {missing}',
    comparisonScope: '仅新增与变更行需要审核；相同行标记为“无变更”，不进入修改或发布流程。',
    missingDisclaimer: '“最新文件未发现”表示上次文件中存在、但本次文件中未找到，并不表示删除。',
    mediaCounts: '新增图片 {added} · 复用已有图片 {reused}',
  },
} as const;

type Copy = (typeof copy)[keyof typeof copy];

interface PublishDuplicateConflict {
  originalImportRow: number;
  approvedReport: number;
}

interface ExistingReportDuplicateConflict {
  candidate: QualityImportDuplicateMatch;
  allowedActions: QualityImportDuplicateAction[];
}

type ScopeChoice = 'yesterday' | 'custom' | 'full';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(value: string, lang: 'ko' | 'zh'): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function shanghaiYesterday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const todayUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
  return new Date(todayUtc - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function duplicateReasonLabel(reason: string, c: Copy): string {
  const labels: Record<string, string> = {
    same_date: c.reasonSameDate,
    same_part_no: c.reasonSamePart,
    same_model: c.reasonSameModel,
    same_section: c.reasonSameSection,
    same_defect_category: c.reasonSameCategory,
    very_similar_phenomenon: c.reasonVerySimilar,
    similar_phenomenon: c.reasonSimilar,
    related_phenomenon: c.reasonRelated,
    same_defect_quantity: c.reasonSameQty,
    same_judgement: c.reasonSameJudgement,
    similar_disposition: c.reasonSimilarDisposition,
  };
  return labels[reason] || reason;
}

function duplicateActionLabel(action: QualityImportDuplicateAction, c: Copy): string {
  if (action === 'link_existing') return c.duplicateLink;
  if (action === 'update_existing') return c.duplicateUpdate;
  return c.duplicateSeparate;
}

function replaceScopeCounts(
  template: string,
  scope: NonNullable<QualityImportBatch['delta_summary']['selection_scope']>,
): string {
  return Object.entries({
    source: scope.source_total_rows,
    selected: scope.selected_rows,
    undated: scope.undated_rows,
    excluded: scope.excluded_rows,
  }).reduce(
    (message, [key, value]) => message.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : fallback;
  const payload = error.response?.data as { detail?: string; error?: string; errors?: string[]; file?: string[] } | undefined;
  return payload?.detail || payload?.error || payload?.errors?.join(', ') || payload?.file?.[0] || error.message || fallback;
}

function getUploadErrorMessage(error: unknown, c: Copy): string {
  if (!axios.isAxiosError(error)) return c.uploadFailed;
  const status = error.response?.status;
  const payload = error.response?.data as {
    code?: string;
    error_code?: string;
  } | undefined;
  const code = payload?.code || payload?.error_code || '';

  if (status === 401) return c.authRequired;
  if (status === 403) return c.permissionDenied;
  if (status === 413 || ['file_too_large', 'payload_too_large'].includes(code)) return c.oversizedFile;
  if (['empty_file', 'empty_workbook'].includes(code)) return c.emptyFile;
  if (code === 'no_rows_in_selected_range') return c.scopeRangeEmpty;
  if (
    status === 400
    || ['invalid_file', 'invalid_extension', 'invalid_content_type', 'invalid_workbook', 'invalid_ooxml'].includes(code)
  ) return c.invalidWorkbook;
  return c.uploadFailed;
}

function getPublishErrorMessage(error: unknown, c: Copy): string {
  if (!axios.isAxiosError(error)) return getErrorMessage(error, c.publishFailed);
  const payload = error.response?.data as {
    code?: string;
    error?: string;
    errors?: string[];
    approved_report?: number;
  } | undefined;
  if (payload?.code === 'publish_validation_failed') {
    return `${c.publishValidation}: ${(payload.errors || []).join(', ')}`;
  }
  if (payload?.code === 'duplicate_reason_required') return c.duplicateReasonRequired;
  if (payload?.code === 'duplicate_candidate_changed') return c.duplicateCandidateChanged;
  if (payload?.code === 'possible_duplicate_already_published' || payload?.code === 'duplicate_already_published') {
    return `${c.duplicatePublished}${payload.approved_report ? ` (#${payload.approved_report})` : ''}`;
  }
  return getErrorMessage(error, c.publishFailed);
}

function statusStyle(status: QualityImportBatch['status']): string {
  if (status === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'ready_with_warnings') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (status === 'failed') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-blue-200 bg-blue-50 text-blue-700';
}

function statusLabel(status: QualityImportBatch['status'], c: Copy): string {
  if (status === 'ready') return c.ready;
  if (status === 'ready_with_warnings') return c.readyWarnings;
  if (status === 'failed') return c.failed;
  return c.processing;
}

function replaceCounts(
  template: string,
  values: Record<'added' | 'changed' | 'unchanged' | 'missing' | 'reused', number>,
): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replace(`{${key}}`, value.toLocaleString()),
    template,
  );
}

function isActiveBatchStatus(status: QualityImportBatch['status']): boolean {
  return status === 'queued' || status === 'processing';
}

function reviewStyle(status: QualityImportReviewStatus): string {
  if (status === 'published') return 'bg-blue-50 text-blue-700 ring-blue-200';
  if (status === 'reviewed') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'rejected') return 'bg-slate-100 text-slate-600 ring-slate-200';
  if (status === 'unchanged') return 'bg-slate-50 text-slate-500 ring-slate-200';
  return 'bg-amber-50 text-amber-700 ring-amber-200';
}

function deltaLabel(status: QualityImportRow['delta_status'], c: Copy): string {
  if (status === 'changed') return c.deltaChanged;
  if (status === 'unchanged') return c.deltaUnchanged;
  return c.deltaAdded;
}

function deltaStyle(status: QualityImportRow['delta_status']): string {
  if (status === 'changed') return 'bg-amber-50 text-amber-800 ring-amber-200';
  if (status === 'unchanged') return 'bg-slate-100 text-slate-600 ring-slate-200';
  return 'bg-blue-50 text-blue-700 ring-blue-200';
}

function reviewLabel(status: QualityImportReviewStatus, c: Copy): string {
  if (status === 'published') return c.published;
  if (status === 'reviewed') return c.reviewed;
  if (status === 'rejected') return c.rejected;
  if (status === 'unchanged') return c.unchangedReview;
  return c.draft;
}

function optionalNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function QualityImportMediaImage({
  url,
  alt,
  className,
  unavailableLabel,
  compact = false,
}: {
  url: string | null;
  alt: string;
  className: string;
  unavailableLabel: string;
  compact?: boolean;
}) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setSrc('');
    setFailed(false);
    if (!url) {
      setFailed(true);
      return () => {
        active = false;
      };
    }
    const load = async () => {
      try {
        objectUrl = await getQualityImportMediaObjectUrl(url);
        if (active) setSrc(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    return () => {
      active = false;
      if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (failed || !url) {
    return (
      <div className={`${className} flex items-center justify-center gap-1 bg-amber-50 text-amber-700`} aria-label={unavailableLabel} title={unavailableLabel}>
        <FileWarning className={compact ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden="true" />
        {!compact && <span className="px-1 text-center text-xs font-semibold">{unavailableLabel}</span>}
      </div>
    );
  }
  if (!src) return <div className={`${className} animate-pulse bg-slate-200`} aria-label={alt} />;
  return <img src={src} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />;
}

function QualityImportMediaCell({ media, c }: { media: QualityImportMedia[]; c: Copy }) {
  if (media.length === 0) return <span className="text-xs text-slate-400">-</span>;
  const preview = media.find((item) => Boolean(item.url)) || media[0];
  const unavailableCount = media.filter((item) => !item.url).length;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center">
        <QualityImportMediaImage
          url={preview.url}
          alt=""
          className="h-11 w-14 rounded-lg border border-slate-200 object-cover"
          unavailableLabel={c.photoNeedsReview}
          compact
        />
        {media.length > 1 && <span className="-ml-2 mt-6 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white">+{media.length - 1}</span>}
      </div>
      {unavailableCount > 0 && <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold text-amber-700"><FileWarning className="h-3 w-3" />{c.photoNeedsReview} {unavailableCount}</span>}
    </div>
  );
}

function BatchMetric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Rows3;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
        <Icon className={`h-4 w-4 ${tone}`} aria-hidden="true" />
        {label}
      </div>
      <strong className="mt-2 block text-2xl font-bold tabular-nums text-slate-900">{value.toLocaleString()}</strong>
    </div>
  );
}

function DuplicateComparison({
  candidate,
  row,
  draft,
  c,
}: {
  candidate: QualityImportDuplicateMatch;
  row: QualityImportRow;
  draft: QualityImportRowUpdate;
  c: Copy;
}) {
  const existing = candidate.report;
  const quantity = (lot: number | null | undefined, inspection: number | null | undefined, defect: number | null | undefined) => (
    `${c.lot} ${lot ?? '-'} · ${c.inspection} ${inspection ?? '-'} · ${c.defect} ${defect ?? '-'}`
  );
  const cards: Array<{
    title: string;
    fields: Array<[string, string | number | null | undefined]>;
    images: Array<{ key: string; url: string | null; alt: string }>;
  }> = [
    {
      title: c.duplicateExisting,
      fields: [
        [c.reportDate, existing.report_date],
        [c.section, existing.section],
        [c.modelPart, [existing.model, existing.part_no].filter(Boolean).join(' / ')],
        [c.quantity, quantity(existing.lot_qty, existing.inspection_qty, existing.defect_qty)],
        [c.defectRate, existing.defect_rate],
        [c.judgement, existing.judgement],
        [c.phenomenon, existing.phenomenon],
        [c.disposition, existing.disposition],
        [c.actionResult, existing.action_result],
      ],
      images: existing.images.map((url, index) => ({
        key: `existing-${index}-${url}`,
        url,
        alt: `${c.duplicateExisting} ${index + 1}`,
      })),
    },
    {
      title: c.duplicateCurrent,
      fields: [
        [c.reportDate, String(draft.report_date || '').slice(0, 10)],
        [c.section, draft.section],
        [c.modelPart, [draft.model, draft.part_no].filter(Boolean).join(' / ')],
        [c.quantity, quantity(draft.lot_qty, draft.inspection_qty, draft.defect_qty)],
        [c.defectRate, draft.defect_rate],
        [c.judgement, draft.judgement],
        [c.phenomenon, draft.phenomenon],
        [c.disposition, draft.disposition],
        [c.actionResult, draft.action_result],
      ],
      images: row.media.map((item) => ({
        key: `current-${item.id}`,
        url: item.url,
        alt: item.filename || `${c.duplicateCurrent} ${item.id}`,
      })),
    },
  ];

  return (
    <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50/70 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-amber-950">
            <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
            {c.duplicateCandidate}
          </h3>
          <p className="mt-1 text-xs leading-5 text-amber-800">
            {candidate.level === 'confirmed' ? c.duplicateConfirmed : c.duplicateLikely}
            {' · '}{candidate.source_kind === 'manual' ? c.duplicateSourceManual : c.duplicateSourceExcel}
            {' · '}#{candidate.report_id}
          </p>
        </div>
        <span className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs font-bold tabular-nums text-amber-900">
          {c.duplicateScore} {Math.round(candidate.score)}/100
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {candidate.reasons.map((reason) => (
          <span key={reason} className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">
            {duplicateReasonLabel(reason, c)}
          </span>
        ))}
      </div>

      <h4 className="mt-5 text-sm font-bold text-slate-900">{c.duplicateCompare}</h4>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        {cards.map((card) => (
          <article key={card.title} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h5 className="border-b border-slate-100 pb-2 text-sm font-bold text-slate-900">{card.title}</h5>
            <dl className="mt-3 space-y-2 text-xs">
              {card.fields.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                  <dt className="font-semibold text-slate-500">{label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-slate-800">{value === null || value === undefined || value === '' ? c.unknown : String(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 border-t border-slate-100 pt-3">
              <span className="text-xs font-semibold text-slate-500">{c.photos}</span>
              {card.images.length > 0 ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {card.images.map((image) => (
                    <QualityImportMediaImage
                      key={image.key}
                      url={image.url}
                      alt={image.alt}
                      className="aspect-square w-full rounded-lg border border-slate-200 object-cover"
                      unavailableLabel={c.photoNeedsReview}
                      compact
                    />
                  ))}
                </div>
              ) : <span className="mt-2 block text-xs text-slate-400">{c.noPhotos}</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function QualityImportReviewModal({
  row,
  c,
  onClose,
  onSaved,
}: {
  row: QualityImportRow;
  c: Copy;
  onClose: () => void;
  onSaved: (row: QualityImportRow) => void;
}) {
  const initialDraft: QualityImportRowUpdate = {
    report_date: row.report_date,
    section: row.section || '',
    occurrence_location: row.occurrence_location || '',
    model: row.model || '',
    part_no: row.part_no || '',
    item_name: row.item_name || '',
    lot_qty: row.lot_qty,
    inspection_qty: row.inspection_qty,
    defect_qty: row.defect_qty,
    defect_rate: row.defect_rate,
    judgement: row.judgement || '',
    phenomenon: row.phenomenon || '',
    disposition: row.disposition || '',
    action_result: row.action_result || '',
  };
  const [draft, setDraft] = useState<QualityImportRowUpdate>(initialDraft);
  const [saving, setSaving] = useState<QualityImportEditableReviewStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [duplicateConflict, setDuplicateConflict] = useState<PublishDuplicateConflict | null>(null);
  const [existingReportConflict, setExistingReportConflict] = useState<ExistingReportDuplicateConflict | null>(() => (
    row.duplicate_match
      ? { candidate: row.duplicate_match, allowedActions: row.duplicate_match.allowed_actions }
      : null
  ));
  const [duplicateReason, setDuplicateReason] = useState('');
  const isReadOnly = row.review_status === 'published' || row.review_status === 'unchanged';
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);

  const setField = <K extends keyof QualityImportRowUpdate>(key: K, value: QualityImportRowUpdate[K]) => {
    setDuplicateConflict(null);
    setExistingReportConflict(null);
    setDuplicateReason('');
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async (reviewStatus: QualityImportEditableReviewStatus) => {
    setSaving(reviewStatus);
    try {
      const updated = await updateQualityImportRow(row.id, {
        ...draft,
        review_status: reviewStatus,
      });
      toast.success(c.saved);
      onSaved(updated);
    } catch (error) {
      toast.error(getErrorMessage(error, c.saveFailed));
    } finally {
      setSaving(null);
    }
  };

  const publish = async (options: {
    confirmDuplicate?: boolean;
    duplicateAction?: QualityImportDuplicateAction;
    duplicateReportId?: number;
    duplicateReportVersion?: string;
  } = {}) => {
    setPublishing(true);
    try {
      const published = await publishQualityImportRow(row.id, {
        ...options,
        duplicateReason: options.confirmDuplicate || options.duplicateAction ? duplicateReason : undefined,
      });
      toast.success(
        published.idempotent_replay
          ? c.publishReplay
          : published.updated_existing_report
            ? c.publishUpdated
            : c.publishSuccess,
      );
      setDuplicateConflict(null);
      setExistingReportConflict(null);
      onSaved(published);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const payload = error.response?.data as {
          code?: string;
          original_import_row?: number;
          approved_report?: number;
          candidate?: QualityImportDuplicateMatch;
          allowed_actions?: QualityImportDuplicateAction[];
        } | undefined;
        if (['possible_existing_report_duplicate', 'duplicate_candidate_changed'].includes(payload?.code || '')) {
          setExistingReportConflict(payload?.candidate
            ? {
                candidate: payload.candidate,
                allowedActions: payload.allowed_actions || payload.candidate.allowed_actions,
              }
            : null);
          setDuplicateConflict(null);
          setDuplicateReason('');
          if (payload?.code === 'duplicate_candidate_changed') toast.warning(c.duplicateCandidateChanged);
          return;
        }
        if (
          !options.confirmDuplicate
          && !options.duplicateAction
          && (payload?.code === 'possible_duplicate_already_published' || payload?.code === 'duplicate_already_published')
          && payload.original_import_row
          && payload.approved_report
        ) {
          setDuplicateConflict({
            originalImportRow: payload.original_import_row,
            approvedReport: payload.approved_report,
          });
          setExistingReportConflict(null);
          setDuplicateReason('');
          return;
        }
      }
      toast.error(getPublishErrorMessage(error, c));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm md:p-6" role="dialog" aria-modal="true" aria-labelledby="quality-import-review-title">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 md:px-7">
          <div>
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-blue-600">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              {row.sheet_name} · #{row.source_row_number}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset ${deltaStyle(row.delta_status)}`}>
                {deltaLabel(row.delta_status, c)}
              </span>
            </div>
            <h2 id="quality-import-review-title" className="text-xl font-bold text-slate-950">{c.reviewTitle}</h2>
            <p className="mt-1 text-sm text-slate-600">{c.reviewDescription}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label={c.cancel}>
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-5 md:px-7">
          {row.warnings.length > 0 && (
            <section className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-2 font-semibold text-amber-900">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {c.rowWarnings}
              </h3>
              <p className="mt-2 text-sm leading-5 text-amber-800">{c.reviewNotice}</p>
            </section>
          )}

          <fieldset disabled={isReadOnly} className={isReadOnly ? 'opacity-75' : ''}>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-medium text-slate-700">
              {c.reportDate}
              <input type="date" value={String(draft.report_date || '').slice(0, 10)} onChange={(event) => setField('report_date', event.target.value || null)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.section}
              <select value={draft.section || ''} onChange={(event) => setField('section', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                <option value="">{c.unknown}</option>
                <option value="LQC_INJ">LQC · INJECTION</option>
                <option value="LQC_ASM">LQC · ASSEMBLY</option>
                <option value="IQC">IQC</option>
                <option value="OQC">OQC</option>
                <option value="CS">CS</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.occurrenceLocation}
              <input value={draft.occurrence_location || ''} onChange={(event) => setField('occurrence_location', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.model}
              <input value={draft.model || ''} onChange={(event) => setField('model', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.partNo}
              <input value={draft.part_no || ''} onChange={(event) => setField('part_no', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700 lg:col-span-2">
              {c.itemName}
              <input value={draft.item_name || ''} onChange={(event) => setField('item_name', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.lotQty}
              <input type="number" min="0" value={draft.lot_qty ?? ''} onChange={(event) => setField('lot_qty', optionalNumber(event.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.inspectionQty}
              <input type="number" min="0" value={draft.inspection_qty ?? ''} onChange={(event) => setField('inspection_qty', optionalNumber(event.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.defectQty}
              <input type="number" min="0" value={draft.defect_qty ?? ''} onChange={(event) => setField('defect_qty', optionalNumber(event.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.defectRate}
              <input value={draft.defect_rate || ''} onChange={(event) => setField('defect_rate', event.target.value)} placeholder="1.2%" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-slate-700">
              {c.judgement}
              <input value={draft.judgement || ''} onChange={(event) => setField('judgement', event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700 md:row-span-2">
              {c.phenomenon}
              <textarea rows={5} value={draft.phenomenon || ''} onChange={(event) => setField('phenomenon', event.target.value)} className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700">
              {c.disposition}
              <textarea rows={3} value={draft.disposition || ''} onChange={(event) => setField('disposition', event.target.value)} className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="text-sm font-medium text-slate-700 md:col-span-2">
              {c.actionResult}
              <textarea rows={3} value={draft.action_result || ''} onChange={(event) => setField('action_result', event.target.value)} className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
            </label>
          </div>
          </fieldset>

          <section className="mt-6">
            <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
              <Images className="h-4 w-4 text-blue-600" aria-hidden="true" />
              {c.photos} <span className="text-sm font-medium text-slate-500">{row.media.length}</span>
            </h3>
            <p className="mb-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">{c.photoPolicy}</p>
            {row.media.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {row.media.map((item) => {
                  const unavailable = !item.url;
                  return (
                    <div key={item.id} className={`group overflow-hidden rounded-xl border bg-slate-50 ${unavailable ? 'border-amber-300' : 'border-slate-200'}`}>
                      <QualityImportMediaImage
                        url={item.url}
                        alt={item.filename || `${row.sheet_name} #${row.source_row_number}`}
                        className="aspect-[4/3] w-full object-cover transition-transform group-hover:scale-[1.03]"
                        unavailableLabel={c.photoNeedsReview}
                      />
                      <div className="px-2 py-2 text-xs text-slate-600">
                        <span className="block truncate">{item.filename || item.source_anchor || `#${item.id}`}</span>
                        {unavailable ? (
                          <span className="mt-1 inline-flex items-center gap-1 font-semibold text-amber-700"><FileWarning className="h-3 w-3" />{c.photoNeedsReview}</span>
                        ) : (
                          <span className="mt-1 block truncate text-[11px] text-slate-400">{formatBytes(item.byte_size)}{item.content_type ? ` · ${item.content_type}` : ''}</span>
                        )}
                        {item.warnings.length > 0 && !unavailable && <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700"><FileWarning className="h-3 w-3" />{c.photoNeedsReview}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-500">{c.noPhotos}</p>}
          </section>

          {existingReportConflict && (
            <>
              <DuplicateComparison
                candidate={existingReportConflict.candidate}
                row={row}
                draft={draft}
                c={c}
              />
              {!isReadOnly && (
                <section className="mt-3 rounded-xl border border-amber-300 bg-white p-4">
                  <h3 className="text-sm font-bold text-slate-900">{c.duplicateDecision}</h3>
                  <label className="mt-3 block text-xs font-semibold text-slate-700">
                    {c.duplicateDecisionReason}
                    <input
                      value={duplicateReason}
                      onChange={(event) => setDuplicateReason(event.target.value)}
                      maxLength={255}
                      placeholder={c.duplicateDecisionReasonPlaceholder}
                      className="mt-1 block w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                    />
                    {duplicateReason.trim().length < 3 && <span className="mt-1 block font-normal text-amber-700">{c.duplicateReasonRequired}</span>}
                  </label>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {existingReportConflict.allowedActions.map((action) => (
                      <PermissionButton
                        key={action}
                        permission="can_edit_quality"
                        disabled={publishing || saving !== null || row.review_status !== 'reviewed' || isDirty || duplicateReason.trim().length < 3}
                        onClick={() => publish({
                          duplicateAction: action,
                          duplicateReportId: existingReportConflict.candidate.report_id,
                          duplicateReportVersion: existingReportConflict.candidate.version,
                        })}
                        className={`min-h-11 justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white ${action === 'separate' ? 'bg-amber-600 hover:bg-amber-700' : action === 'update_existing' ? 'bg-violet-700 hover:bg-violet-800' : 'bg-blue-700 hover:bg-blue-800'}`}
                      >
                        {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        {duplicateActionLabel(action, c)}
                      </PermissionButton>
                    ))}
                  </div>
                  {row.review_status !== 'reviewed' && <p className="mt-2 text-xs leading-5 text-slate-500">{c.publishGuide}</p>}
                </section>
              )}
            </>
          )}

          <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <summary className="cursor-pointer font-semibold text-slate-700">{c.raw}</summary>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-4 text-xs text-slate-100">{JSON.stringify(row.raw_data, null, 2)}</pre>
          </details>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 md:px-7">
          {duplicateConflict && (
            <div className="mb-2 flex basis-full flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <strong className="block">{c.duplicatePublished}</strong>
                <span className="mt-0.5 block text-xs leading-5 text-amber-800">{c.duplicateConfirmInfo} · {c.priorImportRow} #{duplicateConflict.originalImportRow} · {c.approvedReport} #{duplicateConflict.approvedReport}</span>
              </div>
              <label className="basis-full text-xs font-semibold text-amber-900">
                {c.duplicateReason}
                <input value={duplicateReason} onChange={(event) => setDuplicateReason(event.target.value)} maxLength={255} placeholder={c.duplicateReasonPlaceholder} className="mt-1 block w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100" />
                {duplicateReason.trim().length < 3 && <span className="mt-1 block font-normal text-amber-700">{c.duplicateReasonRequired}</span>}
              </label>
              <button type="button" onClick={() => setDuplicateConflict(null)} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100">{c.dismissDuplicate}</button>
              <PermissionButton permission="can_edit_quality" disabled={publishing || isDirty || duplicateReason.trim().length < 3} onClick={() => publish({ confirmDuplicate: true })} className="gap-2 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700">
                {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {c.confirmDuplicateAction}
              </PermissionButton>
            </div>
          )}
          <div className="mr-auto max-w-lg text-xs leading-5 text-slate-500">
            {row.approved_report ? <strong className="text-blue-700">{c.approvedReport} #{row.approved_report}</strong> : c.publishGuide}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">{c.cancel}</button>
          {!isReadOnly && <PermissionButton permission="can_edit_quality" disabled={saving !== null || publishing} onClick={() => save('rejected')} className="gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
            {saving === 'rejected' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            {c.markRejected}
          </PermissionButton>}
          {!isReadOnly && <PermissionButton permission="can_edit_quality" disabled={saving !== null || publishing} onClick={() => save('draft')} className="gap-2 rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
            {saving === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {c.saveDraft}
          </PermissionButton>}
          {!isReadOnly && <PermissionButton permission="can_edit_quality" disabled={saving !== null || publishing} onClick={() => save('reviewed')} className="gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            {saving === 'reviewed' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {c.markReviewed}
          </PermissionButton>}
          {!isReadOnly && !duplicateConflict && !existingReportConflict && <PermissionButton permission="can_edit_quality" disabled={saving !== null || publishing || row.review_status !== 'reviewed' || isDirty} onClick={() => publish()} className="gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
            {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {c.publishAction}
          </PermissionButton>}
        </footer>
      </div>
    </div>
  );
}

export default function QualityExcelImport() {
  const { lang } = useLang();
  const { user, hasPermission } = useAuth();
  const c = copy[lang === 'zh' ? 'zh' : 'ko'];
  const canUpload = Boolean(user?.is_staff || hasPermission('can_edit_quality'));
  const pendingNotificationStorageKey = `${PENDING_NOTIFICATION_STORAGE_KEY_PREFIX}:${user?.id ?? 'anonymous'}`;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scopeYesterdayDate, setScopeYesterdayDate] = useState(shanghaiYesterday);
  const [file, setFile] = useState<File | null>(null);
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>('yesterday');
  const [scopeRangeStart, setScopeRangeStart] = useState(scopeYesterdayDate);
  const [scopeRangeEnd, setScopeRangeEnd] = useState(scopeYesterdayDate);
  const [scopeValidationError, setScopeValidationError] = useState<string | null>(null);
  const [lastUploadScope, setLastUploadScope] = useState<QualityImportScopeRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryingBatchId, setRetryingBatchId] = useState<number | null>(null);
  const [uploadState, setUploadState] = useState<QualityImportClientUploadProgress | null>(null);
  const [batches, setBatches] = useState<QualityImportBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(true);
  const [selectedBatch, setSelectedBatch] = useState<QualityImportBatch | null>(null);
  const [rows, setRows] = useState<QualityImportRow[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [sheetName, setSheetName] = useState('');
  const [reviewStatus, setReviewStatus] = useState<QualityImportReviewStatus | ''>('draft');
  const [deltaStatus, setDeltaStatus] = useState<QualityImportDeltaStatus | ''>('');
  const [page, setPage] = useState(1);
  const [editingRow, setEditingRow] = useState<QualityImportRow | null>(null);
  const notifiedReadyRef = useRef(new Set<number>());
  const pendingNotificationIdsRef = useRef(loadPendingNotificationIds(pendingNotificationStorageKey));

  useEffect(() => {
    pendingNotificationIdsRef.current = loadPendingNotificationIds(pendingNotificationStorageKey);
    notifiedReadyRef.current.clear();
  }, [pendingNotificationStorageKey]);

  const rememberPendingNotification = useCallback((batchId: number) => {
    pendingNotificationIdsRef.current.add(batchId);
    persistPendingNotificationIds(pendingNotificationStorageKey, pendingNotificationIdsRef.current);
  }, [pendingNotificationStorageKey]);

  const forgetPendingNotification = useCallback((batchId: number) => {
    pendingNotificationIdsRef.current.delete(batchId);
    persistPendingNotificationIds(pendingNotificationStorageKey, pendingNotificationIdsRef.current);
  }, [pendingNotificationStorageKey]);

  const loadBatches = useCallback(async (preferredId?: number) => {
    setBatchesLoading(true);
    try {
      const result = await listQualityImportBatches();
      const listedIds = new Set(result.results.map((item) => item.id));
      const pendingIds = [...pendingNotificationIdsRef.current].filter((id) => !listedIds.has(id));
      const pendingResults = await Promise.allSettled(pendingIds.map((id) => getQualityImportBatch(id)));
      const recovered = pendingResults.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
      const merged = [...recovered, ...result.results];
      setBatches(merged);
      setSelectedBatch((current) => {
        const targetId = preferredId ?? current?.id;
        return merged.find((item) => item.id === targetId) || merged[0] || null;
      });
    } catch (error) {
      toast.error(getErrorMessage(error, c.loadFailed));
    } finally {
      setBatchesLoading(false);
    }
  }, [c.loadFailed]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    setPage(1);
    setSheetName('');
    setReviewStatus('draft');
    setDeltaStatus('');
  }, [selectedBatch?.id]);

  const notifyBatchReady = useCallback((batch: QualityImportBatch) => {
    if (notifiedReadyRef.current.has(batch.id)) return;
    notifiedReadyRef.current.add(batch.id);
    forgetPendingNotification(batch.id);
    toast.success(c.readyCompleted);
  }, [c.readyCompleted, forgetPendingNotification]);

  useEffect(() => {
    if (batchesLoading || pendingNotificationIdsRef.current.size === 0) return;
    for (const batch of batches) {
      if (!pendingNotificationIdsRef.current.has(batch.id)) continue;
      if (batch.status === 'ready' || batch.status === 'ready_with_warnings') {
        notifyBatchReady(batch);
      } else if (batch.status === 'failed') {
        forgetPendingNotification(batch.id);
        toast.error(`${c.failedTitle}: ${batch.original_filename}`);
      }
    }
  }, [batches, batchesLoading, c.failedTitle, forgetPendingNotification, notifyBatchReady]);

  const activeBatchKey = useMemo(
    () => batches
      .filter((batch) => (
        (batch.status === 'queued' || batch.status === 'processing')
        && (batch.id === selectedBatch?.id || pendingNotificationIdsRef.current.has(batch.id))
      ))
      .map((batch) => batch.id)
      .sort((left, right) => left - right)
      .join(','),
    [batches, selectedBatch?.id],
  );

  useEffect(() => {
    if (!activeBatchKey) return;
    const batchIds = activeBatchKey.split(',').map(Number).filter(Number.isFinite);
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const results = await Promise.allSettled(batchIds.map((batchId) => getQualityImportBatch(batchId)));
      if (cancelled) return;
      const refreshedBatches = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const refreshedById = new Map(refreshedBatches.map((batch) => [batch.id, batch]));
      for (const refreshed of refreshedBatches) {
        if (refreshed.status === 'ready' || refreshed.status === 'ready_with_warnings') {
          notifyBatchReady(refreshed);
        }
      }
      if (refreshedById.size > 0) {
        setBatches((current) => current.map((batch) => refreshedById.get(batch.id) || batch));
        setSelectedBatch((current) => current ? refreshedById.get(current.id) || current : current);
      }
      const shouldContinue = results.some((result) => result.status === 'rejected')
        || refreshedBatches.some((batch) => isActiveBatchStatus(batch.status));
      if (!cancelled && shouldContinue) timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeBatchKey, notifyBatchReady]);

  const loadRows = useCallback(async () => {
    if (!selectedBatch || !['ready', 'ready_with_warnings'].includes(selectedBatch.status)) {
      setRows([]);
      setRowCount(0);
      return;
    }
    setRowsLoading(true);
    try {
      const result = await listQualityImportRows(selectedBatch.id, {
        page,
        pageSize: PAGE_SIZE,
        sheetName,
        reviewStatus,
        deltaStatus,
      });
      setRows(result.results);
      setRowCount(result.count);
    } catch (error) {
      toast.error(getErrorMessage(error, c.loadFailed));
    } finally {
      setRowsLoading(false);
    }
  }, [c.loadFailed, deltaStatus, page, reviewStatus, selectedBatch, sheetName]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const totalPages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const selectedFilename = file?.name || '';

  const upload = async (candidate: File, scope: QualityImportScopeRequest) => {
    setFile(candidate);
    setScopeDialogOpen(false);
    setLastUploadScope(scope);
    setUploading(true);
    setUploadError(null);
    setUploadState(null);
    try {
      const result = await uploadQualityImportBatch(candidate, scope, setUploadState);
      setSelectedBatch(result.batch);
      setBatches((current) => {
        const existingIndex = current.findIndex((item) => item.id === result.batch.id);
        if (existingIndex < 0) return [result.batch, ...current];
        return current.map((item) => item.id === result.batch.id ? result.batch : item);
      });
      if (result.alreadyAccepted) toast.info(c.duplicate);
      else toast.success(c.accepted);
      if (isActiveBatchStatus(result.batch.status)) rememberPendingNotification(result.batch.id);
      else if (result.batch.status === 'ready' || result.batch.status === 'ready_with_warnings') {
        notifyBatchReady(result.batch);
      }
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadBatches(result.batch.id);
    } catch (error) {
      const message = getUploadErrorMessage(error, c);
      setUploadError(message);
      toast.error(message);
      void loadBatches();
    } finally {
      setUploading(false);
      setUploadState(null);
    }
  };

  const selectFile = (candidate: File | null) => {
    if (!candidate) return;
    if (!canUpload) {
      toast.error(c.permissionDenied);
      return;
    }
    if (!candidate.name.toLowerCase().endsWith('.xlsx')) {
      toast.warning(c.invalidFile);
      return;
    }
    if (candidate.size <= 0) {
      toast.warning(c.emptyFile);
      return;
    }
    if (candidate.size > QUALITY_IMPORT_MAX_FILE_BYTES) {
      toast.warning(c.oversizedFile);
      return;
    }
    const defaultDate = shanghaiYesterday();
    setFile(candidate);
    setUploadError(null);
    setScopeChoice('yesterday');
    setScopeYesterdayDate(defaultDate);
    setScopeRangeStart(defaultDate);
    setScopeRangeEnd(defaultDate);
    setScopeValidationError(null);
    setScopeDialogOpen(true);
  };

  const cancelScopeSelection = () => {
    setScopeDialogOpen(false);
    setScopeValidationError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confirmScopeSelection = () => {
    if (!file) return;
    if (scopeChoice === 'full') {
      void upload(file, { mode: 'full' });
      return;
    }
    const rangeStart = scopeChoice === 'yesterday' ? scopeYesterdayDate : scopeRangeStart;
    const rangeEnd = scopeChoice === 'yesterday' ? scopeYesterdayDate : scopeRangeEnd;
    if (!rangeStart || !rangeEnd) {
      setScopeValidationError(c.scopeRequired);
      return;
    }
    if (rangeStart > rangeEnd) {
      setScopeValidationError(c.scopeInvalid);
      return;
    }
    setScopeValidationError(null);
    void upload(file, { mode: 'date_range', rangeStart, rangeEnd });
  };

  const retryBatch = async (batchId: number) => {
    setRetryingBatchId(batchId);
    try {
      const batch = await retryQualityImportBatch(batchId);
      if (isActiveBatchStatus(batch.status)) rememberPendingNotification(batch.id);
      setSelectedBatch(batch);
      setBatches((current) => current.map((item) => item.id === batch.id ? batch : item));
      toast.success(c.retrySuccess);
    } catch (error) {
      toast.error(getErrorMessage(error, c.retryFailed));
    } finally {
      setRetryingBatchId(null);
    }
  };

  const summaryMetrics = useMemo(() => selectedBatch ? [
    { icon: Rows3, label: c.rows, value: selectedBatch.total_rows, tone: 'text-blue-600' },
    { icon: Images, label: c.images, value: selectedBatch.total_media, tone: 'text-violet-600' },
    { icon: AlertTriangle, label: c.warnings, value: selectedBatch.warning_count, tone: 'text-amber-600' },
    { icon: Layers3, label: c.sheets, value: selectedBatch.sheet_names.length, tone: 'text-cyan-600' },
  ] : [], [c, selectedBatch]);
  const deltaCounts = selectedBatch ? replaceCounts(c.comparisonCounts, {
    added: selectedBatch.added_count || 0,
    changed: selectedBatch.changed_count || 0,
    unchanged: selectedBatch.unchanged_count || 0,
    missing: selectedBatch.missing_count || 0,
    reused: selectedBatch.reused_media_count || 0,
  }) : '';
  const mediaDeltaCounts = selectedBatch ? replaceCounts(c.mediaCounts, {
    added: selectedBatch.new_media_count || 0,
    changed: selectedBatch.changed_count || 0,
    unchanged: selectedBatch.unchanged_count || 0,
    missing: selectedBatch.missing_count || 0,
    reused: selectedBatch.reused_media_count || 0,
  }) : '';
  const selectionScope = selectedBatch?.delta_summary?.selection_scope;
  const baselineBatchIds = selectedBatch?.delta_summary?.baseline_batch_ids || [];
  const comparisonBaselineLabel = baselineBatchIds.length > 1
    ? c.comparisonMultiple.replace('{count}', baselineBatchIds.length.toLocaleString())
    : selectedBatch?.baseline_batch
      ? `#${selectedBatch.baseline_batch}`
      : baselineBatchIds.length === 1
        ? `#${baselineBatchIds[0]}`
        : c.comparisonInitial;

  const updateVisibleRow = (updated: QualityImportRow) => {
    setRows((current) => current.map((row) => row.id === updated.id ? updated : row));
    setEditingRow(null);
    void loadRows();
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-white via-blue-50/50 to-cyan-50/70 shadow-sm">
        <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="p-5 md:p-7">
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-blue-600 p-2.5 text-white shadow-sm"><FileSpreadsheet className="h-6 w-6" /></span>
              <div>
                <h2 className="text-xl font-bold text-slate-950">{c.title}</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{c.description}</p>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              disabled={uploading}
              onChange={(event) => {
                const candidate = event.currentTarget.files?.[0] || null;
                event.currentTarget.value = '';
                selectFile(candidate);
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => {
                if (!canUpload) {
                  toast.error(c.permissionDenied);
                  return;
                }
                fileInputRef.current?.click();
              }}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0] || null); }}
              className={`mt-5 flex w-full items-center gap-4 rounded-xl border-2 border-dashed px-5 py-5 text-left transition disabled:cursor-wait disabled:opacity-70 ${dragging ? 'border-blue-500 bg-blue-100/70' : 'border-blue-200 bg-white/80 hover:border-blue-400 hover:bg-white'}`}
            >
              <span className="rounded-full bg-blue-50 p-3 text-blue-600"><UploadCloud className="h-6 w-6" /></span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm text-slate-900">{selectedFilename || c.drop}</strong>
                <span className="mt-1 block text-xs text-slate-500">{file ? `${formatBytes(file.size)} · ${c.largeFile}` : c.largeFile}</span>
              </span>
            </button>

            {uploading && (
              <div className="mt-4" role="status">
                <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs font-semibold text-blue-700">
                  <span>{c.uploading}</span>
                  <span className="tabular-nums">
                    {formatBytes(uploadState?.uploadedBytes || 0)} / {formatBytes(uploadState?.totalBytes || file?.size || 0)} · {uploadState?.percent || 0}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${uploadState?.percent || 0}%` }} /></div>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex max-w-2xl items-start gap-2 text-xs leading-5 text-slate-500">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                <p>{c.sourcePolicy}</p>
              </div>
            </div>

            {uploadError && file && !uploading && (
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
                <XCircle className="h-5 w-5 shrink-0 text-rose-600" />
                <span className="min-w-0 flex-1">{uploadError}</span>
                <PermissionButton permission="can_edit_quality" disabled={!lastUploadScope} onClick={() => lastUploadScope && upload(file, lastUploadScope)} className="gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100">
                  <RefreshCw className="h-4 w-4" />{c.retryUpload}
                </PermissionButton>
              </div>
            )}
          </div>

          <div className="border-t border-blue-100 bg-white/75 p-5 lg:border-l lg:border-t-0 md:p-7">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900">{c.recent}</h3>
              <button type="button" onClick={() => loadBatches()} disabled={batchesLoading} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${batchesLoading ? 'animate-spin' : ''}`} />{c.refresh}
              </button>
            </div>
            <div className="mt-3 max-h-60 space-y-2 overflow-y-auto pr-1">
              {batchesLoading && batches.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-sm text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{c.loadingRows}</div>
              ) : batches.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{c.recentEmpty}</p>
              ) : batches.map((batch) => (
                  <button key={batch.id} type="button" onClick={() => setSelectedBatch(batch)} className={`w-full rounded-xl border p-3 text-left transition ${selectedBatch?.id === batch.id ? 'border-blue-300 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-blue-200'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{batch.original_filename}</span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusStyle(batch.status)}`}>{statusLabel(batch.status, c)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span>{formatDateTime(batch.created_at, lang === 'zh' ? 'zh' : 'ko')}</span>
                      <span>{formatBytes(batch.file_size)}</span>
                      <span>{batch.total_rows.toLocaleString()} {c.rows}</span>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
        <FileWarning className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{c.noPublish}</span>
      </div>

      {selectedBatch && (
        <section className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 shadow-sm md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-950">{selectedBatch.original_filename}</h2>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusStyle(selectedBatch.status)}`}>{statusLabel(selectedBatch.status, c)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>{c.createdAt}: {formatDateTime(selectedBatch.created_at, lang === 'zh' ? 'zh' : 'ko')}</span>
                  <span>{c.fileSize}: {formatBytes(selectedBatch.file_size)}</span>
                </div>
              </div>
              <button type="button" onClick={() => loadBatches(selectedBatch.id)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
                <RefreshCw className="h-4 w-4" />{c.refresh}
              </button>
            </div>

            {selectionScope && (
              <div className="mt-4 flex flex-col gap-2 rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-3 text-sm text-blue-950 sm:flex-row sm:items-start">
                <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
                <div className="min-w-0">
                  <strong className="block">
                    {c.scopeApplied}: {selectionScope.mode === 'full'
                      ? c.scopeFullLabel
                      : `${selectionScope.range_start || c.unknown} ~ ${selectionScope.range_end || c.unknown}`}
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-blue-800">{replaceScopeCounts(c.scopeRowsSummary, selectionScope)}</span>
                </div>
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {summaryMetrics.map((metric) => <BatchMetric key={metric.label} {...metric} />)}
            </div>

            {['ready', 'ready_with_warnings'].includes(selectedBatch.status) && (
              <div className="mt-5 rounded-xl border border-cyan-200 bg-gradient-to-r from-blue-50 to-cyan-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <strong className="text-sm text-slate-900">{c.comparisonTitle}</strong>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-blue-800">{deltaCounts}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    <span className="rounded-full border border-white bg-white/80 px-2.5 py-1">{c.comparisonDataset}: {selectedBatch.dataset_key || '-'}</span>
                    <span className="rounded-full border border-white bg-white/80 px-2.5 py-1">{c.comparisonBaseline}: {comparisonBaselineLabel}</span>
                    <span className="rounded-full border border-white bg-white/80 px-2.5 py-1">{c.sourceRows}: {(selectedBatch.source_total_rows || 0).toLocaleString()}</span>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 border-t border-cyan-100 pt-3 text-xs leading-5 text-slate-600 md:grid-cols-2">
                  <p><CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-600" />{c.comparisonScope}</p>
                  <p><Images className="mr-1 inline h-3.5 w-3.5 text-violet-600" />{mediaDeltaCounts}</p>
                  <p className="md:col-span-2"><AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-slate-500" />{c.missingDisclaimer}</p>
                </div>
              </div>
            )}

            {isActiveBatchStatus(selectedBatch.status) && (
              <div className="mt-5 flex items-start gap-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-900">
                <Loader2 className="h-7 w-7 shrink-0 animate-spin text-blue-600" />
                <div className="min-w-0 flex-1">
                  <strong className="block">{c.processingTitle}</strong>
                  <span className="mt-1 block text-sm text-blue-700">{c.processingDesc}</span>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100" aria-hidden="true">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-600" />
                  </div>
                </div>
              </div>
            )}

            {selectedBatch.status === 'failed' && (
              <div className="mt-5 flex flex-wrap items-start gap-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900">
                <XCircle className="h-7 w-7 shrink-0 text-rose-600" />
                <div className="min-w-0 flex-1"><strong className="block">{c.failedTitle}</strong><span className="mt-1 block text-sm text-rose-700">{c.failedDesc}</span></div>
                <PermissionButton
                  permission="can_edit_quality"
                  disabled={retryingBatchId === selectedBatch.id}
                  onClick={() => retryBatch(selectedBatch.id)}
                  className="gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100"
                >
                  {retryingBatchId === selectedBatch.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {retryingBatchId === selectedBatch.id ? c.retrying : c.retry}
                </PermissionButton>
              </div>
            )}

            {selectedBatch.status === 'ready_with_warnings' && (
              <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <span>{c.reviewNotice}</span>
              </div>
            )}
          </div>

          {['ready', 'ready_with_warnings'].includes(selectedBatch.status) && (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 px-5 py-4 md:px-6">
                <div>
                  <h2 className="text-lg font-bold text-slate-950">{c.drafts}</h2>
                  <p className="mt-1 text-sm text-slate-500">{c.draftsDescription}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <select value={sheetName} onChange={(event) => { setSheetName(event.target.value); setPage(1); }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-500">
                    <option value="">{c.allSheets}</option>
                    {selectedBatch.sheet_names.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                  </select>
                  <select value={reviewStatus} onChange={(event) => { setReviewStatus(event.target.value as QualityImportReviewStatus | ''); setPage(1); }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-500">
                    <option value="">{c.allStatuses}</option>
                    <option value="draft">{c.draft}</option>
                    <option value="reviewed">{c.reviewed}</option>
                    <option value="rejected">{c.rejected}</option>
                    <option value="unchanged">{c.unchangedReview}</option>
                    <option value="published">{c.published}</option>
                  </select>
                  <select value={deltaStatus} onChange={(event) => { setDeltaStatus(event.target.value as QualityImportDeltaStatus | ''); setPage(1); }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-500">
                    <option value="">{c.allDeltas}</option>
                    <option value="added">{c.deltaAdded}</option>
                    <option value="changed">{c.deltaChanged}</option>
                    <option value="unchanged">{c.deltaUnchanged}</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[1080px] w-full border-collapse text-left">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">{c.source}</th>
                      <th className="px-4 py-3">{c.date}</th>
                      <th className="px-4 py-3">{c.modelPart}</th>
                      <th className="px-4 py-3">{c.phenomenon}</th>
                      <th className="px-4 py-3">{c.quantity}</th>
                      <th className="px-4 py-3">{c.media}</th>
                      <th className="px-4 py-3">{c.status}</th>
                      <th className="px-4 py-3 text-right">{c.action}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rowsLoading ? (
                      <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-slate-500"><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600" />{c.loadingRows}</td></tr>
                    ) : rows.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-slate-500">{c.emptyRows}</td></tr>
                    ) : rows.map((row) => (
                      <tr key={row.id} className={`align-top hover:bg-blue-50/30 ${row.warnings.length > 0 ? 'bg-amber-50/30' : ''}`}>
                        <td className="whitespace-nowrap px-4 py-3 text-sm"><div className="flex items-center gap-1.5"><strong className="text-slate-800">{row.sheet_name}</strong><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ring-inset ${deltaStyle(row.delta_status)}`}>{deltaLabel(row.delta_status, c)}</span></div><span className="text-xs text-slate-500">#{row.source_row_number}{row.source_sequence ? ` · No.${row.source_sequence}` : ''}{row.occurrence_location ? ` · ${row.occurrence_location}` : ''}</span></td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">{row.report_date || <span className="text-amber-700">{c.unknown}</span>}</td>
                        <td className="max-w-52 px-4 py-3 text-sm"><strong className="block truncate text-slate-900">{row.model || c.unknown}</strong><span className="block truncate font-mono text-xs text-blue-700">{row.part_no || c.unknown}</span>{row.item_name && <span className="mt-0.5 block truncate text-xs text-slate-500">{row.item_name}</span>}</td>
                        <td className="max-w-sm px-4 py-3 text-sm text-slate-700">
                          <p className="line-clamp-2 leading-5">{row.phenomenon || c.unknown}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {row.duplicate_match && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 ring-1 ring-inset ring-amber-200"
                                title={row.duplicate_match.reasons.map((reason) => duplicateReasonLabel(reason, c)).join(', ')}
                              >
                                <AlertTriangle className="h-3 w-3" />{c.duplicateCandidate} #{row.duplicate_match.report_id}
                              </span>
                            )}
                            {row.warnings.length > 0 && <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700"><AlertTriangle className="h-3 w-3" />{row.warnings.length}</span>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs leading-5 text-slate-600"><span className="block">{c.lot} {row.lot_qty ?? '-'}</span><span className="block">{c.inspection} {row.inspection_qty ?? '-'}</span><span className="block font-semibold text-rose-700">{c.defect} {row.defect_qty ?? '-'}</span></td>
                        <td className="px-4 py-3">
                          <QualityImportMediaCell media={row.media} c={c} />
                        </td>
                        <td className="px-4 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${reviewStyle(row.review_status)}`}>{reviewLabel(row.review_status, c)}</span></td>
                        <td className="px-4 py-3 text-right"><button type="button" onClick={() => setEditingRow(row)} className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"><Eye className="h-3.5 w-3.5" />{c.action}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
                <button type="button" disabled={page <= 1 || rowsLoading} onClick={() => setPage((current) => Math.max(1, current - 1))} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40"><ChevronLeft className="h-4 w-4" />{c.previous}</button>
                <span className="text-sm font-medium tabular-nums text-slate-600">{c.page} {page} / {totalPages} · {rowCount.toLocaleString()}</span>
                <button type="button" disabled={page >= totalPages || rowsLoading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40">{c.next}<ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </section>
      )}

      {scopeDialogOpen && file && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm md:p-6" role="dialog" aria-modal="true" aria-labelledby="quality-import-scope-title">
          <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 md:px-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-blue-700">
                  <CalendarDays className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <h2 id="quality-import-scope-title" className="text-lg font-bold text-slate-950">{c.scopeTitle}</h2>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{c.scopeDescription}</p>
                <p className="mt-1 truncate text-xs font-semibold text-slate-500">{file.name} · {formatBytes(file.size)}</p>
              </div>
              <button type="button" onClick={cancelScopeSelection} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label={c.cancel}>
                <X className="h-5 w-5" />
              </button>
            </header>

            <div className="space-y-3 px-5 py-5 md:px-6">
              <button
                type="button"
                onClick={() => { setScopeChoice('yesterday'); setScopeValidationError(null); }}
                className={`w-full rounded-xl border p-4 text-left transition ${scopeChoice === 'yesterday' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 bg-white hover:border-blue-200'}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <strong className="text-sm text-slate-900">{c.scopeYesterday}</strong>
                  <span className="font-mono text-xs font-semibold text-blue-700">{scopeYesterdayDate}</span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setScopeChoice('custom'); setScopeValidationError(null); }}
                className={`w-full rounded-xl border p-4 text-left transition ${scopeChoice === 'custom' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 bg-white hover:border-blue-200'}`}
              >
                <strong className="text-sm text-slate-900">{c.scopeCustom}</strong>
              </button>
              {scopeChoice === 'custom' && (
                <div className="grid gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-4 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-slate-700">
                    {c.scopeStart}
                    <input type="date" value={scopeRangeStart} onChange={(event) => { setScopeRangeStart(event.target.value); setScopeValidationError(null); }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
                  </label>
                  <label className="text-xs font-semibold text-slate-700">
                    {c.scopeEnd}
                    <input type="date" value={scopeRangeEnd} onChange={(event) => { setScopeRangeEnd(event.target.value); setScopeValidationError(null); }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
                  </label>
                </div>
              )}

              <button
                type="button"
                onClick={() => { setScopeChoice('full'); setScopeValidationError(null); }}
                className={`w-full rounded-xl border p-4 text-left transition ${scopeChoice === 'full' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 bg-white hover:border-blue-200'}`}
              >
                <strong className="block text-sm text-slate-900">{c.scopeFull}</strong>
                <span className="mt-1 block text-xs leading-5 text-slate-500">{c.scopeFullHelp}</span>
              </button>

              {scopeValidationError && (
                <p className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700" role="alert">
                  <XCircle className="h-4 w-4 shrink-0" />{scopeValidationError}
                </p>
              )}
            </div>

            <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 md:px-6">
              <button type="button" onClick={cancelScopeSelection} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">{c.cancel}</button>
              <PermissionButton permission="can_edit_quality" onClick={confirmScopeSelection} className="gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
                <UploadCloud className="h-4 w-4" />{c.scopeConfirm}
              </PermissionButton>
            </footer>
          </div>
        </div>
      )}

      {editingRow && <QualityImportReviewModal row={editingRow} c={c} onClose={() => setEditingRow(null)} onSaved={updateVisibleRow} />}
    </div>
  );
}
