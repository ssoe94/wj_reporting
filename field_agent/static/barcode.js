(function () {
  'use strict';

  const words = {
    ko: {
      title: '바코드 리더', group: '생산 제품군', production: '생산 모드', test: '시험 모드',
      toTest: '시험 모드로 전환', toProduction: '생산 모드로 전환',
      confirmTest: '시험 모드로 전환할까요? 이후 스캔은 시험 기록으로 저장됩니다.',
      confirmProduction: '생산 모드로 전환할까요? 이후 스캔은 생산 기록으로 저장됩니다.',
      confirmReset: '화면 카운터와 중복 판정 기준을 초기화할까요? 저장한 기록은 남습니다. 화면과 CSV는 새 구간을 표시합니다.',
      resetCounts: '현재 화면 집계',
      storageError: '저장 실패 · 저장되지 않은 스캔은 집계되지 않습니다.',
      stale: '로컬 연결을 다시 확인하는 중입니다. 표시된 값은 마지막으로 받은 상태입니다.',
      export: 'CSV 내보내기', csvScope: '현재 모드에서 마지막 초기화 이후 저장된 기록',
      reset: '카운터 초기화', settings: '설정·기록 관리', showRecent: '더 보기', hideRecent: '접기',
      apply: '설정 적용', cancelEdit: '편집 취소', unassigned: '미배정',
      scannerA: '스캐너 A', scannerB: '스캐너 B', lastInput: '마지막 입력',
      noInput: '입력 없음', open: '포트 연결됨', closed: '포트 연결 끊김',
      recent: '최근 스캔', time: '시각', barcode: '바코드', result: '판정',
      noRecords: '최근 스캔 기록이 없습니다.', sinceReset: '오늘 · 마지막 초기화 이후',
      ok: '정상', duplicate: '중복', error: '오류', lastResult: '최근 판정',
      invalid: '형식 오류', over21: '길이 초과', wrong_scanner_A: '스캐너 A 필요',
      wrong_scanner_B: '스캐너 B 필요', wrong_product_group: '제품군 불일치',
      scan_error: '입력 오류', scan_input_error: '입력 오류', decode: '문자 해석', partial: '불완전', oversize: '길이 초과',
      frameErrors: '입력 프레임 오류', soundOn: '소리 켜짐', soundOff: '소리 꺼짐',
      enableSound: '알림음 켜기', muteSound: '알림음 끄기',
      saved: '적용했습니다.', invalidAction: '설정을 적용할 수 없습니다. 제품군과 장치 배정을 확인하세요.',
      actionFailed: '저장 실패 · 적용하지 못했습니다. 연결과 저장 상태를 확인하세요.',
      exportFailed: 'CSV를 내보내지 못했습니다.', conflict: '다른 화면에서 설정이 바뀌었습니다. 편집 취소 후 다시 선택하세요.',
    },
    zh: {
      title: '条码读取', group: '生产产品组', production: '生产模式', test: '测试模式',
      toTest: '切换到测试模式', toProduction: '切换到生产模式',
      confirmTest: '是否切换到测试模式？后续扫描将记录为测试。',
      confirmProduction: '是否切换到生产模式？后续扫描将记录为生产。',
      confirmReset: '是否重置界面计数和重复判定起点？已保存的记录将保留。界面和 CSV 将显示重置后的新记录。',
      resetCounts: '当前界面计数',
      storageError: '保存失败 · 未保存的扫描不会计入统计。',
      stale: '正在重新连接本机。当前显示的是上次收到的状态。',
      export: '导出 CSV', csvScope: '当前模式下自上次重置以来保存的记录',
      reset: '重置计数', settings: '设置与记录管理', showRecent: '查看更多', hideRecent: '收起',
      apply: '应用设置', cancelEdit: '取消编辑', unassigned: '未分配',
      scannerA: '扫描器 A', scannerB: '扫描器 B', lastInput: '最后输入',
      noInput: '无输入', open: '端口已连接', closed: '端口已断开',
      recent: '最近扫描', time: '时间', barcode: '条码', result: '判定',
      noRecords: '暂无扫描记录。', sinceReset: '今日 · 自上次重置以来',
      ok: '正常', duplicate: '重复', error: '错误', lastResult: '最近判定',
      invalid: '格式错误', over21: '超出长度', wrong_scanner_A: '需用扫描器 A',
      wrong_scanner_B: '需用扫描器 B', wrong_product_group: '产品组不匹配',
      scan_error: '输入错误', scan_input_error: '输入错误', decode: '解码', partial: '不完整', oversize: '超出长度',
      frameErrors: '输入帧错误', soundOn: '声音已开启', soundOff: '声音已关闭',
      enableSound: '开启提示音', muteSound: '关闭提示音',
      saved: '已应用。', invalidAction: '无法应用设置。请检查产品组和设备分配。',
      actionFailed: '保存失败 · 未能应用。请检查连接和存储状态。',
      exportFailed: '未能导出 CSV。', conflict: '设置已在其他窗口更改。请取消编辑并重新选择。',
    },
  };

  const fieldKeys = ['group', 'A', 'B'];
  const lanes = ['A', 'B'];
  const outcomes = ['ok', 'duplicate', 'error'];
  const recentLimit = 6;
  const frameErrors = ['decode', 'partial', 'oversize'];
  const reasonCodes = ['duplicate', 'invalid', 'over21', 'wrong_scanner_A', 'wrong_scanner_B',
    'wrong_product_group', 'scan_error', 'scan_input_error'];
  const byId = document.getElementById.bind(document);
  const el = function (tag, text) {
    const item = document.createElement(tag);
    item.textContent = text;
    return item;
  };

  window.createBarcodeView = function (timestamp) {
    const section = byId('barcode');
    const track = byId('barcode-lanes');
    const settings = Object.fromEntries(fieldKeys.map(function (key) {
      return [key, byId('barcode-setting-' + key)];
    }));
    const ports = {};
    const save = byId('barcode-save');
    const summary = byId('barcode-settings-summary');
    const cancel = byId('barcode-cancel');
    const toggleMode = byId('barcode-toggle-mode');
    const reset = byId('barcode-reset');
    const exportCsv = byId('barcode-export');
    const sound = byId('barcode-sound');
    const modeBadge = byId('barcode-mode');
    const storage = byId('barcode-storage-error');
    const stale = byId('barcode-stale');
    const notice = byId('barcode-notice');
    const settingNotice = byId('barcode-setting-notice');
    const optionsCache = new WeakMap();
    const recordsCache = new WeakMap();
    let data, language, connection, draft, original, message, messageTarget, audio, alertSeq;
    let busy = false;
    let muted = false;
    try {
      muted = localStorage.getItem('wj-field-barcode-muted') === '1';
    } catch (_) { /* Optional operator preference. */ }

    lanes.forEach(function (name) {
      const lane = byId('barcode-lane-template').content.cloneNode(true);
      const panel = lane.querySelector('section');
      panel.id = 'barcode-lane-' + name;
      const heading = panel.querySelector('h3');
      heading.id = panel.id + '-title';
      heading.dataset.barcodeText = 'scanner' + name;
      panel.setAttribute('aria-labelledby', heading.id);
      const counts = panel.querySelector('.barcode-counts');
      const totals = {};
      outcomes.forEach(function (outcome) {
        const pair = el('div', '');
        pair.dataset.outcome = outcome;
        const term = el('dt', '');
        term.dataset.barcodeText = outcome;
        totals[outcome] = el('dd', '0');
        pair.append(term, totals[outcome]);
        counts.appendChild(pair);
      });
      const recent = panel.querySelector('tbody');
      const more = panel.querySelector('.barcode-history-toggle');
      recent.id = panel.id + '-records';
      more.setAttribute('aria-controls', recent.id);
      more.addEventListener('click', function () {
        ports[name].expanded = !ports[name].expanded;
        renderLane(name);
      });
      ports[name] = {
        device: panel.querySelector('.barcode-device'),
        lastInput: panel.querySelector('.barcode-last-input strong'),
        lastResult: panel.querySelector('.barcode-last-result'),
        totals: totals,
        frames: panel.querySelector('.barcode-frame-errors'),
        recent: recent,
        more: more,
        expanded: false,
      };
      track.appendChild(lane);
    });

    function t(key) {
      return words[language][key];
    }

    function outcomeText(status) {
      return status === 'ok' ? 'OK · ' + t('ok')
        : 'NG · ' + t(reasonCodes.includes(status) ? status : 'error');
    }

    function renderLane(name) {
      const current = (data.lanes || {})[name] || {};
      const block = ports[name];
      block.device.textContent = t(current.connected ? 'open' : 'closed') + (current.port ? ' · ' + current.port : '');
      block.device.dataset.state = current.connected ? 'connected' : 'disconnected';
      block.lastInput.textContent = current.last_input_at ? timestamp(current.last_input_at) : t('noInput');
      outcomes.forEach(function (key) {
        const amount = (current.counts || {})[key] || 0;
        block.totals[key].textContent = amount;
        block.totals[key].parentElement.dataset.active = String(amount > 0);
      });
      const frames = frameErrors.filter(function (key) { return (current.frame_errors || {})[key] > 0; });
      block.frames.hidden = !frames.length;
      if (frames.length) block.frames.textContent = t('frameErrors') + ' · ' + frames.map(function (key) {
        return t(key) + ' ' + current.frame_errors[key];
      }).join(' / ');

      const recent = current.recent || [];
      const expandable = recent.length > recentLimit;
      if (!expandable) block.expanded = false;
      const shown = block.expanded ? recent : recent.slice(0, recentLimit);
      const signature = JSON.stringify([language, recent.length, block.expanded, shown]);
      if (recordsCache.get(block.recent) === signature) return;
      recordsCache.set(block.recent, signature);
      block.recent.textContent = '';
      block.more.hidden = !expandable;
      block.more.setAttribute('aria-expanded', String(block.expanded));
      block.more.textContent = block.expanded ? t('hideRecent') : t('showRecent') + ' (' + recent.length + ')';
      if (!recent.length) {
        block.lastResult.textContent = t('lastResult') + ' · —';
        block.lastResult.dataset.result = 'none';
        const row = el('tr', '');
        const empty = el('td', t('noRecords'));
        empty.colSpan = 3;
        empty.className = 'muted';
        row.appendChild(empty);
        block.recent.appendChild(row);
      } else {
        block.lastResult.textContent = t('lastResult') + ' · ' + outcomeText(recent[0].status);
        block.lastResult.dataset.result = recent[0].status === 'ok' ? 'ok' : 'ng';
        shown.forEach(function (record) {
          const row = el('tr', '');
          row.dataset.result = record.status === 'ok' ? 'ok' : 'ng';
          const when = timestamp(record.time);
          const time = el('td', when.slice(-8));
          time.title = when;
          const barcode = el('td', record.barcode || '—');
          if (record.barcode) barcode.title = record.barcode;
          row.append(time, barcode, el('td', outcomeText(record.status)));
          block.recent.appendChild(row);
        });
      }
    }

    function sourceConfig() {
      return {
        group: data.production_group || '',
        A: (data.assignments || {}).A || '',
        B: (data.assignments || {}).B || '',
      };
    }

    function selection(select, value, choices) {
      const key = JSON.stringify(choices);
      if (optionsCache.get(select) !== key) {
        optionsCache.set(select, key);
        select.textContent = '';
        choices.forEach(function (choice) {
          const option = el('option', choice[1]);
          option.value = choice[0];
          select.appendChild(option);
        });
      }
      if (select.value !== value) select.value = value;
    }

    function renderConfig() {
      const source = sourceConfig();
      const groups = (data.groups || []).map(function (group) { return [group, group]; });
      const available = (data.ports || []).filter(function (port) { return port.id; })
        .map(function (port) { return [port.id, port.label || port.id]; });
      fieldKeys.forEach(function (key) {
        const value = draft && draft[key] !== original[key] ? draft[key] : source[key];
        const options = key === 'group' ? groups.slice() : [['', t('unassigned')]].concat(available);
        if (!options.some(function (option) { return option[0] === value; })) options.push([value, value || '—']);
        selection(settings[key], value, options);
        settings[key].disabled = busy || connection !== 'connected';
      });
      save.disabled = busy || connection !== 'connected' || !draft;
      cancel.disabled = busy || !draft;
    }

    function renderSound() {
      const on = !muted && audio && audio.state === 'running';
      sound.textContent = t(on ? 'soundOn' : 'soundOff');
      sound.title = t(on ? 'muteSound' : 'enableSound');
      sound.dataset.sound = on ? 'on' : 'off';
      sound.setAttribute('aria-pressed', String(Boolean(on)));
    }

    function initializeSound() {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (audio || !AudioContext || muted) return;
      try {
        audio = new AudioContext();
        audio.onstatechange = renderSound;
      } catch (_) { /* Remain visibly off when sound is unavailable. */ }
    }

    function signal() {
      if (muted || !audio || audio.state !== 'running') return;
      try {
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime;
        tone.type = 'sine';
        tone.frequency.value = 760;
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.14, start + 0.013);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.19);
        tone.connect(gain);
        gain.connect(audio.destination);
        tone.onended = function () { tone.disconnect(); gain.disconnect(); };
        tone.start(start);
        tone.stop(start + 0.20);
      } catch (_) {
        audio.close().catch(function () {});
        audio = undefined;
        renderSound();
      }
    }

    function soundOnNewAlert() {
      const next = data.alert && data.alert.seq;
      if (typeof next === 'number') {
        if (alertSeq !== undefined && next > alertSeq && data.alert.status !== 'ok') signal();
        alertSeq = next;
      } else if (alertSeq === undefined) {
        alertSeq = 0;
      }
    }

    function showNotice(key, target) {
      message = key;
      messageTarget = target;
      renderNotice();
    }

    function renderNotice() {
      const active = messageTarget === 'settings' ? settingNotice : notice;
      [notice, settingNotice].forEach(function (candidate) {
        candidate.hidden = !message || candidate !== active;
      });
      if (message) {
        const content = t(message);
        if (active.textContent !== content) active.textContent = content;
        active.dataset.kind = message === 'saved' ? 'success' : 'error';
      }
    }

    function renderControls() {
      stale.hidden = connection === 'connected';
      [toggleMode, reset, exportCsv].forEach(function (button) {
        button.disabled = busy || connection !== 'connected';
      });
      renderConfig();
    }

    function render(next, lang, status) {
      data = next;
      const langChanged = language !== lang;
      language = lang;
      connection = status;
      section.hidden = !data;
      if (!data) return;
      if (langChanged || !section.dataset.translated) {
        section.querySelectorAll('[data-barcode-text]').forEach(function (item) {
          item.textContent = t(item.dataset.barcodeText);
        });
        section.dataset.translated = 'true';
      }
      byId('barcode-group').textContent = data.production_group || '—';
      modeBadge.textContent = t(data.mode === 'test' ? 'test' : 'production');
      modeBadge.dataset.mode = data.mode;
      toggleMode.textContent = t(data.mode === 'test' ? 'toProduction' : 'toTest');
      exportCsv.title = t('csvScope');
      storage.hidden = !data.storage_error;
      lanes.forEach(renderLane);
      if (connection === 'connected') {
        initializeSound();
        soundOnNewAlert();
      }
      renderSound();
      renderNotice();
      renderControls();
    }

    async function action(name, payload) {
      if (busy || connection !== 'connected') return false;
      const focus = document.activeElement;
      const target = name === 'mode' ? undefined : 'settings';
      busy = true;
      renderControls();
      showNotice(null);
      try {
        const response = await fetch('/api/barcode/' + name + '/', {
          method: 'POST',
          mode: 'same-origin',
          headers: {'X-WJ-Local': '1', 'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          showNotice('saved', target);
          return true;
        }
        showNotice(response.status === 400 ? 'invalidAction' : 'actionFailed', target);
      } catch (_) {
        showNotice('actionFailed', target);
      } finally {
        busy = false;
        renderControls();
        if (focus instanceof HTMLButtonElement && !focus.disabled) focus.focus();
      }
      return false;
    }

    sound.addEventListener('click', function () {
      muted = !muted && audio && audio.state === 'running';
      try { localStorage.setItem('wj-field-barcode-muted', muted ? '1' : '0'); } catch (_) { /* Optional. */ }
      if (!muted) {
        initializeSound();
        if (audio) audio.resume().then(renderSound, renderSound);
      }
      renderSound();
    });
    toggleMode.addEventListener('click', async function () {
      const mode = data.mode === 'test' ? 'production' : 'test';
      if (await window.confirmFieldAction(t(mode === 'production' ? 'confirmProduction' : 'confirmTest'), language)) {
        action('mode', {mode: mode});
      }
    });
    reset.addEventListener('click', async function () {
      const rows = lanes.map(function (lane) {
        const counts = ((data.lanes || {})[lane] || {}).counts || {};
        const summary = outcomes.map(function (key) { return t(key) + ' ' + (counts[key] || 0); });
        return lane + ' · ' + summary.join(' / ');
      });
      const prompt = t('confirmReset') + '\n\n' + t('resetCounts') + '\n' + rows.join('\n');
      if (await window.confirmFieldAction(prompt, language)) action('reset', {});
    });
    fieldKeys.forEach(function (key) {
      settings[key].addEventListener('change', function () {
        if (!draft) {
          original = sourceConfig();
          draft = Object.assign({}, original);
        }
        draft[key] = settings[key].value;
        if (fieldKeys.every(function (name) { return draft[name] === original[name]; })) draft = undefined;
        renderConfig();
      });
    });
    cancel.addEventListener('click', function () {
      draft = undefined;
      showNotice(null);
      renderConfig();
    });
    save.addEventListener('click', async function () {
      if (!draft) return;
      const current = sourceConfig();
      const changed = fieldKeys.filter(function (key) { return draft[key] !== original[key]; });
      if (changed.some(function (key) { return current[key] !== original[key] && current[key] !== draft[key]; })) {
        showNotice('conflict', 'settings');
        return;
      }
      const payload = {};
      changed.forEach(function (key) {
        if (current[key] === draft[key]) return;
        if (key === 'group') payload.production_group = draft[key];
        else {
          if (!payload.assignments) payload.assignments = {};
          payload.assignments[key] = draft[key] || null;
        }
      });
      if (!Object.keys(payload).length || await action('config', payload)) {
        draft = undefined;
        renderConfig();
        if (document.activeElement === save) summary.focus();
      }
    });
    exportCsv.addEventListener('click', async function () {
      if (busy || connection !== 'connected') return;
      busy = true;
      renderControls();
      showNotice(null);
      try {
        const response = await fetch('/api/barcode/export.csv?lang=' + language, {
          mode: 'same-origin', headers: {'X-WJ-Local': '1'},
        });
        if (!response.ok) throw new Error('Export failed');
        const url = URL.createObjectURL(await response.blob());
        const link = el('a', '');
        link.href = url;
        link.download = 'barcode-records.csv';
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      } catch (_) {
        showNotice('exportFailed');
      } finally {
        busy = false;
        renderControls();
        if (!exportCsv.disabled && document.activeElement === document.body) exportCsv.focus();
      }
    });

    return {render: render};
  };
})();
