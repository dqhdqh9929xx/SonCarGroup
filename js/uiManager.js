'use strict';
/* ── uiManager.js — Toasts, Modal, Collapsible, General UI ── */

const UI = (() => {
  /* ── Toast ── */
  function toast(msg, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${msg}</span>`;
    const container = document.getElementById('toast-container');
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('hiding');
      setTimeout(() => el.remove(), 320);
    }, duration);
  }

  /* ── API Key Modal — luôn hiện khi mở trang ── */
  function initApiKeyModal(onSave) {
    const backdrop = document.getElementById('modal-backdrop');
    const input    = document.getElementById('apikey-input');
    const btn      = document.getElementById('btn-save-apikey');

    // Pre-fill key đã lưu (nếu có) nhưng vẫn hiện modal để user xác nhận
    const savedKey = localStorage.getItem('vietmap_api_key') || '';
    input.value = savedKey;
    backdrop.classList.remove('hidden');   // luôn hiện

    // Không cho click backdrop đóng modal
    backdrop.addEventListener('click', e => e.stopPropagation());

    function save() {
      const key = input.value.trim();
      if (!key) {
        toast('Vui lòng nhập API key!', 'warn');
        input.focus();
        input.style.borderColor = '#ff5252';
        setTimeout(() => { input.style.borderColor = ''; }, 1800);
        return;
      }
      localStorage.setItem('vietmap_api_key', key);
      CONFIG.API_KEY = key;
      backdrop.classList.add('hidden');
      toast('✅ API key đã lưu! Sẵn sàng tìm đường.', 'success', 4000);
      onSave(key);
    }

    btn.addEventListener('click', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

    // Nút 🔑 header → mở lại modal
    const btnKey = document.getElementById('btn-change-key');
    if (btnKey) {
      btnKey.style.display = '';
      btnKey.addEventListener('click', () => {
        input.value = localStorage.getItem('vietmap_api_key') || '';
        backdrop.classList.remove('hidden');
      });
    }
  }

  /* ── Collapsible ── */
  function initCollapsible() {
    const trigger  = document.getElementById('settings-trigger');
    const body     = document.getElementById('settings-body');
    const chevron  = document.getElementById('settings-chevron');
    let open = false;

    // Start hidden
    body.style.maxHeight  = '0px';
    body.style.overflow   = 'hidden';
    body.style.transition = 'max-height .3s ease';
    body.style.display    = 'flex'; // keep flex but clipped by max-height

    trigger.addEventListener('click', () => {
      open = !open;
      if (open) {
        body.style.maxHeight = body.scrollHeight + 200 + 'px';
      } else {
        body.style.maxHeight = '0px';
      }
      chevron.classList.toggle('open', open);
    });
  }

  /* ── GA Settings Sliders (optional — elements may not exist) ── */
  function initSliders(onChange) {
    const genSlider = document.getElementById('ga-generations');
    const popSlider = document.getElementById('ga-population');
    const genVal    = document.getElementById('gen-val');
    const popVal    = document.getElementById('pop-val');

    if (!genSlider || !popSlider) return { getGenerations: () => 300, getPopulation: () => 150 };

    genSlider.addEventListener('input', () => {
      if (genVal) genVal.textContent = genSlider.value;
      onChange({ generations: +genSlider.value, population: +popSlider.value });
    });
    popSlider.addEventListener('input', () => {
      if (popVal) popVal.textContent = popSlider.value;
      onChange({ generations: +genSlider.value, population: +popSlider.value });
    });

    return {
      getGenerations: () => +genSlider.value,
      getPopulation:  () => +popSlider.value
    };
  }

  /* ── Vehicle Selector ── */
  function initVehicleSelector(onChange) {
    const btns = document.querySelectorAll('.veh-btn');
    let current = 'car';
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        current = btn.dataset.vehicle;
        onChange(current);
      });
    });
    return { getVehicle: () => current };
  }

  /* ── Optimize & Reset button state ── */
  function setOptimizeEnabled(enabled) {
    document.getElementById('btn-optimize').disabled = !enabled;
  }

  /* ── Progress panel ── */
  function showProgress(totalGen) {
    const panel = document.getElementById('progress-panel');
    panel.hidden = false;
    updateProgress(0, 0, '—', totalGen);
  }
  function hideProgress() { document.getElementById('progress-panel').hidden = true; }
  function updateProgress(gen, pct, best, totalGen) {
    document.getElementById('prog-gen-label').textContent = `${gen} / ${totalGen}`;
    document.getElementById('prog-fill').style.width  = pct + '%';
    document.getElementById('prog-pct').textContent   = pct + '%';
    document.getElementById('prog-best').textContent  = best;
  }

  /* ── Results panel (two-phase) ── */
  function showResults(distanceM, timeMs, origin, orderedB, orderedC) {
    const panel = document.getElementById('results-panel');
    panel.hidden = false;

    const km     = (distanceM / 1000).toFixed(1) + ' km';
    const min    = Math.round(timeMs / 60000);
    const timeStr = min >= 60 ? `${Math.floor(min/60)}g ${min%60}p` : `${min} phút`;

    document.getElementById('res-distance').textContent = km;
    document.getElementById('res-time').textContent     = timeStr;

    function buildSeq(seqEl, locations, labelFn, numClass) {
      seqEl.innerHTML = '';
      // Origin as first step
      if (locations.length > 0) {
        const originStep = document.createElement('div');
        originStep.className = 'route-step';
        originStep.innerHTML = `
          <div class="route-step-num" style="background:linear-gradient(135deg,#00d4ff,#0099cc)">A</div>
          <div class="route-step-name">${origin.address || 'Điểm xuất phát'}</div>`;
        seqEl.appendChild(originStep);
      }
      locations.forEach((loc, i) => {
        const arrow = document.createElement('div');
        arrow.className = 'route-step';
        arrow.innerHTML = `
          <div class="route-step-num ${numClass}">${labelFn(i)}</div>
          <div class="route-step-name">${loc.address || `Điểm ${i+1}`}</div>
          ${i < locations.length - 1 ? '<span class="route-step-arrow">▼</span>' : ''}`;
        seqEl.appendChild(arrow);
      });
    }

    const seqB    = document.getElementById('route-sequence-b');
    const seqC    = document.getElementById('route-sequence-c');
    const lblB    = document.getElementById('phase-b-label');
    const lblC    = document.getElementById('phase-c-label');

    // B phase
    if (orderedB.length > 0) {
      lblB.hidden = false;
      buildSeq(seqB, orderedB, i => `B${i+1}`, '');
    } else { lblB.hidden = true; seqB.innerHTML = ''; }

    // C phase
    if (orderedC.length > 0) {
      lblC.hidden = false;
      buildSeq(seqC, orderedC, i => `C${i+1}`, 'dropoff-num');
    } else { lblC.hidden = true; seqC.innerHTML = ''; }
  }
  function hideResults() { document.getElementById('results-panel').hidden = true; }


  /* ── Map hint ── */
  function setMapHint(text) { document.getElementById('map-hint').textContent = text; }

  /* ── Stop count badge ── */
  function updateStopCount(n) { document.getElementById('stop-count').textContent = n; }

  /* ── Map legend ── */
  function showLegend() { document.getElementById('map-legend').hidden = false; }

  return {
    toast, initApiKeyModal, initCollapsible,
    initSliders, initVehicleSelector,
    setOptimizeEnabled, showProgress, hideProgress, updateProgress,
    showResults, hideResults, setMapHint, updateStopCount, showLegend
  };
})();
