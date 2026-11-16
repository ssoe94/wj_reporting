(function () {
  'use strict';

  const translations = {
    title: ['중량·라벨·재리딩', '称重、标签与复扫'],
    activePart: ['적용 PART', '当前料号'],
    partSelect: ['제품 / PART', '产品 / 料号'],
    applyPart: ['제품 적용', '应用产品'],
    choosePart: ['제품을 선택하세요', '请选择产品'],
    scale: ['계량', '称重'],
    noWeight: ['저울 입력 대기', '等待电子秤输入'],
    stable: ['안정', '稳定'],
    unstable: ['안정 대기', '等待稳定'],
    empty: ['빈 저울', '空秤'],
    loaded: ['적재 상태', '已放置'],
    lastResult: ['마지막 판정', '最近判定'],
    noResult: ['판정 대기 중', '等待判定'],
    resultPart: ['판정 PART', '判定料号'],
    quantity: ['수량', '数量'],
    resultWeight: ['판정 중량', '判定重量'],
    delta: ['오차', '偏差'],
    time: ['시각', '时间'],
    queue: ['인쇄 큐', '打印队列'],
    waiting: ['대기', '等待'],
    dispatching: ['전송 중', '发送中'],
    submitted: ['전송 수락', '已受理发送'],
    uncertain: ['전송 불확실', '发送情况不确定'],
    partial: ['다열 잔량', '多列余量'],
    peel: ['라벨 박리', '揭标'],
    peelWait: ['박리 대기', '等待取走标签'],
    peelReady: ['박리 대기 없음', '无需等待取标'],
    clearPeel: ['박리 확인', '确认已取标'],
    resume: ['전송 재개', '恢复发送'],
    flush: ['잔량 출력', '打印余量'],
    acknowledge: ['불확실 확인 기록', '记录核查结果'],
    uncertainRow: ['확인할 인쇄 작업', '待核查的打印任务'],
    confirmedQuantity: ['실제로 확인한 라벨 수', '实际确认的标签数量'],
    paused: ['전송 일시 중지', '发送已暂停'],
    restart_queue: ['재시작 후 대기 작업 검토', '重启后请核查待发送任务'],
    print_rejected_unsent: ['전송 전 거절', '发送前被拒绝'],
    operator_resume: ['작업자 재개 대기', '等待操作员恢复'],
    printer_configuration: ['프린터 설정 확인', '核对打印机设置'],
    route_changed: ['프린터 연결 설정 변경', '打印连接设置已更改'],
    payload_corrupt: ['예약된 인쇄 데이터 오류', '已预留的打印数据异常'],
    queue_full: ['인쇄 대기 한도 도달', '打印队列已满'],
    serial_exhausted: ['라벨 번호 범위 소진', '标签序号已用完'],
    storage_error: ['원장 저장 오류', '台账保存异常'],
    reservationBlocked: ['라벨 예약 보류', '标签预留暂停'],
    reread: ['마지막 재리딩', '最近复扫'],
    noReread: ['스캔 대기 중', '等待扫码'],
    barcode: ['바코드', '条码'],
    source: ['입력 장치', '输入设备'],
    storageError: ['저장 오류 · 원장과 출력 상태를 확인하세요.', '保存异常 · 请检查台账和打印状态。'],
    stale: ['로컬 연결을 다시 확인하는 중입니다.', '正在重新连接本机。'],
    success: ['작업을 반영했습니다.', '操作已应用。'],
    invalidAction: ['현재 제품 또는 인쇄 상태에서 적용할 수 없습니다.', '当前产品或打印状态无法执行此操作。'],
    actionFailed: ['작업을 반영하지 못했습니다. 연결과 저장 상태를 확인하세요.', '无法执行操作，请检查连接和存储状态。'],
    confirmResume: ['대기 작업의 전송을 재개할까요?', '是否恢复发送等待中的任务？'],
    confirmFlush: ['현재 다열 잔량을 출력할까요?', '是否打印当前多列余量？'],
    confirmPeel: ['박리부에서 출력된 라벨을 실제로 꺼냈습니까? 다음 인쇄를 허용합니다.', '是否已从揭标处取走标签？确认后允许下一次打印。'],
    confirmUncertain: ['실물 확인 결과를 기록할까요? 전송 재개는 별도입니다.', '是否记录实物核查结果？恢复发送需另行操作。'],
    weight_within_limit: ['허용 범위 이내', '重量在允许范围内'],
    weight_outside_limit: ['허용 범위 초과', '重量超出允许范围'],
    weight_at_or_below_zero: ['유효 중량 미확인', '未确认有效重量'],
    ok: ['라벨 일치', '标签匹配'],
    external_ok: ['외부 라벨 일치', '外部标签匹配'],
    duplicate: ['중복 스캔', '重复扫码'],
    wrong_part: ['다른 PART', '料号不符'],
    wrong_scanner_A: ['A 스캐너 사용', '请使用 A 扫码枪'],
    wrong_scanner_B: ['B 스캐너 사용', '请使用 B 扫码枪'],
    unprinted: ['전송 전 라벨', '标签尚未发送打印'],
    rereadUncertain: ['인쇄 결과 확인 필요', '需核查打印结果'],
    review_required: ['실물·원장 대조 필요', '需核对实物和台账'],
    ledger_error: ['인쇄 장부 확인 필요', '请检查打印台账'],
    manual_entry: ['수동 입력 기록', '手动输入记录'],
    test_scan: ['시험 스캔 기록', '测试扫码记录'],
    preview_scan: ['체험 스캔 기록', '演示扫码记录'],
    invalid: ['바코드 형식 오류', '条码格式错误'],
    invalid_label_code: ['라벨 식별 코드 오류', '标签识别码错误'],
    unknown_barcode: ['등록되지 않은 바코드', '未知条码'],
    external_wrong_part: ['외부 라벨 · 다른 PART', '外部标签 · 料号不符'],
    no_selection: ['제품 선택 필요', '请先选择产品'],
  };
  const queueCounts = ['waiting', 'dispatching', 'submitted', 'uncertain', 'partial'];
  const byId = document.getElementById.bind(document);

  function write(id, value) {
    const element = byId(id);
    if (element.textContent !== value) element.textContent = value;
    return element;
  }

  function count(value) {
    return Number.isInteger(value) ? String(value) : '—';
  }

  function grams(value) {
    return value != null && value !== '' ? value + ' g' : '—';
  }

  window.createWeighView = function (timestamp, deviceText) {
    const section = byId('weigh');
    const product = byId('weigh-product');
    const select = byId('weigh-select');
    const resume = byId('weigh-resume');
    const flush = byId('weigh-flush');
    const peel = byId('weigh-peel');
    const acknowledge = byId('weigh-acknowledge');
    const input = byId('weigh-confirmed-quantity');
    let data, language, connection, productSignature, uncertainRow, notice;
    let busy = false;

    function t(key) {
      const entry = Object.prototype.hasOwnProperty.call(translations, key) && translations[key];
      return entry ? entry[language === 'zh' ? 1 : 0] : '';
    }

    function queue() {
      return data && data.queue || {};
    }

    function updateProduct() {
      const products = data.products || [];
      const signature = JSON.stringify([language, data.part_no, products]);
      if (productSignature === signature) return;
      const prior = productSignature ? JSON.parse(productSignature)[1] : undefined;
      const draft = prior === data.part_no ? product.value : data.part_no;
      productSignature = signature;
      product.replaceChildren(new Option(t('choosePart'), ''));
      products.forEach(function (item) {
        if (!item.part_no) return;
        const label = item.name && item.name !== item.part_no ? item.part_no + ' · ' + item.name : item.part_no;
        product.appendChild(new Option(label, item.part_no));
      });
      product.value = products.some(function (item) { return item.part_no === draft; }) ? draft : '';
    }

    function updateMeasurements() {
      const recordedWeight = data.weight_g != null && data.weight_g !== '';
      const stable = write('weigh-stable', t(recordedWeight ? (data.stable ? 'stable' : 'unstable') : 'noWeight'));
      stable.dataset.level = recordedWeight && data.stable ? 'ok' : 'neutral';
      const empty = write('weigh-empty', recordedWeight && typeof data.empty === 'boolean' ? t(data.empty ? 'empty' : 'loaded') : '—');
      empty.dataset.level = recordedWeight && data.empty ? 'ok' : 'neutral';
      write('weigh-weight', grams(data.weight_g));
      const result = data.last_result || {};
      const verdict = result.result === 'ok' ? 'PASS' : result.result === 'ng' ? 'NG' : '';
      const reason = t(result.reason);
      const blocked = result.reservation_blocked ? t(result.reservation_blocked) || t('reservationBlocked') : '';
      const value = verdict ? [verdict, reason, blocked].filter(Boolean).join(' · ') : t('noResult');
      write('weigh-result', value).dataset.level = blocked ? 'check' : result.result || 'neutral';
      write('weigh-result-part', result.part_no || '—');
      write('weigh-result-quantity', count(result.quantity));
      write('weigh-result-weight', grams(result.weight_g));
      write('weigh-result-delta', grams(result.delta_g));
      write('weigh-result-time', timestamp(result.time));
    }

    function updateQueue() {
      const state = queue();
      queueCounts.forEach(function (key) { write('weigh-' + key, count(state[key])); });
      write('weigh-peel-state', typeof state.peel_wait === 'boolean' ? t(state.peel_wait ? 'peelWait' : 'peelReady') : '—');
      const reason = t(state.pause_reason);
      write('weigh-paused', t('paused') + (reason ? ' · ' + reason : '')).hidden = !state.paused;
      const nextRow = (state.uncertain_ids || [])[0];
      if (uncertainRow !== nextRow) input.value = '';
      uncertainRow = nextRow;
      const validMaximum = Number.isInteger(state.uncertain_quantity) && state.uncertain_quantity >= 0;
      byId('weigh-uncertain-controls').hidden = !uncertainRow || !validMaximum;
      if (uncertainRow && validMaximum) {
        input.max = state.uncertain_quantity;
        write('weigh-uncertain-label', t('uncertainRow') + ' · ' + uncertainRow + ' · 0–' + state.uncertain_quantity);
      }
    }

    function updateReread() {
      const reread = data.last_reread || {};
      const result = reread.status;
      let level = 'neutral';
      let message = t('noReread');
      if (result) {
        let resultKey = result;
        if (result === 'ok' && reread.label_origin === 'external') resultKey = 'external_ok';
        if (result === 'uncertain') resultKey = 'rereadUncertain';
        const label = t(resultKey) || result;
        if (result === 'ok' || result === 'external_ok') {
          level = 'ok';
          message = 'OK · ' + label;
        } else if (['manual_entry', 'test_scan', 'preview_scan'].includes(result)) {
          level = 'check';
          message = label;
        } else {
          level = 'ng';
          message = 'NG · ' + label;
        }
      }
      write('weigh-reread-result', message).dataset.level = level;
      write('weigh-reread-barcode', reread.barcode || '—');
      write('weigh-reread-device', deviceText(reread.device));
      write('weigh-reread-time', timestamp(reread.time));
    }

    function confirmedQuantity() {
      const maximum = queue().uncertain_quantity;
      const value = input.value;
      if (!Number.isInteger(maximum) || !/^\d+$/.test(value)) return null;
      const quantity = Number(value);
      return Number.isSafeInteger(quantity) && quantity <= maximum ? quantity : null;
    }

    function updateControls() {
      const state = queue();
      const available = data && connection === 'connected' && !busy;
      product.disabled = !available || !data.products || !data.products.length;
      select.disabled = product.disabled || !product.value || product.value === data.part_no;
      const locked = state.uncertain > 0 || state.dispatching > 0;
      resume.disabled = !available || !state.paused || locked;
      flush.disabled = !available || state.paused || locked || !(state.partial > 0);
      peel.disabled = !available || !state.peel_wait || locked;
      input.disabled = !available || !uncertainRow;
      acknowledge.disabled = input.disabled || confirmedQuantity() === null;
    }

    function updateNotice() {
      const element = write('weigh-notice', t(notice));
      element.hidden = !notice;
      element.dataset.kind = notice === 'success' ? 'success' : 'error';
    }

    function render(next, lang, status) {
      data = next;
      const languageChanged = language !== lang;
      language = lang;
      connection = status;
      section.hidden = !data;
      if (!data) return;
      if (languageChanged || !section.dataset.translated) {
        section.querySelectorAll('[data-weigh-text]').forEach(function (element) {
          element.textContent = t(element.dataset.weighText);
        });
        section.dataset.translated = 'true';
      }
      write('weigh-active-part', data.part_no || '—');
      write('weigh-mode', deviceText(data.mode)).hidden = !data.mode;
      byId('weigh-storage-error').hidden = !data.storage_error;
      byId('weigh-stale').hidden = connection === 'connected';
      updateProduct();
      updateMeasurements();
      updateQueue();
      updateReread();
      updateNotice();
      updateControls();
    }

    async function action(name, payload, button, confirmation) {
      if (button.disabled) return;
      if (confirmation && !window.confirm(t(confirmation))) return;
      busy = true;
      notice = null;
      updateControls();
      updateNotice();
      try {
        const response = await fetch('/api/weigh/' + name + '/', {
          method: 'POST',
          mode: 'same-origin',
          headers: {'X-WJ-Local': '1', 'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
        notice = response.ok ? 'success' : response.status === 400 ? 'invalidAction' : 'actionFailed';
      } catch (_) {
        notice = 'actionFailed';
      } finally {
        busy = false;
        updateControls();
        updateNotice();
        if (!button.disabled && document.activeElement === document.body) button.focus();
      }
    }

    product.addEventListener('change', updateControls);
    input.addEventListener('input', updateControls);
    select.addEventListener('click', function () { action('product', {part_no: product.value}, select); });
    resume.addEventListener('click', function () { action('resume', {}, resume, 'confirmResume'); });
    flush.addEventListener('click', function () { action('flush', {}, flush, 'confirmFlush'); });
    peel.addEventListener('click', function () { action('peel', {}, peel, 'confirmPeel'); });
    acknowledge.addEventListener('click', function () {
      action('acknowledge', {job_id: uncertainRow, confirmed_quantity: confirmedQuantity()}, acknowledge, 'confirmUncertain');
    });

    return {render: render};
  };
})();
