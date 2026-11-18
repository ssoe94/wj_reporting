(function () {
  'use strict';

  const words = {
    ko: {
      heading: '현장 에이전트', languageControl: '화면 언어', languageFailed: '화면 언어를 저장하지 못했습니다. 연결과 저장 상태를 확인하세요.',
      genericReason: '상태 코드의 세부 정보를 확인하세요.', healthControl: '현장 상태',
      clockSource: '시계', clockNormal: '정상', clockCheck: '확인 필요', clockUnknown: '비교 대기',
      clockWithin: '서버와 PC 시계 차이가 5분 이내입니다.',
      deviceSummary: '장치', deviceConnected: '연결', companion: '동반 앱',
      companionReady: '실행 확인', companionWaiting: '실행 대기', companionFailed: '실행 실패',
      companionReadyInfo: '동반 앱이 준비되었습니다.',
      companionWaitingInfo: '동반 앱이 준비되면 상태가 바뀝니다.',
      companionFailedInfo: '동반 앱 설정과 PC의 실행 상태를 확인하세요.',
      confirmTitle: '작업 확인', confirmAccept: '확인', confirmCancel: '취소',
      connecting: '로컬 연결 중', connected: '로컬 연결됨', disconnected: '로컬 재연결 중',
      station: '현장 PC', version: '버전', outbox: '전송', backup: '백업', pending: '미전송 건수',
      oldest: '가장 오래된 미전송', ack: '마지막 ACK', uploadState: '전송 상태', reason: '사유',
      heartbeat: '서버 상태 전송', backupState: '백업 상태', backupTime: '마지막 백업',
      backupAttempt: '최근 백업 시도', devices: '장치 및 마지막 입력', apps: '현장 앱',
      noDevices: '확인된 장치가 없습니다.', noApps: '활성 앱이 없습니다.', appSlot: '이 영역에 현장 앱 화면이 연결됩니다.',
      visionTitle: '비전 수집 현황', visionSource: '기록 수집', visionCoverage: '관측 범위', visionProcess: '실행기 확인',
      visionMode: '최근 모드', visionObserved: '읽기 확인', visionUnreadable: '읽기 오류',
      mode: '모드', appState: '앱 상태', work: '마지막 작업', timeZone: '상하이 시각',
      clock: function (amount, ahead) {
        return 'PC 시계가 서버보다 약 ' + amount + '분 ' + (ahead ? '빠릅니다.' : '느립니다.');
      },
    },
    zh: {
      heading: '现场代理', languageControl: '界面语言', languageFailed: '未能保存界面语言。请检查连接和存储状态。',
      genericReason: '请查看状态代码详情。', healthControl: '现场状态',
      clockSource: '时钟', clockNormal: '正常', clockCheck: '需核对', clockUnknown: '等待比对',
      clockWithin: '服务器与电脑的时差在 5 分钟内。',
      deviceSummary: '设备', deviceConnected: '已连接', companion: '配套程序',
      companionReady: '已启动', companionWaiting: '等待启动', companionFailed: '启动失败',
      companionReadyInfo: '配套程序已准备就绪。',
      companionWaitingInfo: '配套程序准备就绪后会更新状态。',
      companionFailedInfo: '请检查配套程序设置和电脑上的运行状态。',
      confirmTitle: '操作确认', confirmAccept: '确认', confirmCancel: '取消',
      connecting: '正在连接本机', connected: '本机已连接', disconnected: '正在重新连接本机',
      station: '现场电脑', version: '版本', outbox: '发送', backup: '备份', pending: '待发送条数',
      oldest: '最早待发时间', ack: '最后确认', uploadState: '发送状态', reason: '原因',
      heartbeat: '服务器状态上报', backupState: '备份状态', backupTime: '最后备份',
      backupAttempt: '最近备份尝试', devices: '设备和最后输入', apps: '现场程序',
      noDevices: '暂无已识别的设备。', noApps: '暂无活动程序。', appSlot: '现场程序的界面将在此处显示。',
      visionTitle: '视觉采集状态', visionSource: '记录采集', visionCoverage: '观测范围', visionProcess: '启动器确认',
      visionMode: '最近模式', visionObserved: '读取正常', visionUnreadable: '读取错误',
      mode: '模式', appState: '程序状态', work: '最后作业', timeZone: '上海时间',
      clock: function (amount, ahead) {
        return '电脑时钟比服务器约' + (ahead ? '快 ' : '慢 ') + amount + ' 分钟。';
      },
    },
  };

  const codes = {
    barcode: ['바코드 리더', '条码读取'], weigh_label: ['중량·라벨', '称重与标签'],
    vision_backcover: ['백커버 비전', '后盖视觉'], vision_capture: ['양면 촬영', '双面拍摄'],
    vision_uv: ['UV 배치 검사', 'UV 批次检查'], signal_light: ['신호등', '信号灯'],
    partial: ['부분 관측', '部分观测'], known: ['확인됨', '已确认'],
    A: ['스캐너 A', '扫描器 A'], B: ['스캐너 B', '扫描器 B'], W: ['무선 스캐너 W', '无线扫描器 W'],
    KEYBOARD: ['키보드', '键盘'], scale: ['저울', '电子秤'], printer: ['프린터', '打印机'], camera: ['카메라', '相机'],
    ready: ['전송 가능', '可以发送'], backoff: ['재시도 대기', '等待重试'],
    blocked: ['전송 차단', '发送受阻'], storage_pressure: ['저장 공간 부족', '存储空间不足'],
    running: ['실행 중', '运行中'], stopped: ['중지', '已停止'], fault: ['오류', '故障'],
    connected: ['연결됨', '已连接'], disconnected: ['연결 끊김', '已断开'], unknown: ['미확인', '未确认'],
    production: ['생산', '生产'], test: ['시험', '测试'], demo: ['데모', '演示'],
    preview: ['미리보기', '预览'], manual: ['수동', '手动'],
    completed: ['완료', '已完成'], failed: ['실패', '失败'], skipped: ['건너뜀', '已跳过'],
    pending: ['대기 중', '等待中'], idle: ['대기 중', '空闲'], waiting: ['대기 중', '等待中'],
    never: ['기록 없음', '无记录'],
    invalid_token: ['장비 자격을 확인하세요.', '请检查设备凭据。'],
    station_denied: ['PC 등록 상태를 확인하세요.', '请检查现场电脑登记状态。'],
    invalid_ack: ['응답의 수신 확인을 검증할 수 없습니다.', '无法验证服务器的接收确认。'],
    ack_mismatch: ['수신 확인이 보낸 묶음과 일치하지 않습니다.', '接收确认与已发送的批次不一致。'],
    heartbeat_ack_mismatch: ['서버 상태 전송 확인이 일치하지 않습니다.', '服务器状态上报确认不一致。'],
    batch_conflict: ['서버에 다른 내용의 묶음이 있습니다.', '服务器已有内容不同的批次。'],
    event_conflict: ['서버에 다른 내용의 이벤트가 있습니다.', '服务器已有内容不同的事件。'],
    connection_not_configured: ['연결 설정이 필요합니다.', '需要配置连接。'],
    network_error: ['서버와 통신하지 못했습니다.', '无法与服务器通信。'],
    invalid_payload: ['서버가 전송 데이터 형식을 거부했습니다.', '服务器拒绝了发送数据的格式。'],
    contract_unsupported: ['서버가 현장 프로토콜 버전을 지원하지 않습니다.', '服务器不支持现场协议版本。'],
    payload_too_large: ['전송 데이터가 서버 크기 제한을 넘습니다.', '发送数据超出服务器的大小限制。'],
    unsupported_media_type: ['서버가 전송 형식을 지원하지 않습니다.', '服务器不支持发送格式。'],
    local_payload_size: ['전송할 데이터가 묶음 크기 제한을 넘습니다.', '待发送数据超出批次大小限制。'],
    local_event_corrupt: ['로컬 이벤트 내용을 확인하세요.', '请检查本地事件内容。'],
    local_event_too_large: ['로컬 이벤트가 전송 크기 제한을 넘습니다.', '本地事件超出发送大小限制。'],
    unexpected_http_status: ['서버가 예상하지 못한 응답을 보냈습니다.', '服务器返回了非预期的响应。'],
    response_too_large: ['서버 응답의 크기가 제한을 넘습니다.', '服务器响应超出大小限制。'],
    redirect_refused: ['서버 주소를 확인하세요.', '请检查服务器地址。'],
    local_storage_error: ['로컬 원장을 확인하세요.', '请检查本地台账。'],
    local_outbox_corrupt: ['저장된 전송 묶음을 확인하세요.', '请检查本地存储的发送批次。'],
    disk_low: ['백업에 필요한 저장 공간이 부족합니다.', '备份所需磁盘空间不足。'],
    backup_io_failed: ['백업 파일을 완성하지 못했습니다.', '未能完成备份文件。'],
    backup_audit_unavailable: ['백업 결과를 원장에 저장하지 못했습니다.', '未能将备份结果写入台账。'],
  };

  const byId = document.getElementById.bind(document);
  const dialog = byId('field-confirmation');
  const confirmAccept = dialog.querySelector('[data-confirm-accept]');
  const confirmCancel = dialog.querySelector('[data-confirm-cancel]');
  confirmAccept.addEventListener('click', function () { dialog.close('accept'); });
  confirmCancel.addEventListener('click', function () { dialog.close('cancel'); });
  window.confirmFieldAction = function (message, lang) {
    if (dialog.open) return Promise.resolve(false);
    const labels = words[lang];
    byId('field-confirmation-title').textContent = labels.confirmTitle;
    byId('field-confirmation-message').textContent = message;
    confirmAccept.textContent = labels.confirmAccept;
    confirmCancel.textContent = labels.confirmCancel;
    dialog.returnValue = 'cancel';
    return new Promise(function (resolve) {
      dialog.addEventListener('close', function () { resolve(dialog.returnValue === 'accept'); }, { once: true });
      dialog.showModal();
    });
  };

  const localTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  let language = document.documentElement.lang === 'zh-Hans' ? 'zh' : 'ko';
  let languageBusy = false;
  let languageFailed = false;
  let state = {};
  let selectedApp = '';
  let expandedHealth = '';
  let connection = 'connecting';
  const barcodeView = window.createBarcodeView(timestamp);
  const weighView = window.createWeighView(timestamp, code);
  const healthButtons = Array.from(document.querySelectorAll('[data-health-chip]'));

  function text(key) {
    return words[language][key];
  }

  function code(value, fallback) {
    if (!value) return '—';
    const pair = Object.prototype.hasOwnProperty.call(codes, value) && codes[value];
    return pair ? pair[language === 'ko' ? 0 : 1] : (fallback || String(value));
  }

  function timestamp(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? localTime.format(date) : '—';
  }

  function node(type, value, klass) {
    const item = document.createElement(type);
    item.textContent = value;
    if (klass) item.className = klass;
    return item;
  }

  function entries(element, rows) {
    element.textContent = '';
    rows.forEach(function (row) {
      element.appendChild(node('dt', text(row[0])));
      const value = node('dd', row[1]);
      if (row[2]) value.title = row[2];
      element.appendChild(value);
    });
  }

  function renderConnection() {
    byId('connection').textContent = text(connection);
    byId('connection').dataset.state = connection;
  }

  function renderDeviceRows() {
    const panel = byId('devices');
    panel.textContent = '';
    const devices = state.devices || [];
    devices.forEach(function (device) {
      const row = node('div', '', 'device-row');
      const identity = node('span', code(device.app) + ' · ' + code(device.device));
      if (device.device) identity.title = device.device;
      const status = node('span', code(device.state), 'device-state');
      status.dataset.state = device.state || 'unknown';
      const inputTime = node('span', timestamp(device.last_input_at), 'muted');
      inputTime.title = text('timeZone');
      row.appendChild(identity);
      row.appendChild(status);
      row.appendChild(inputTime);
      panel.appendChild(row);
    });
    if (!devices.length) panel.appendChild(node('p', text('noDevices'), 'muted'));
  }

  function renderApps() {
    const tabs = byId('app-tabs');
    const panel = byId('app-panel');
    const apps = state.apps || [];
    const app = apps.find(function (candidate) { return candidate.app === selectedApp; }) || apps[0];
    selectedApp = app ? app.app : '';
    const focused = tabs.contains(document.activeElement) ? document.activeElement.dataset.app : '';
    tabs.textContent = '';
    panel.textContent = '';
    apps.forEach(function (candidate) {
      const button = node('button', code(candidate.app));
      button.type = 'button';
      button.dataset.app = candidate.app;
      button.setAttribute('aria-pressed', String(candidate.app === selectedApp));
      button.setAttribute('aria-controls', 'app-panel');
      button.addEventListener('click', function () {
        selectedApp = candidate.app;
        renderApps();
      });
      tabs.appendChild(button);
      if (focused === candidate.app) button.focus();
    });
    if (!app) {
      panel.appendChild(node('p', text('noApps'), 'muted'));
      return;
    }
    const details = node('dl', '');
    entries(details, [
      ['version', app.version || '—'],
      ['mode', code(app.mode), app.mode],
      ['appState', code(app.state), app.state],
      ['work', timestamp(app.last_work_at), text('timeZone')],
    ]);
    panel.appendChild(details);
    const hasWorkScreen = (app.app === 'barcode' && state.barcode) || (app.app === 'weigh_label' && state.weigh);
    if (!hasWorkScreen && !(state.vision || []).some(function (source) { return source.app === app.app; })) {
      panel.appendChild(node('p', text('appSlot'), 'muted'));
    }
  }

  function renderHealth() {
    const outbox = state.outbox || {};
    const backup = state.backup || {};
    const offset = state.clock_offset_seconds;
    const skewed = typeof offset === 'number' && Math.abs(offset) > 300;
    const devices = state.devices || [];
    const connected = devices.filter(function (device) { return device.state === 'connected'; }).length;
    const faulted = devices.some(function (device) { return device.state === 'fault'; });
    const disconnected = devices.some(function (device) { return device.state === 'disconnected'; });
    const layout = state.layout_status || {};
    const companionLabel = { ready: 'companionReady', waiting: 'companionWaiting', failed: 'companionFailed' }[layout.status];
    const chips = {
      outbox: [text('outbox'), code(outbox.state, code('unknown')), outbox.state === 'blocked' || outbox.state === 'storage_pressure'
        ? 'fault' : outbox.state === 'backoff' ? 'warning' : 'normal'],
      backup: [text('backup'), code(backup.state, code('unknown')), backup.state === 'failed'
        ? 'fault' : backup.state === 'skipped' ? 'warning' : 'normal'],
      clock: [text('clockSource'), text(skewed ? 'clockCheck' : typeof offset === 'number' ? 'clockNormal' : 'clockUnknown'),
        skewed ? 'warning' : 'normal'],
      devices: [text('deviceSummary'), devices.length ? connected + '/' + devices.length + ' ' + text('deviceConnected')
        : code('unknown'), faulted ? 'fault' : disconnected ? 'warning' : 'normal'],
    };
    if (companionLabel) {
      chips.companion = [text('companion'), text(companionLabel), layout.status === 'failed' ? 'fault'
        : layout.status === 'waiting' ? 'warning' : 'normal'];
    }
    if (!chips[expandedHealth]) expandedHealth = '';
    healthButtons.forEach(function (button) {
      const name = button.dataset.healthChip;
      const summary = chips[name];
      const active = name === expandedHealth;
      button.hidden = !summary;
      button.setAttribute('aria-expanded', String(active));
      if (summary) {
        button.textContent = summary[0] + ' · ' + summary[1];
        button.dataset.level = summary[2];
      }
      byId(button.getAttribute('aria-controls')).hidden = !active;
    });

    if (expandedHealth === 'outbox') {
      const rows = [
        ['uploadState', code(outbox.state), outbox.state],
        ['pending', typeof outbox.pending_count === 'number' ? String(outbox.pending_count) : '—'],
        ['oldest', timestamp(outbox.oldest_occurred_at), text('timeZone')],
        ['ack', timestamp(outbox.last_ack_at), text('timeZone')],
        ['reason', code(outbox.last_error_code, text('genericReason')), outbox.last_error_code],
      ];
      if (state.heartbeat_error) {
        rows.push(['heartbeat', code(state.heartbeat_error, text('genericReason')), state.heartbeat_error]);
      }
      entries(byId('outbox'), rows);
    } else if (expandedHealth === 'backup') {
      entries(byId('backup'), [
        ['backupState', code(backup.state), backup.state],
        [backup.state === 'completed' ? 'backupTime' : 'backupAttempt', timestamp(backup.finished_at), text('timeZone')],
        ['reason', code(backup.reason, text('genericReason')), backup.reason],
      ]);
    } else if (expandedHealth === 'clock') {
      const clock = byId('clock-warning');
      clock.classList.toggle('warning', skewed);
      clock.textContent = skewed ? words[language].clock(Math.round(Math.abs(offset) / 60), offset > 0)
        : text(typeof offset === 'number' ? 'clockWithin' : 'clockUnknown');
    } else if (expandedHealth === 'devices') {
      renderDeviceRows();
      renderApps();
    } else if (expandedHealth === 'companion') {
      byId('companion-status').textContent = text(companionLabel + 'Info');
      byId('companion-status').title = layout.code || '';
    }
  }

  let openedVision = false;

  function renderVision() {
    const view = byId('vision');
    const sources = state.vision || [];
    view.hidden = sources.length === 0;
    if (view.hidden) return;
    if (!openedVision) {
      view.open = !state.barcode && !state.weigh;
      openedVision = true;
    }
    const list = byId('vision-sources');
    list.textContent = '';
    sources.forEach(function (source) {
      const row = node('li', '');
      row.appendChild(node('strong', code(source.app)));
      const facts = node('dl', '');
      const health = source.state === 'fault' ? text('visionUnreadable')
        : source.state === 'running' ? text('visionObserved') : code('unknown');
      entries(facts, [
        ['visionSource', health],
        ['visionCoverage', code(source.coverage)],
        ['visionProcess', code(source.process)],
        ['visionMode', code(source.mode)],
        ['work', timestamp(source.last_work_at), text('timeZone')],
      ]);
      row.appendChild(facts);
      list.appendChild(row);
    });
  }

  function render() {
    document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'ko';
    document.title = text('heading');
    document.querySelectorAll('[data-text]').forEach(function (element) {
      element.textContent = text(element.dataset.text);
    });
    document.querySelectorAll('[data-aria-text]').forEach(function (element) {
      element.setAttribute('aria-label', text(element.dataset.ariaText));
    });
    document.querySelectorAll('[data-lang]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.lang === language));
      button.disabled = languageBusy;
    });
    const languageError = byId('language-error');
    languageError.hidden = !languageFailed;
    languageError.textContent = languageFailed ? text('languageFailed') : '';
    byId('station').textContent = text('station') + ' ' + (state.station_id || '—') + ' · ' + text('version') + ' ' + (state.agent_version || '—');
    renderConnection();
    renderHealth();
    renderVision();
    barcodeView.render(state.barcode, language, connection);
    weighView.render(state.weigh, language, connection);
  }

  healthButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      const name = button.dataset.healthChip;
      expandedHealth = name === expandedHealth ? '' : name;
      renderHealth();
    });
  });
  document.querySelectorAll('[data-lang]').forEach(function (button) {
    button.addEventListener('click', async function () {
      const requested = button.dataset.lang;
      if (languageBusy || (requested === language && !languageFailed)) return;
      languageBusy = true;
      languageFailed = false;
      render();
      try {
        const response = await fetch('/api/language/', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WJ-Local': '1' },
          body: JSON.stringify({ language: requested }),
        });
        if (!response.ok) throw new Error();
        // Stream updates are ordered across windows. If the stream is down,
        // apply the saved choice now and reconcile on the next snapshot.
        if (connection !== 'connected') language = requested;
      } catch (_) {
        languageFailed = true;
      } finally {
        languageBusy = false;
        render();
        // A disabled button may have briefly lost keyboard focus.
        if (document.activeElement === document.body) button.focus();
      }
    });
  });
  render();
  const stream = new EventSource('/api/events');
  stream.onopen = function () {
    connection = 'connected';
    renderConnection();
  };
  stream.onerror = function () {
    connection = 'disconnected';
    renderConnection();
    barcodeView.render(state.barcode, language, connection);
    weighView.render(state.weigh, language, connection);
  };
  stream.onmessage = function (event) {
    try {
      state = JSON.parse(event.data);
      if (state.language === 'ko' || state.language === 'zh') language = state.language;
      render();
    } catch (_) { /* Retain the last complete snapshot. */ }
  };
  window.addEventListener('pagehide', function (event) {
    if (!event.persisted) stream.close();
  });
})();
