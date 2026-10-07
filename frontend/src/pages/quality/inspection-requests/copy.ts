import type { InspectionDataMode, InspectionRequest } from './model';
import { integrationTrialCopy } from './integrationTrial.ts';

export const inspectionCopy = {
  ko: {
    title: '검사관리', description: '요청 선택 → 항목 입력 → 결과 저장',
    currentInspector: '현재 검사자', switchInspector: '검사자 전환', inspectorSwitching: '로그아웃 확인 중…',
    inspectorPending: '진행 중인 요청의 응답을 기다린 뒤 검사자를 전환하세요.',
    inspectorDraftConfirm: '임시 초안은 현재 검사자에게만 표시되며 서버 저장은 아닙니다. 브라우저의 임시 보관이 지원되면 다시 로그인한 뒤 직접 복구할 수 있습니다. 로그아웃하고 검사자를 전환할까요?',
    inspectorSwitchFailed: '로그아웃을 확인하지 못했습니다. 현재 검사자를 유지합니다. 다시 시도하세요.',
    inspectorSessionChanged: '로그인 계정이 변경되었습니다. 이 화면에서는 더 이상 입력하거나 요청을 전송할 수 없습니다.',
    checkingAccess: '검사요청 접근 권한을 확인하고 있습니다.', assignedRequests: '내게 배정된 검사요청', assignedHint: '현재 검사자에게 배정된 요청을 선택해 검사 결과를 입력하세요.',
    returnToList: '목록으로', returnToKanban: '칸반으로', allRequests: '전체 요청 검색·목록',
    localNotice: 'WJ 검사요청', localHint: '저장·제출·검수는 WJ에 반영됩니다. MES 반영 상태는 카드에서 확인하고, 결과 저장과 검사 완료를 각각 실행하세요.',
    previewNotice: '합성 미리보기 · 시험 데이터 · MES 미연결', previewHint: '생산계획과 검사요청 모두 합성 시험 데이터입니다. 실제 생산계획·검사 기록이나 운영 자료가 아닙니다.',
    dataPendingNotice: '베타 · 데이터 출처 확인 중 · MES 미연결', dataPendingHint: '데이터 출처를 확인하고 있습니다. 확인 전에는 실제 생산계획이나 검사 기록으로 해석하지 마세요.',
    plansSource: 'WJ 생산계획', requestsSource: 'WJ 수동입력', previewPlansSource: '합성 생산계획', previewRequestsSource: '합성 검사요청', sourcePending: '출처 확인 중', dataSource: '데이터 출처', plans: '생산계획',
    search: '작업번호, 품번, 설비 검색', filter: '진행상태', all: '전체', requests: '검사요청', requestUnit: '건', refreshList: '목록 새로고침',
    guideTitle: '작업 중단·재개와 검사 확인', guideStop: 'MES 정상 중단·재개 절차를 따르세요.', guideResume: '재개 시 추가 초도 검사 필요조건은 현장 품질정책 확인이 필요합니다.', guidePending: '미처리 요청·반려·불합격·승인 중 상태를 확인하고 임의 합격·취소를 하지 마세요.',
    workGroups: '작업별 WJ 요청 요약', workGroupHint: '현재 조회조건의 WJ 수동 원장입니다. MES 검사요청 목록·중복 발생 원인·입고 차단 여부는 별도 확인이 필요합니다. 재검 전 원검사도 이력으로 보존됩니다.', openRequests: 'MES 완료 전·미확인', groupRequests: '조회 요청', groupTruncated: '최근 작업 30개까지만 요약했습니다. 검색 조건을 좁혀 확인하세요.', groupOpen: '이 작업 요청 검색', groupReasons: '확인할 상태',
    loading: '검사요청을 불러오는 중입니다.', loadError: '검사요청을 불러오지 못했습니다.', retry: '다시 시도', empty: '조건에 맞는 검사요청이 없습니다.', select: '칸반 또는 목록에서 검사요청을 선택하세요.',
    previous: '이전', next: '다음', create: '수동 검사요청 등록', createHint: 'MES 요청과 연결되지 않는 WJ Reporting 수동 요청입니다. 확인한 작업 정보와 검사 기준을 입력해 주세요.',
    requestId: '요청', workOrder: '작업지시 · 工单', task: '작업', part: '품번', equipment: '설비', inspectionType: '검사 유형', quantity: '요청 수량',
    uom: '단위 · UOM', warehouse: '입고 창고', lot: '로트', workStarted: '작업 시작', owner: '담당', unassigned: '미지정', source: '요청 출처', local: 'WJ 수동입력', parent: '원검사 요청',
    createdAt: '요청 시간', updatedAt: '최근 저장', submittedAt: '제출 시간', reviewedAt: '검수 시간', mesChecked: 'MES 확인 시간', timezone: '상하이 시간 · UTC+8',
    version: '버전', immutable: '작업 정보와 검사 기준은 등록 후 고정됩니다. 변경이 필요한 경우 근거를 확인하고 새 요청을 등록하세요.',
    items: '검사 항목과 결과', addItem: '검사 항목 추가', itemName: '검사 항목명', kind: '값 유형', text: '관찰·문자', number: '수치', choice: '선택값', options: '선택값 목록 · 쉼표로 구분', optionsHint: '서로 다른 선택값 2~20개를 입력하세요.', itemUnit: '측정 단위', minimum: '최솟값', maximum: '최댓값', optional: '선택',
    criteriaUnit: '기준·단위', fullValue: '값 전체 보기', attachments: '증빙', requiredEvidenceHint: '필수 증빙 있음', handlingHistory: '처리 이력', diagnosticDetails: '진단 상세', historyTime: '시간', historyActor: '처리자', historyAction: '동작', historyResult: '결과', historyOtherAction: '처리', historyUnknownResult: '미확인', historyCreated: '요청·기록 시각', historyCompleted: '처리 완료 시각',
    judgementPolicy: '전체 판정 기준', strictItems: '모든 항목 판정과 일치', independentJudgement: '독립 전체판정', strictHint: '전체 판정은 입력한 항목 판정과 일치해야 합니다.', independentHint: '전체 판정은 항목 판정과 별도로 입력합니다. 수동 요청의 로컬 기준이며 실제 MES 승인·예외 규칙은 별도 확인이 필요합니다.',
    evidenceRequired: '항목 증빙 필수', measurementRequired: '측정·관찰 값 필수', commonEvidenceRequired: '공통 증빙 필수', quantityPolicy: '검사 수량 기록 기준', quantityRecorded: '검사·합격·불합격 수량 기록', quantityNotRecorded: '수량 미기록', quantityNotRecordedHint: '이 요청은 검사 수량을 기록하지 않습니다. 표시된 0은 미기록 저장값이며 실제 검사·합격·불합격 수량을 뜻하지 않습니다.', measurement: '측정·관찰 값', judgement: '판정', choose: '선택하세요', pass: '합격', fail: '불합격',
    itemEvidence: '항목 증빙 HTTPS 링크', evidenceHint: '사진·문서의 HTTPS 주소만 입력하세요. 계정정보, 쿼리 또는 # 조각이 포함된 링크는 저장할 수 없습니다.',
    unsafeEvidence: '증빙 주소를 확인해 주세요. HTTPS이며 계정정보·쿼리·# 조각이 없어야 합니다.', evidence: '공통 증빙', evidenceName: '증빙 설명', evidenceUrl: '증빙 HTTPS 주소', addEvidence: '증빙 추가', openEvidence: '증빙 열기', remove: '삭제',
    results: '검사 수량과 최종 판정', inspected: '검사 수량', accepted: '합격 수량', rejected: '불합격 수량', quantityHint: '검사 수량 = 합격 수량 + 불합격 수량. 서버가 요청 수량·단위·로트와 함께 검증합니다.', notes: '검사 메모',
    save: '초안 저장', submit: '검사 결과 제출', saved: '초안 저장 완료.', submitted: '제출 완료 · 검수 대기.', submittedFail: '불합격 결과 저장. 조치 후 재검을 요청하세요.',
    dirty: '저장하지 않은 입력이 있습니다.', saveFirst: '검사 결과를 제출하려면 먼저 초안을 저장하세요.', readOnly: '현재 상태 또는 권한으로 검사 결과를 편집할 수 없습니다.',
    navigationLocked: '진행 중이거나 결과 확인이 필요한 요청이 있습니다. 결과를 확인한 뒤 다른 요청으로 이동하세요.',
    routeLeaveTitle: '다른 화면으로 이동할까요?', routeLockedTitle: '요청 결과를 먼저 확인하세요', routeDirtyHint: '서버에 저장하지 않은 입력이 있습니다. 이동하면 이 계정·탭의 임시 복구본으로 남으며, 돌아왔을 때 직접 복구할 수 있습니다.', routeLeaveHint: '요청 처리가 확인되었습니다. 다른 화면으로 이동할 수 있습니다.', routeStay: '현재 화면에 머무르기', routeLeave: '이동하기',
    reconciliationRequired: 'MES 결과 미확정 · 입력·전송 보류. 상태 재조회 후 계속하세요. 조회가 안 되면 관리자에게 확인하세요.',
    review: '검수', independent: '검수자는 검사 결과 제출자와 달라야 합니다.', reason: '처리 사유', reasonHint: '검수·반려·재검의 근거를 입력하세요.', approve: '검수 승인', reject: '반려', reinspect: '재검 요청 생성',
    approved: '검수 완료 · MES 완료 상태를 확인하세요.', rejectedMessage: '검사 결과를 반려했습니다.', reinspected: '재검 요청 생성 완료. 원검사 이력은 보존됩니다.',
    reasonRequired: '처리 사유를 입력해 주세요.', reviewReason: '최근 검수 사유',
    mes: 'MES 검사 완료 상태', syncStatus: '검사 결과 동기화', mesCompletion: 'MES 검사 완료', mesTaskStatus: 'MES 작업 상태 코드', mesQcStatus: 'MES 품질 판정', mesTrialVerdict: 'MES 시험 판정', receiptReadiness: '사출 입고 선행조건', externalResult: 'MES 결과 ID', errorCode: '최근 오류 코드',
    refreshMes: 'MES 상태 재조회', mesSave: 'MES 검사값 저장', mesFinish: 'QC 검사 완료', mesStored: 'MES 저장 확인 완료.', mesFinished: 'MES 검사 완료 확인.', mesFinishConfirm: '이 QC 검사요청을 완료할까요? 생산 작업지시 종료나 입고 처리는 요청하지 않습니다.', mesStageHint: '검사값 저장과 QC 검사 완료는 별도 요청입니다. 저장값·시험표기를 재조회로 확인한 뒤 완료할 수 있습니다.', mesTestLabel: '원천 시험표기', sync: 'MES 결과 동기화',
    receiptHint: '입고는 별도 사출 업무이며 실제 입고 조건은 미확인입니다. 공정검사(巡检)가 대기 중이라는 이유만으로 입고 차단을 판단하지 않습니다. WJ 저장·검수, MES 항목 저장·검사 종료·판정·승인은 각각 확인하세요.',
    previousObservation: '이전 관측', currentReconciliation: '현재 대조 필요', observedAt: '관측 시각', previousObservationHint: '아래는 이전 관측값입니다. 현재 완료·합격·입고 가능이 확인된 상태가 아닙니다.',
    synced: '서버의 MES 동기화 상태를 갱신했습니다.', refreshed: '서버의 외부 상태 조회 결과를 갱신했습니다.',
    mesApprovalPending: 'MES 승인 대기 · 최종 완료 미확인.',
    mesStageUnverified: '응답과 최신 재조회 상태가 일치하지 않습니다. MES 상태를 다시 조회해 저장·완료 결과를 확인하세요.',
    busy: '처리 중…', failure: '처리하지 못했습니다. 입력 내용은 유지됩니다.', stateRefreshFailure: '서버에서 처리를 확인했지만 최신 상태를 다시 불러오지 못했습니다. 다음 작업 전에 서버 최신 내용을 불러와 확인하세요.', conflict: '서버에 다른 변경이 저장되었습니다. 입력 초안은 유지됩니다. 최신 상태를 확인한 뒤 입력을 다시 대조해 주세요.',
    reload: '서버 최신 내용 불러오기', discard: '작성 중인 입력을 버리고 서버 최신 내용을 불러올까요?', network: '응답을 확인하지 못했습니다. 요청 결과가 불확정입니다. 같은 요청을 재시도하면 동일한 요청 키와 본문을 사용합니다.', retryOperation: '동일 요청 결과 확인·재시도', externalUnknown: 'MES 처리 결과가 미확정입니다. 서버의 상태를 확인하고 MES 상태 재조회로 대조해야 합니다.',
    mesReconnectRequired: 'MES 연결이 필요해 이번 작업은 전송되지 않았습니다. 연결을 마친 뒤 검사 화면에서 같은 작업 버튼을 다시 눌러 주세요. 입력 내용은 유지됩니다.',
    recovery: '이 탭에 저장하지 않은 입력이 있습니다.', recoveryHint: '이 계정의 임시 복구본입니다. 복구해도 서버에는 저장하지 않으며 원래 버전으로 충돌을 확인합니다.', restore: '입력 복구', discardRecovery: '임시 복구본 삭제',
    recoveryPending: '응답이 확인되지 않은 요청이 있습니다. 먼저 동일 요청 결과를 확인해 주세요.', history: '감사 이력', noHistory: '기록된 감사 이력이 없습니다.',
    operations: '동기화·처리 기록', noOperations: '기록된 처리 내역이 없습니다.', cancel: '취소', createSuccess: 'WJ Reporting 수동 검사요청을 등록했습니다.',
    denied: '검사요청을 조회할 권한이 없습니다.', templateRequired: '이름이 있는 검사 항목을 1개 이상 입력하세요.', startedInvalid: '유효한 작업 시작 시간을 입력하세요.', required: '필수', requiredWhenFilled: '값 입력 시 필수',
  },
  zh: {
    title: '检验管理', description: '选择申请 → 填写项目 → 保存结果',
    currentInspector: '当前检验员', switchInspector: '切换检验员', inspectorSwitching: '正在确认退出…',
    inspectorPending: '请等待正在处理的请求返回后再切换检验员。',
    inspectorDraftConfirm: '临时草稿仅对当前检验员显示，并未保存至服务器。浏览器支持临时存储时，重新登录后可手动恢复。是否退出并切换检验员？',
    inspectorSwitchFailed: '未能确认退出，当前检验员保持不变。请重试。',
    inspectorSessionChanged: '登录账号已更改，此页面已停止输入及发送请求。',
    checkingAccess: '正在确认检验申请访问权限。', assignedRequests: '分配给我的检验申请', assignedHint: '选择分配给当前检验员的申请并填写检验结果。',
    returnToList: '返回列表', returnToKanban: '返回看板', allRequests: '全部申请搜索·列表',
    localNotice: 'WJ 检验申请', localHint: '保存、提交与审核记录在 WJ。请在卡片中确认 MES 状态，分别执行结果保存与检验完成。',
    previewNotice: '合成预览 · 测试数据 · MES 未连接', previewHint: '生产计划与检验申请均为合成测试数据，不代表实际生产计划、检验记录或运营数据。',
    dataPendingNotice: 'Beta · 正在确认数据来源 · MES 未连接', dataPendingHint: '正在确认数据来源。确认前请勿将其视为实际生产计划或检验记录。',
    plansSource: 'WJ 生产计划', requestsSource: 'WJ 手工输入', previewPlansSource: '合成生产计划', previewRequestsSource: '合成检验申请', sourcePending: '来源待确认', dataSource: '数据来源', plans: '生产计划',
    search: '搜索工单、料号、设备', filter: '进度状态', all: '全部', requests: '检验申请', requestUnit: '项', refreshList: '刷新列表',
    guideTitle: '作业暂停·恢复与检验确认', guideStop: '请遵循 MES 正常暂停与恢复流程。', guideResume: '恢复时是否需要再次首检，需确认现场品质政策。', guidePending: '请确认未处理申请、退回、不合格及审批中状态，不得自行判合格或取消申请。',
    workGroups: '按作业汇总 WJ 申请', workGroupHint: '此为当前筛选条件下的 WJ 手工台账。MES 申请列表、重复原因与入库阻止情况需另行确认。复检前的原检验保留为历史记录。', openRequests: 'MES 未完成·未确认', groupRequests: '查询申请', groupTruncated: '仅汇总最近 30 个作业，请缩小搜索范围确认。', groupOpen: '搜索此作业申请', groupReasons: '需确认的状态',
    loading: '正在加载检验申请。', loadError: '无法加载检验申请。', retry: '重试', empty: '没有符合条件的检验申请。', select: '请从看板或列表选择检验申请。',
    previous: '上一页', next: '下一页', create: '登记手工检验申请', createHint: '此申请是 WJ Reporting 手工记录，尚未关联 MES 申请。请填写已确认的作业信息与检验标准。',
    requestId: '申请', workOrder: '工单', task: '作业', part: '料号', equipment: '设备', inspectionType: '检验类型', quantity: '申请数量',
    uom: '单位 · UOM', warehouse: '入库仓库', lot: '批次', workStarted: '开工时间', owner: '负责人', unassigned: '未指定', source: '申请来源', local: 'WJ 手工输入', parent: '原检验申请',
    createdAt: '申请时间', updatedAt: '最近保存', submittedAt: '提交时间', reviewedAt: '审核时间', mesChecked: 'MES 确认时间', timezone: '上海时间 · UTC+8',
    version: '版本', immutable: '登记后作业信息与检验标准固定。需要更改时，请确认依据后创建新申请。',
    items: '检验项目与结果', addItem: '添加检验项目', itemName: '检验项目名称', kind: '值类型', text: '观察·文字', number: '数值', choice: '选择值', options: '选项列表 · 用逗号分隔', optionsHint: '请输入 2–20 个不同选项。', itemUnit: '测量单位', minimum: '最小值', maximum: '最大值', optional: '选填',
    criteriaUnit: '标准·单位', fullValue: '查看完整值', attachments: '依据', requiredEvidenceHint: '有必填依据', handlingHistory: '处理记录', diagnosticDetails: '诊断详情', historyTime: '时间', historyActor: '处理人', historyAction: '操作', historyResult: '结果', historyOtherAction: '处理', historyUnknownResult: '待确认', historyCreated: '请求·记录时间', historyCompleted: '处理完成时间',
    judgementPolicy: '整体判定规则', strictItems: '与所有项目判定一致', independentJudgement: '独立整体判定', strictHint: '整体判定必须与已填写的项目判定一致。', independentHint: '整体判定与项目判定分别填写。此为手工申请的本地规则，实际 MES 审批与例外规则需另行确认。',
    evidenceRequired: '项目依据必填', measurementRequired: '测量·观察值必填', commonEvidenceRequired: '公共依据必填', quantityPolicy: '检验数量记录规则', quantityRecorded: '记录检验·合格·不合格数量', quantityNotRecorded: '不记录数量', quantityNotRecordedHint: '此申请不记录检验数量。显示的 0 是未记录的存储值，不代表实际检验、合格或不合格数量。', measurement: '测量·观察值', judgement: '判定', choose: '请选择', pass: '合格', fail: '不合格',
    itemEvidence: '项目依据 HTTPS 链接', evidenceHint: '仅填写照片、文档的 HTTPS 地址。不得包含账号信息、查询参数或 # 片段。',
    unsafeEvidence: '请检查依据地址：必须为 HTTPS，且不含账号信息、查询参数或 # 片段。', evidence: '公共依据', evidenceName: '依据说明', evidenceUrl: '依据 HTTPS 地址', addEvidence: '添加依据', openEvidence: '打开依据', remove: '删除',
    results: '检验数量与最终判定', inspected: '检验数量', accepted: '合格数量', rejected: '不合格数量', quantityHint: '检验数量 = 合格数量 + 不合格数量。服务器结合申请数量、单位与批次进行验证。', notes: '检验备注',
    save: '保存草稿', submit: '提交检验结果', saved: '草稿已保存。', submitted: '已提交 · 待审核。', submittedFail: '不合格结果已保存，处置后请申请复检。',
    dirty: '有尚未保存的输入。', saveFirst: '请先保存草稿，再提交检验结果。', readOnly: '当前状态或权限不允许编辑检验结果。',
    navigationLocked: '有正在处理或结果待确认的请求。请确认结果后再切换申请。',
    routeLeaveTitle: '是否切换到其他页面？', routeLockedTitle: '请先确认请求结果', routeDirtyHint: '有尚未保存至服务器的输入。切换后将保留为此账号、此标签页的临时恢复记录，返回时可手动恢复。', routeLeaveHint: '请求处理已确认，可以切换到其他页面。', routeStay: '留在当前页面', routeLeave: '切换页面',
    reconciliationRequired: 'MES 结果未确认 · 暂缓填写及发送。请重新查询后继续；无法查询时请联系管理员。',
    review: '审核', independent: '审核人与检验结果提交人必须不同。', reason: '处理原因', reasonHint: '填写审核、退回或复检的依据。', approve: '审核通过', reject: '退回', reinspect: '创建复检申请',
    approved: '审核完成 · 请确认 MES 完成状态。', rejectedMessage: '检验结果已退回。', reinspected: '复检申请已创建，原检验记录保留。',
    reasonRequired: '请填写处理原因。', reviewReason: '最近审核原因',
    mes: 'MES 检验完成状态', syncStatus: '检验结果同步', mesCompletion: 'MES 检验完成', mesTaskStatus: 'MES 作业状态代码', mesQcStatus: 'MES 品质判定', mesTrialVerdict: 'MES 测试判定', receiptReadiness: '注塑入库前置条件', externalResult: 'MES 结果 ID', errorCode: '最近错误代码',
    refreshMes: '重新查询 MES 状态', mesSave: '保存 MES 检验值', mesFinish: '完成 QC 检验', mesStored: 'MES 保存已确认。', mesFinished: 'MES 检验完成已确认。', mesFinishConfirm: '完成此 QC 检验申请？此操作不请求关闭生产工单或入库。', mesStageHint: '保存检验值与完成 QC 检验是独立请求。重新查询并核对保存值和测试标记后才能完成。', mesTestLabel: '源系统测试标记', sync: '同步 MES 检验结果',
    receiptHint: '入库属于独立的注塑业务，实际入库条件尚未确认。不得仅因巡检待处理而判断入库被阻止。WJ 保存、审核与 MES 项目保存、检验结束、判定、审批需分别确认。',
    previousObservation: '此前观测', currentReconciliation: '当前需核对', observedAt: '观测时间', previousObservationHint: '以下保留的是此前观测值，当前是否完成、合格或可入库尚未确认。',
    synced: '已更新服务器的 MES 同步状态。', refreshed: '已更新服务器的外部状态查询结果。',
    mesApprovalPending: 'MES 待审批 · 最终完成未确认。',
    mesStageUnverified: '响应与最新查询状态不一致。请重新查询 MES，核对保存及完成结果。',
    busy: '处理中…', failure: '处理失败，已保留输入。', stateRefreshFailure: '服务器已确认处理，但未能重新加载最新状态。进行下一步前，请加载服务器最新内容进行确认。', conflict: '服务器上已有其他修改。输入草稿已保留，请确认最新状态后重新核对输入。',
    reload: '加载服务器最新内容', discard: '放弃当前输入并加载服务器最新内容？', network: '尚未确认响应，请求结果不确定。重试将使用相同的请求键与正文。', retryOperation: '确认结果·重试同一请求', externalUnknown: 'MES 处理结果未确认，请检查服务器状态并重新查询 MES 状态进行核对。',
    mesReconnectRequired: '需要连接 MES，本次操作尚未发送。完成连接后，请返回检验页面再次点击相同操作按钮。已保留输入内容。',
    recovery: '此标签页有未保存的输入。', recoveryHint: '此为当前账号的临时恢复记录。恢复不代表保存至服务器，仍使用原版本检测冲突。', restore: '恢复输入', discardRecovery: '删除恢复记录',
    recoveryPending: '有响应未确认的请求，请先确认同一请求的结果。', history: '审计记录', noHistory: '暂无审计记录。',
    operations: '同步·处理记录', noOperations: '暂无处理记录。', cancel: '取消', createSuccess: '已登记 WJ Reporting 手工检验申请。',
    denied: '没有查看检验申请的权限。', templateRequired: '请填写至少一个有名称的检验项目。', startedInvalid: '请填写有效的开工时间。', required: '必填', requiredWhenFilled: '填写值时必填',
  },
};

export function inspectionDataSourceCopy(lang: 'ko' | 'zh', mode?: InspectionDataMode) {
  const text = inspectionCopy[lang];
  if (mode === 'wj_local_beta') return { notice: text.localNotice, hint: text.localHint, plans: text.plansSource, requests: text.requestsSource };
  if (mode === 'synthetic_preview') return { notice: text.previewNotice, hint: text.previewHint, plans: text.previewPlansSource, requests: text.previewRequestsSource };
  return { notice: text.dataPendingNotice, hint: text.dataPendingHint, plans: text.sourcePending, requests: text.sourcePending };
}

export const inspectionStatusLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { draft: '초안', submitted: '검수 대기', approved: '검수 완료', rejected: '반려', failed: '실패', not_synced: '미동기화', blocked: '보류', pending: '처리 중', succeeded: 'MES 동기화 확인', unknown: '결과 미확정', stale: '재조회 필요' },
  zh: { draft: '草稿', submitted: '待审核', approved: '审核完成', rejected: '已退回', failed: '失败', not_synced: '未同步', blocked: '暂缓', pending: '处理中', succeeded: 'MES 同步已确认', unknown: '结果未确认', stale: '需重新查询' },
};
export const inspectionTypeLabels = { ko: { general: '연동시험', first: '초도 검사 · 首检', process: '공정 검사', final: '최종 검사' }, zh: { general: '接口测试', first: '首检', process: '过程检验', final: '最终检验' } };
export const inspectionRequestStatusLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { draft: '초안', submitted: '검수 대기', approved: '검수 완료', rejected: '반려', failed: '불합격 판정' },
  zh: { draft: '草稿', submitted: '待审核', approved: '审核完成', rejected: '已退回', failed: '不合格判定' },
};
export const mesCompletionLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { not_completed: '완료 전', pending: '처리 중', completed: 'MES 검사 완료', approval_pending: 'MES 승인 대기', cancelled: 'MES 취소', rejected: 'MES 반려', blocked: '완료 처리 보류', unknown: '완료 결과 미확정' },
  zh: { not_completed: '尚未完成', pending: '处理中', completed: 'MES 检验完成', approval_pending: 'MES 待审批', cancelled: 'MES 已取消', rejected: 'MES 已驳回', blocked: '完成处理暂缓', unknown: '完成结果未确认' },
};
export const injectionReadinessLabels = { ko: { not_verified: '미확인', ready: '선행조건 충족', blocked: '차단' }, zh: { not_verified: '未确认', ready: '前置条件已满足', blocked: '已阻止' } };
export const mesQcLabels: Record<'ko' | 'zh', Record<number, string>> = { ko: { 1: '합격 · 合格', 2: '특채 합격 · 让步合格', 3: '검사 대기 · 待检', 4: '불합격 · 不合格' }, zh: { 1: '合格', 2: '让步合格', 3: '待检', 4: '不合格' } };
export const inspectionOperationLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { pending: '처리 중', succeeded: '처리 완료', failed: '처리 실패', blocked: '처리 보류', unknown: '처리 결과 미확정' },
  zh: { pending: '处理中', succeeded: '处理完成', failed: '处理失败', blocked: '处理暂缓', unknown: '处理结果未确认' },
};
export const inspectionBlockingReasonLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { draft_not_submitted: '초안 미제출', awaiting_local_review: 'WJ 검수 대기', local_inspection_failed: 'WJ 불합격 판정', local_review_rejected: 'WJ 검수 반려', mes_approval_pending: 'MES 승인 대기', mes_completion_unverified: 'MES 검사 완료 미확인' },
  zh: { draft_not_submitted: '草稿未提交', awaiting_local_review: 'WJ 待审核', local_inspection_failed: 'WJ 不合格判定', local_review_rejected: 'WJ 审核退回', mes_approval_pending: 'MES 待审批', mes_completion_unverified: 'MES 检验完成未确认' },
};
export const inspectionActionLabels: Record<'ko' | 'zh', Record<string, string>> = {
  ko: { create: '요청 등록', create_integration_trial: '시험 준비', 'create-integration-trial': '시험 준비', prepare_single_actor_test: '시험 준비', update: '초안 변경', draft: '초안 저장', draft_saved: '초안 저장', save: '초안 저장', submit: '검사 제출', approve: '검수 승인', reject: '반려', reinspect: '재검 요청', reinspection: '재검 요청', create_reinspection: '재검 요청 등록', refresh: 'MES 상태 조회', sync: 'MES 결과 동기화', reconcile_sync: 'MES 상태 확인', 'mes-save': 'MES 값 저장', 'mes-finish': '검사 완료 요청', 'mes-reconcile': 'MES 상태 확인' },
  zh: { create: '登记申请', create_integration_trial: '测试准备', 'create-integration-trial': '测试准备', prepare_single_actor_test: '测试准备', update: '修改草稿', draft: '保存草稿', draft_saved: '保存草稿', save: '保存草稿', submit: '提交检验', approve: '审核通过', reject: '退回', reinspect: '复检申请', reinspection: '复检申请', create_reinspection: '登记复检申请', refresh: '查询 MES 状态', sync: '同步 MES 结果', reconcile_sync: '确认 MES 状态', 'mes-save': '保存 MES 值', 'mes-finish': '请求完成检验', 'mes-reconcile': '确认 MES 状态' },
};

export function inspectionHistoryActionLabel(lang: 'ko' | 'zh', action: string): string {
  const base = action.replace(/_(reserved|unknown|verified|stale_observation|login_rejected|succeeded|failed|blocked)$/, '');
  return inspectionActionLabels[lang][base] || inspectionCopy[lang].historyOtherAction;
}

/** A reserved/uncertain request is not a verified result, regardless of WJ approval. */
export function inspectionHistoryResultLabel(lang: 'ko' | 'zh', action: string, state: string, operation = false): string {
  if (operation) return inspectionOperationLabels[lang][state] || inspectionCopy[lang].historyUnknownResult;
  const suffix = action.match(/_(reserved|unknown|verified|stale_observation|login_rejected|succeeded|failed|blocked)$/)?.[1];
  if (suffix) {
    const status = suffix === 'reserved' ? 'pending' : ['unknown', 'stale_observation'].includes(suffix) ? 'unknown'
      : ['verified', 'succeeded'].includes(suffix) ? 'succeeded' : suffix === 'login_rejected' ? 'blocked' : suffix;
    return inspectionOperationLabels[lang][status] || inspectionCopy[lang].historyUnknownResult;
  }
  if (['refresh', 'sync', 'reconcile_sync', 'mes-save', 'mes-finish', 'mes-reconcile'].includes(action)) return inspectionCopy[lang].historyUnknownResult;
  return inspectionRequestStatusLabels[lang][state] || inspectionCopy[lang].historyUnknownResult;
}

/** Preserve past observations without presenting them as current proof while reconciliation is locked. */
export function inspectionMesObservationCopy(lang: 'ko' | 'zh', request: Pick<InspectionRequest, 'sync_status' | 'mes_completion_status' | 'mes_state' | 'injection_receipt_readiness' | 'mes_checked_at'>, unresolved: boolean) {
  const text = inspectionCopy[lang];
  const sync = inspectionStatusLabels[lang][request.sync_status] || request.sync_status;
  const completion = mesCompletionLabels[lang][request.mes_completion_status] || request.mes_completion_status;
  const task = request.mes_state?.task_status ?? '—';
  const qc = request.mes_state?.qc_status ? mesQcLabels[lang][request.mes_state.qc_status] || request.mes_state.qc_status : '—';
  const readiness = injectionReadinessLabels[lang][request.injection_receipt_readiness || 'not_verified'];
  const prior = (value: string | number) => `${text.previousObservation}: ${value} · ${text.currentReconciliation}`;
  const checkedAt = inspectionTime(request.mes_checked_at, lang);
  return {
    sync: unresolved ? prior(sync) : sync,
    completion: unresolved ? prior(completion) : completion,
    task: unresolved ? prior(task) : task,
    qc: unresolved ? prior(qc) : qc,
    readiness: unresolved ? injectionReadinessLabels[lang].not_verified : readiness,
    priorReadiness: unresolved ? prior(readiness) : null,
    checkedAt,
    hint: unresolved ? `${text.previousObservationHint} ${text.observedAt}: ${checkedAt}` : '',
  };
}

/** Only the server's verified standalone projection can establish a trial verdict. */
export function inspectionMesTrialObservationCopy(lang: 'ko' | 'zh', observation: InspectionRequest['mes_trial_observation'], unresolved: boolean): string {
  const text = integrationTrialCopy[lang];
  if (unresolved || !observation || typeof observation !== 'object' || Array.isArray(observation)
    || typeof observation.observed_at !== 'string' || !Number.isFinite(Date.parse(observation.observed_at))) return text.unknown;
  return observation.verdict === 'pass' ? text.pass : observation.verdict === 'fail' ? text.fail : text.unknown;
}

export function inspectionTime(value: string | null | undefined, lang: 'ko' | 'zh'): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export const integrationTrialCreateCopy = {
  ko: { mode: '요청 종류', production: '생산 검사요청', trial: '연동시험 준비', code: '시험 코드',
    hint: 'WJ에 로컬 준비 요청을 저장합니다. 아직 MES 검사를 생성하거나 완료하지 않습니다.',
    invalid: 'WJ-IT-로 시작하는 대문자·숫자·대시 코드(최대 54자)를 입력하세요.', submit: '시험 준비 저장', denied: '연동시험 준비 권한이 없습니다.' },
  zh: { mode: '请求类型', production: '生产检验请求', trial: '接口测试准备', code: '测试代码',
    hint: '仅在 WJ 保存本地准备请求，尚未创建或完成 MES 检验。',
    invalid: '请输入以 WJ-IT- 开头的大写字母、数字及连字符代码（最多 54 字）。', submit: '保存测试准备', denied: '无接口测试准备权限。' },
} as const;
