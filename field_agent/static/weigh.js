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
    submitted: ['전송 수락', '已受理'],
    uncertain: ['전송 불확실', '发送未确认'],
    partial: ['다열 잔량', '多列余量'],
    peel: ['라벨 박리', '揭标'],
    peelWait: ['박리 대기', '等待取走标签'],
    peelReady: ['박리 대기 없음', '无需等待取标'],
    clearPeel: ['박리 확인', '确认已取标'],
    pause: ['전송 일시 중지', '暂停发送'],
    operator_pause: ['작업자 일시 중지', '操作员暂停'],
    cancelWaiting: ['미전송 취소', '取消未发送'],
    confirmPause: ['새 작업의 자동 전송을 일시 중지할까요? 이미 시작한 전송은 계속됩니다.', '是否暂停新任务的自动发送？已开始的发送将继续。'],
    confirmCancel: ['대기 중인 미전송 라벨을 취소할까요? 예약한 번호는 다시 사용할 수 없습니다.', '是否取消尚未发送的标签？已预留的流水号不会再使用。'],
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
    serial_floor_required: ['시리얼 시작 기준 미확정 · 라벨 발급 중지', '流水号起始基准未确认 · 已停止发放标签'],
    serial_source_unavailable: ['기존 발급 기록을 읽을 수 없습니다', '无法读取旧程序的发放记录'],
    serialChecking: ['첫 발급 전에 기존 발급기록을 자동 확인합니다.', '首次发放前将自动核查旧程序的发放记录。'],
    serialAction: ['관리자에게 기존 발급 기록 연결 또는 미발급 확인을 요청하세요. 확인 전에는 이 PART의 라벨을 발급할 수 없습니다.', '请联系管理员接入旧发放记录或确认从未发放。确认前不能为此料号发放标签。'],
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
    keyboardInput: ['키보드 스캐너 입력', '键盘扫描器输入'],
    keyboardReady: ['키보드 입력 준비', '键盘输入就绪'],
    keyboardInactive: ['키보드 스캔 미수신 상태', '键盘扫描未接收'],
    keyboardSaving: ['입력 저장 중', '正在保存输入'],
    focusHelp: ['이 입력칸이 활성화된 상태에서 Enter로 끝나는 스캔만 받습니다. 다른 칸·창의 입력은 기록되지 않습니다.', '仅在此输入框启用时接收以 Enter 结束的扫码。其他输入框或窗口中的输入不会记录。'],
    focusInput: ['입력칸 활성화', '聚焦扫码框'],
    submitManual: ['수동 기록', '手动记录'],
    retryScan: ['같은 입력 다시 보내기', '重试同一次输入'],
    scanReady: ['입력을 기록했습니다.', '已记录输入。'],
    labelSettings: ['라벨 템플릿 · 미리보기', '标签模板与预览'],
    templateSelect: ['승인 템플릿', '已批准模板'],
    applyTemplate: ['템플릿 적용', '应用模板'],
    chooseTemplate: ['템플릿을 선택하세요', '请选择模板'],
    confirmTemplate: ['템플릿과 표시 문구를 다음 예약부터 적용할까요?', '是否从下一次预留起应用模板和显示文字？'],
    invalidTemplateValue: ['인쇄 문구는 허용된 영문·숫자·기호만 사용할 수 있습니다.', '打印文字只能使用允许的英文字母、数字和符号。'],
    templateConflict: ['적용된 템플릿이 다른 화면에서 바뀌었습니다. 표시값을 다시 확인하세요.', '模板已在其他窗口更改，请重新核对显示值。'],
    labelPreview: ['라벨 미리보기', '标签预览'],
    previewDisclosure: ['내용 확인용입니다. 번호를 예약하거나 라벨을 출력하지 않습니다.', '仅用于核对内容，不预留流水号，也不打印标签。'],
    sampleBarcode: ['샘플 바코드', '示例条码'],
    sampleCell: ['라벨 열', '标签列'],
    noTemplates: ['이 제품에 승인된 템플릿이 없습니다.', '此产品暂无批准的模板。'],
    jobProgress: ['작업별 재리딩 진행률', '各项作业复扫进度'],
    noJobs: ['아직 예약된 작업이 없습니다.', '暂无已预留的任务。'],
    olderJobs: ['이전 작업 펼치기', '展开较早的作业'],
    newerJobs: ['최근 작업만 보기', '仅显示最近作业'],
    mixed: ['상태 혼합', '多种状态'],
    pendingChange: ['대기 작업을 마무리한 뒤 제품이나 템플릿을 변경하세요.', '请完成待处理作业后再切换产品或模板。'],
    reserved: ['예약', '已预留'],
    confirmed: ['재리딩 확인', '已确认复扫'],
    unconfirmed: ['미확인', '待确认'],
    saved_state: ['예약됨', '已预留'],
    cancelled: ['취소됨', '已取消'],
    reconciled: ['실물 확인 기록됨', '已记录实物核查'],
    soundOn: ['NG 소리 켜짐', '已开启 NG 提示音'],
    soundOff: ['NG 소리 꺼짐', '已关闭 NG 提示音'],
    soundBlocked: ['NG 소리 차단 · 켜기', 'NG 提示音被拦截 · 启用'],
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
    const pause = byId('weigh-pause');
    const resume = byId('weigh-resume');
    const cancel = byId('weigh-cancel');
    const flush = byId('weigh-flush');
    const peel = byId('weigh-peel');
    const acknowledge = byId('weigh-acknowledge');
    const input = byId('weigh-confirmed-quantity');
    const scanner = byId('weigh-scan-input');
    const scannerFocus = byId('weigh-focus');
    const manual = byId('weigh-manual');
    const template = byId('weigh-template');
    const templateApply = byId('weigh-template-apply');
    const sound = byId('weigh-sound');
    let data, language, connection, productSignature, uncertainRow, notice;
    let appliedLabelSignature, labelDisplaySignature, jobSignature, pendingScan;
    let showOlderJobs = false;
    let pressedAt = [];
    let draft = {};
    let audio, audioOn = true;
    let lastWeightEvent, lastRereadEvent;
    let submittingScan = false;
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

    function selectedTemplate() {
      return (data.labels?.templates || []).find(function (item) { return item.id === template.value; });
    }

    function templateFields() {
      return selectedTemplate()?.fields || [];
    }

    function defaultValues() {
      const selected = selectedTemplate();
      return selected && data.labels.template_id === selected.id ? (data.labels.values || {}) : {};
    }

    function setDraft() {
      const values = defaultValues();
      draft = Object.fromEntries(templateFields().map(function (field) {
        return [field.key, values[field.key] ?? field.default ?? ''];
      }));
    }

    function validField(value, field) {
      return typeof value === 'string' && value.length <= (field.max_length || 96)
        && /^[\x20-\x7e]*$/.test(value) && !/["{}\^~\\]/.test(value);
    }

    function validDraft() {
      return templateFields().every(function (field) { return validField(draft[field.key], field); });
    }

    function changedTemplate() {
      if (!data.labels || !selectedTemplate()) return false;
      const same = data.labels.template_id === template.value;
      return !same || templateFields().some(function (field) {
        return draft[field.key] !== (defaultValues()[field.key] ?? field.default ?? '');
      });
    }

    function updatePreview() {
      const target = byId('weigh-preview');
      const item = selectedTemplate();
      target.replaceChildren();
      if (!item) return;
      const preview = (item.id === data.labels.template_id ? data.labels.preview : null) || {};
      const columns = preview.columns || item.columns || 1;
      target.dataset.columns = String(columns);
      const cells = Array.isArray(preview.cells) && preview.cells.length ? preview.cells
        : Array.from({length: columns}, function () { return {}; });
      cells.forEach(function (cell, index) {
        const tile = document.createElement('section');
        tile.className = 'weigh-preview-cell';
        const title = document.createElement('p');
        title.className = 'muted';
        title.textContent = t('sampleCell') + ' ' + (index + 1);
        const code = document.createElement('strong');
        code.textContent = cell.barcode || ((data.part_no || '') + '-SAMPLE');
        code.setAttribute('aria-label', t('sampleBarcode') + ' ' + code.textContent);
        tile.append(title, code);
        const values = [data.part_no, ...templateFields().map(function (field) { return draft[field.key]; })];
        values.filter(Boolean).forEach(function (value) {
          const line = document.createElement('p');
          line.textContent = value;
          tile.append(line);
        });
        target.append(tile);
      });
    }

    function renderFields() {
      const selected = selectedTemplate();
      const signature = JSON.stringify([appliedLabelSignature, language, selected?.id]);
      if (signature === labelDisplaySignature) return;
      labelDisplaySignature = signature;
      const group = byId('weigh-template-fields');
      group.replaceChildren();
      templateFields().forEach(function (field) {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.textContent = (language === 'zh' ? field.label_zh : field.label_ko) || field.key;
        const control = document.createElement('input');
        control.type = 'text';
        control.maxLength = field.max_length || 96;
        control.value = draft[field.key] || '';
        control.spellcheck = false;
        control.autocomplete = 'off';
        control.setAttribute('aria-invalid', String(!validField(control.value, field)));
        control.addEventListener('input', function () {
          draft[field.key] = control.value;
          const valid = validField(control.value, field);
          control.setAttribute('aria-invalid', String(!valid));
          control.setCustomValidity(valid ? '' : t('invalidTemplateValue'));
          updatePreview();
          updateControls();
        });
        label.append(caption, control);
        group.append(label);
      });
      updatePreview();
    }

    function updateLabelSettings() {
      const labels = data.labels || {};
      const available = Array.isArray(labels.templates) && labels.templates.length > 0;
      byId('weigh-template-controls').hidden = !available;
      byId('weigh-no-templates').hidden = available;
      const signature = JSON.stringify([data.part_no, labels]);
      const optionsSignature = JSON.stringify([signature, language]);
      if (optionsSignature !== updateLabelSettings.options) {
        const changed = appliedLabelSignature !== signature;
        const selected = changed ? labels.template_id : template.value;
        const dirty = templateFields().some(function (field) {
          return draft[field.key] !== (defaultValues()[field.key] ?? field.default ?? '');
        });
        template.replaceChildren(new Option(t('chooseTemplate'), ''));
        (labels.templates || []).forEach(function (item) {
          const name = (language === 'zh' ? item.name_zh : item.name_ko) || item.name || item.id;
          template.append(new Option(name, item.id));
        });
        template.value = selected || '';
        if (changed) {
          if (appliedLabelSignature && dirty && !busy && notice !== 'success') notice = 'templateConflict';
          setDraft();
        }
        appliedLabelSignature = signature;
        updateLabelSettings.options = optionsSignature;
      }
      renderFields();
    }

    function updateJobs() {
      const jobs = data.jobs || [];
      const signature = JSON.stringify([language, jobs, showOlderJobs]);
      if (jobSignature === signature) return;
      jobSignature = signature;
      const list = byId('weigh-jobs');
      byId('weigh-jobs-empty').hidden = jobs.length > 0;
      const more = write('weigh-older-jobs', t(showOlderJobs ? 'newerJobs' : 'olderJobs'));
      more.hidden = jobs.length <= 5;
      more.setAttribute('aria-expanded', String(showOlderJobs));
      list.replaceChildren();
      (showOlderJobs ? jobs : jobs.slice(0, 5)).forEach(function (job) {
        const row = document.createElement('li');
        const header = document.createElement('div');
        header.className = 'weigh-job-info';
        const name = document.createElement('strong');
        name.textContent = job.part_no || '—';
        const ref = document.createElement('span');
        ref.textContent = [job.id || '—', timestamp(job.time), t(job.state)].filter(Boolean).join(' · ');
        header.append(name, ref);
        const facts = document.createElement('dl');
        ['reserved', 'submitted', 'confirmed', 'unconfirmed'].forEach(function (key) {
          const cell = document.createElement('div');
          const term = document.createElement('dt');
          term.textContent = t(key);
          const value = document.createElement('dd');
          value.textContent = count(job[key]);
          cell.append(term, value);
          facts.append(cell);
        });
        row.append(header, facts);
        list.append(row);
      });
    }

    function updateSerial() {
      const serial = data.serial || {};
      const status = serial.status || queue().pause_reason;
      const phase = byId('weigh-serial-block');
      const checking = status === 'lookup_pending';
      const blocked = status === 'serial_floor_required' || status === 'serial_source_unavailable';
      phase.hidden = !blocked && !checking;
      phase.dataset.level = checking ? 'check' : 'ng';
      phase.firstElementChild.textContent = t(checking ? 'serialChecking' : status);
      write('weigh-serial-context', [serial.part_no, serial.day, serial.date_code].filter(Boolean).join(' · '));
      phase.lastElementChild.hidden = !blocked;
    }

    function renderSound() {
      const enabled = audioOn && audio?.state === 'running';
      const key = enabled ? 'soundOn' : audioOn ? 'soundBlocked' : 'soundOff';
      write('weigh-sound', t(key));
      sound.dataset.sound = enabled ? 'on' : 'off';
      sound.setAttribute('aria-pressed', String(enabled));
    }

    function wakeSound() {
      if (!audio) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        try {
          audio = new Context();
          audio.addEventListener('statechange', renderSound);
        } catch (_) { return; }
      }
      if (audio.state === 'suspended') {
        audio.resume().then(renderSound, renderSound);
      }
      renderSound();
    }

    function signalNg() {
      if (!audioOn || audio?.state !== 'running') return;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const now = audio.currentTime;
      oscillator.frequency.value = 480;
      gain.gain.setValueAtTime(.10, now);
      gain.gain.exponentialRampToValueAtTime(.001, now + .19);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.addEventListener('ended', function () {
        oscillator.disconnect();
        gain.disconnect();
      }, {once: true});
      oscillator.start(now);
      oscillator.stop(now + .2);
    }

    function checkVerdictChange() {
      const weightResult = data.last_result;
      const readResult = data.last_reread;
      const weightKey = weightResult ? JSON.stringify([weightResult.seq, weightResult.time, weightResult.reason]) : '';
      const rereadKey = readResult ? JSON.stringify([readResult.seq, readResult.time, readResult.barcode]) : '';
      const newWeight = lastWeightEvent !== undefined && lastWeightEvent !== weightKey && weightResult?.result === 'ng';
      const neutral = ['ok', 'external_ok', 'manual_entry', 'test_scan', 'preview_scan'];
      const newRead = lastRereadEvent !== undefined && lastRereadEvent !== rereadKey && readResult
        && !neutral.includes(readResult.status);
      lastWeightEvent = weightKey;
      lastRereadEvent = rereadKey;
      if ((newWeight || newRead) && connection === 'connected') signalNg();
    }

    function scannerStatus() {
      const focused = !document.hidden && document.hasFocus()
        && document.activeElement === scanner && !scanner.readOnly;
      const key = submittingScan ? 'keyboardSaving' : focused ? 'keyboardReady' : 'keyboardInactive';
      write('weigh-scanner-focus', t(key)).dataset.level = focused ? 'ok' : 'check';
    }

    function fastWedge(barcode) {
      if (pressedAt.length !== barcode.length || pressedAt.length < 8) return false;
      const first = pressedAt[0];
      const last = pressedAt[pressedAt.length - 1];
      return last - first <= 1000 && performance.now() - last < 1000
        && pressedAt.every(function (time, index) { return !index || time - pressedAt[index - 1] <= 50; });
    }

    function requestId() {
      return 'sw-' + Array.from(crypto.getRandomValues(new Uint8Array(16)),
        function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    }

    async function submitScan(allowWedge) {
      const barcode = scanner.value.trim();
      if (!barcode || manual.disabled || scanner.readOnly) return;
      const scan = pendingScan?.barcode === barcode ? pendingScan : {
        barcode: barcode,
        request_id: requestId(),
        source: allowWedge && fastWedge(barcode) ? 'keyboard' : 'manual',
      };
      pressedAt = [];
      pendingScan = scan;
      submittingScan = true;
      try {
        if (await action('reread', scan, manual)) {
          scanner.value = '';
          pendingScan = null;
          notice = 'scanReady';
        }
      } finally {
        submittingScan = false;
        updateControls();
        updateNotice();
        scanner.focus();
      }
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
      const hasPending = locked || state.waiting > 0;
      select.disabled = select.disabled || hasPending;
      const missingFloor = data?.serial?.status === 'serial_floor_required';
      pause.hidden = Boolean(state.paused);
      pause.disabled = !available || state.paused;
      resume.hidden = !state.paused || locked;
      resume.disabled = !available || !state.paused || locked || missingFloor;
      cancel.hidden = !(state.paused && state.waiting > 0 && !locked);
      cancel.disabled = !available || cancel.hidden;
      flush.hidden = !(state.partial > 0) || locked;
      flush.disabled = !available || state.paused || locked || flush.hidden;
      peel.hidden = !state.peel_wait || locked;
      peel.disabled = !available || !state.peel_wait || locked;
      byId('weigh-pending-change').hidden = !hasPending || !product.value || product.value === data.part_no;
      byId('weigh-template-pending').hidden = !hasPending || !changedTemplate();
      input.disabled = !available || !uncertainRow;
      acknowledge.disabled = input.disabled || confirmedQuantity() === null;
      template.disabled = !available || !data.labels?.templates?.length;
      templateApply.disabled = template.disabled || hasPending || !changedTemplate() || !validDraft();
      byId('weigh-template-fields').querySelectorAll('input').forEach(function (control) {
        control.disabled = template.disabled;
      });
      scanner.readOnly = !available;
      scannerFocus.disabled = !available;
      manual.disabled = !available || !scanner.value.trim();
      write('weigh-manual', t(pendingScan?.barcode === scanner.value.trim() ? 'retryScan' : 'submitManual'));
      scannerStatus();
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
      updateSerial();
      updateJobs();
      updateLabelSettings();
      if (!audio && audioOn) wakeSound();
      renderSound();
      checkVerdictChange();
      updateNotice();
      updateControls();
    }

    async function action(name, payload, button, confirmation) {
      if (button.disabled) return false;
      if (confirmation && !await window.confirmFieldAction(t(confirmation), language)) return false;
      if (busy) return false;
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
        return response.ok;
      } catch (_) {
        notice = 'actionFailed';
        return false;
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
    pause.addEventListener('click', function () { action('pause', {}, pause, 'confirmPause'); });
    resume.addEventListener('click', function () { action('resume', {}, resume, 'confirmResume'); });
    cancel.addEventListener('click', function () { action('cancel_waiting', {}, cancel, 'confirmCancel'); });
    flush.addEventListener('click', function () { action('flush', {}, flush, 'confirmFlush'); });
    peel.addEventListener('click', function () { action('peel', {}, peel, 'confirmPeel'); });
    acknowledge.addEventListener('click', function () {
      action('acknowledge', {job_id: uncertainRow, confirmed_quantity: confirmedQuantity()}, acknowledge, 'confirmUncertain');
    });

    sound.addEventListener('click', function () {
      if (audioOn && audio?.state === 'running') audioOn = false;
      else {
        audioOn = true;
        wakeSound();
      }
      renderSound();
    });
    template.addEventListener('change', function () {
      setDraft();
      renderFields();
      updateControls();
    });
    templateApply.addEventListener('click', function () {
      action('template', {template_id: template.value, values: draft}, templateApply, 'confirmTemplate');
    });
    byId('weigh-older-jobs').addEventListener('click', function () {
      showOlderJobs = !showOlderJobs;
      updateJobs();
    });
    scannerFocus.addEventListener('click', function () { scanner.focus(); });
    scanner.addEventListener('focus', scannerStatus);
    scanner.addEventListener('blur', function () {
      pressedAt = [];
      scannerStatus();
    });
    window.addEventListener('focus', scannerStatus);
    window.addEventListener('blur', function () {
      pressedAt = [];
      scannerStatus();
    });
    document.addEventListener('visibilitychange', scannerStatus);
    scanner.addEventListener('input', function (_event) {
      if (pendingScan && scanner.value.trim() !== pendingScan.barcode) pendingScan = null;
      if (pressedAt.length !== scanner.value.length) pressedAt = [];
      updateControls();
    });
    scanner.addEventListener('keydown', function (event) {
      if (event.isComposing || !event.isTrusted || scanner.readOnly) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        submitScan(true);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat
                 && scanner.selectionStart === scanner.value.length && scanner.selectionEnd === scanner.value.length) {
        pressedAt.push(performance.now());
      } else if (event.key !== 'Shift') {
        pressedAt = [];
      }
    });
    byId('weigh-scan-form').addEventListener('submit', function (event) {
      event.preventDefault();
      submitScan(false);
    });

    return {render: render};
  };
})();
