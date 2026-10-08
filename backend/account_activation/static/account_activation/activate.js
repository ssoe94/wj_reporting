/* No browser storage, analytics, automatic retry or automatic login. */
(() => {
  'use strict';
  let token = window.location.hash.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  const form = document.getElementById('activation-form');
  const status = document.getElementById('status');
  const password = document.getElementById('password');
  const confirmation = document.getElementById('confirmation');
  const button = form.querySelector('button');
  let busy = false;
  if (!/^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(token)
      || window.location.protocol !== 'https:' || window.top !== window.self) {
    token = '';
    status.textContent = '사용할 수 없는 링크입니다. 담당 관리자에게 문의하세요.';
    return;
  }
  form.hidden = false;
  status.textContent = '';
  window.addEventListener('pagehide', () => {
    token = ''; password.value = ''; confirmation.value = ''; form.hidden = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) status.textContent = '페이지가 종료되었습니다. 새로 발급된 링크를 사용하세요.';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !token) return;
    busy = true; button.disabled = true;
    const body = new URLSearchParams({token, password: password.value, confirmation: confirmation.value});
    password.value = ''; confirmation.value = '';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(window.location.pathname, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: {'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': form.querySelector('[name=csrfmiddlewaretoken]').value},
        body, signal: controller.signal,
      });
      const result = response.ok ? await response.json() : null;
      if (result && result.status === 'password_invalid') {
        status.textContent = '비밀번호가 일치하고 보안 규칙을 충족하는지 확인하세요.';
        button.disabled = false;
      } else {
        token = ''; form.hidden = true;
        if (result && result.status === 'activated') {
          status.textContent = ''; document.getElementById('done').hidden = false;
        } else status.textContent = '링크를 사용할 수 없습니다. 담당 관리자에게 문의하세요.';
      }
    } catch (_) {
      token = ''; form.hidden = true;
      status.textContent = '처리 결과를 확인할 수 없습니다. 자동 재시도하지 않습니다. 담당 관리자에게 확인하세요.';
    } finally {
      body.delete('token'); body.delete('password'); body.delete('confirmation');
      window.clearTimeout(timeout); busy = false;
    }
  });
})();
