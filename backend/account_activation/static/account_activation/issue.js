(() => {
  'use strict';
  const clear = () => {
    const field = document.getElementById('activation-link');
    if (field) { field.value = ''; field.textContent = ''; field.hidden = true; }
  };
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', event => { if (event.persisted) clear(); });
})();
