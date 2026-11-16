export type Tx = (ko: string, zh: string) => string;

type Pair = readonly [ko: string, zh: string];
const labels: Record<string, Pair> = {
  barcode: ['바코드 리더', '条码读取'],
  weigh_label: ['중량·라벨 검증', '称重与标签核验'],
  vision_backcover: ['백커버 비전 검사', '后盖视觉检查'],
  vision_capture: ['양면 촬영', '双面拍摄'],
  vision_uv: ['UV 배치 검사', 'UV 批次检查'],

  production: ['생산', '生产'],
  test: ['시험', '测试'],
  demo: ['데모', '演示'],
  preview: ['미리보기', '预览'],
  manual: ['수동', '手动'],
  unknown: ['미확인', '未知'],
  online: ['접속 중', '在线'],
  stale: ['접속 지연', '连接延迟'],
  offline: ['접속 끊김', '离线'],
  never: ['접속 이력 없음', '无连接记录'],
  running: ['실행 중', '运行中'],
  stopped: ['중지', '已停止'],
  ready: ['전송 가능', '可发送'],
  backoff: ['재전송 대기', '等待重试'],
  blocked: ['전송 차단', '发送受阻'],
  storage_pressure: ['저장 공간 부족', '存储空间不足'],
  connected: ['연결', '已连接'],
  disconnected: ['연결 끊김', '已断开'],
  fault: ['장치 오류', '设备故障'],
  ok: ['OK', 'OK'],
  ng: ['NG', 'NG'],
  error: ['오류', '错误'],
  info: ['정보', '信息'],

  'scan.recorded': ['바코드 판정', '条码判定'],
  'weigh.result': ['계량 판정', '称重判定'],
  'label.reserved': ['라벨 예약', '标签预留'],
  'label.dispatched': ['인쇄 전송 시도', '打印发送尝试'],
  'label.reread': ['라벨 재리딩', '标签复扫'],
  'queue.partial_flush': ['잔량 인쇄 승인', '余量打印批准'],
  'vision.cycle': ['비전 판정', '视觉判定'],
  'vision.batch': ['배치 검사', '批次检查'],
  'capture.pair': ['양면 촬영 기록', '双面拍摄记录'],
  'capture.single': ['단독 촬영 기록', '单面拍摄记录'],
  'app.started': ['앱 시작', '程序启动'],
  'app.stopped': ['앱 중지', '程序停止'],
  'device.state': ['장치 상태', '设备状态'],
  'mode.changed': ['모드 전환', '模式切换'],
  'config.applied': ['설정 적용', '应用设置'],
  'operator.action': ['작업자 조작', '操作员操作'],
  'backup.completed': ['백업 완료', '备份完成'],
  'backup.failed': ['백업 실패', '备份失败'],

  barcode_seen_before_reset: ['초기화 후 재스캔된 기존 바코드', '重置后再次扫描的已有条码'],
  barcode_reset: ['바코드 카운터 초기화', '条码计数重置'],
  barcode_config_applied: ['바코드 설정 적용', '条码设置已应用'],
  barcode_mode_changed: ['바코드 모드 전환', '条码模式切换'],
  barcode_app_started: ['바코드 앱 시작', '条码程序启动'],
  barcode_app_stopped: ['바코드 앱 중지', '条码程序停止'],
  barcode_device_connected: ['스캐너 연결', '扫码枪已连接'],
  barcode_device_disconnected: ['스캐너 연결 끊김', '扫码枪已断开'],
  barcode_device_fault: ['스캐너 오류', '扫码枪故障'],
  legacy_source_gap: ['기존 앱 DB 관측 단절', '原程序数据库观测中断'],
  weigh_app_started: ['중량 앱 시작', '称重程序启动'],
  weigh_app_stopped: ['중량 앱 중지', '称重程序停止'],
  weigh_config_applied: ['중량·라벨 설정 적용', '已应用称重和标签设置'],
  weigh_queue_resumed: ['인쇄 대기열 재개', '已恢复打印队列'],
  weigh_reservation_blocked: ['라벨 예약 보류', '标签预留暂缓'],
  peel_waiting_seen: ['박리 대기 감지', '检测到标签等待取走'],
  peel_sensor_cleared: ['박리 해제 감지', '传感器确认标签已取走'],
  peel_operator_cleared: ['작업자 박리 해제 확인', '操作员确认标签已取走'],
  partial_flush_approved: ['잔량 출력 승인', '已批准打印剩余标签'],
  operator_reconciled: ['작업자 실물 확인', '操作员核对实物'],
  manual_input: ['수동 입력', '手动输入'],
  test_input: ['시험 입력', '测试输入'],
  scan_match: ['바코드 일치', '条码匹配'],
  scan_duplicate: ['바코드 중복', '条码重复'],
  scan_invalid: ['유효하지 않은 바코드', '无效条码'],
  scan_overlength: ['바코드 길이 초과', '条码超长'],
  scan_wrong_product_group: ['품목군 불일치', '产品组不符'],
  scan_wrong_device: ['스캐너 불일치', '扫描器不符'],
  scan_input_error: ['스캔 입력 오류', '扫码输入错误'],
  weight_within_limit: ['정상 중량', '重量在范围内'],
  weight_outside_limit: ['중량 허용 범위 초과', '重量超出范围'],
  weight_at_or_below_zero: ['계량 중량 없음', '无称重重量'],
  label_reserved: ['라벨 예약 완료', '标签已预留'],
  print_submitted: ['인쇄 요청 수락', '打印请求已受理'],
  print_uncertain: ['인쇄 전송 결과 미확인', '打印发送结果未确认'],
  print_rejected_unsent: ['인쇄 전송 거부', '打印发送被拒绝'],
  print_reread_overdue: ['출력 후 재리딩 미확인', '打印后复扫未确认'],
  label_invalid_code: ['유효하지 않은 라벨 코드', '无效标签码'],
  label_unknown: ['등록되지 않은 라벨', '未登记标签'],
  label_not_submitted: ['인쇄 요청 미확인', '打印请求未确认'],
  label_review_required: ['라벨 검토 필요', '标签待核查'],
  reread_match: ['재리딩 일치', '复扫匹配'],
  reread_wrong_part: ['재리딩 품번 불일치', '复扫料号不符'],
  occlusion_confirmed: ['가림 작업 확인', '遮挡动作已确认'],
  operation_not_confirmed: ['가림 작업 미확인', '遮挡动作未确认'],
  vision_cycle_conflict: ['같은 사이클의 판정 충돌', '同一周期的判定冲突'],
  vision_incomplete: ['비전 검사 미완료', '视觉检查未完成'],
  vision_device_fault: ['비전 장치 오류', '视觉设备故障'],
  vision_runtime_fault: ['비전 실행 오류', '视觉程序故障'],
  vision_source_gap: ['비전 기록 수집 단절', '视觉记录采集中断'],
  capture_pair_saved: ['양면 사진 쌍 저장', '双面照片已保存'],
  capture_pair_incomplete: ['양면 촬영 미완료', '双面拍摄未完成'],
  uv_batch_pass: ['UV 배치 검사 OK', 'UV 批次检查 OK'],
  uv_batch_fail: ['UV 배치 검사 NG', 'UV 批次检查 NG'],
  local_record_error: ['로컬 기록 오류', '本地记录错误'],
  device_fault: ['장치 오류', '设备故障'],
  device_disconnected: ['장치 연결 끊김', '设备已断开'],
  clock_offset: ['PC 시계 차이', '电脑时钟偏差'],
  duplicate_sender: ['중복 송신 의심', '疑似重复发送端'],
  upload_backlog: ['전송 적체', '发送积压'],
  connection_stale: ['접속 지연', '连接延迟'],
  connection_offline: ['접속 끊김', '已离线'],
  non_production_activity: ['생산 중 비생산 모드 기록', '生产时段的非生产模式记录'],
};

export function fieldText(code: string, tx: Tx) {
  const text = Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : undefined;
  return text ? tx(...text) : code;
}

const deviceLabels: Record<string, Pair> = {
  SCALE: ['저울', '电子秤'],
  CAMERA: ['카메라', '相机'],
  SIGNAL_LIGHT: ['신호등', '信号灯'],
  PRINTER: ['프린터', '打印机'],
  A: ['스캐너 A', 'A 扫码枪'],
  B: ['스캐너 B', 'B 扫码枪'],
  W: ['스캐너 W', 'W 扫码枪'],
  KEYBOARD: ['키보드', '键盘'],
};

export function fieldDeviceText(code: string, tx: Tx) {
  const text = deviceLabels[code.toUpperCase()];
  return text ? tx(...text) : code;
}

const shanghaiTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function formatFieldTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : shanghaiTime.format(date);
}

export function clockMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? `+${minutes}` : String(minutes);
}
