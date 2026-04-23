'use strict';
/* ── app.js — Main Controller: Two-Phase Route (A → B* → C*) ── */

/* ── Helper: position suggestion dropdown as fixed ── */
function positionSugBox(input, sugBox) {
  const rect = input.getBoundingClientRect();
  sugBox.style.top   = (rect.bottom + 4) + 'px';
  sugBox.style.left  = rect.left + 'px';
  sugBox.style.width = rect.width + 'px';
}

const App = (() => {

  // ── State ──
  const state = {
    origin:    null,   // { lat, lng, address, role:'origin' }
    stops:     [],     // B stops: [{ id, lat, lng, address }, ...]
    dropoffs:  [],     // C stops: [{ id, lat, lng, address }, ...]
    vehicle:   'car',
    gaParams:  { ...CONFIG.GA },
    running:   false,
    clickMode: 'origin', // 'origin' | 'stop-{id}' | 'dropoff-{id}'
    nextStopId: 0,
    nextDropoffId: 0
  };
  let debounceTimers = {};

  // ── Init ──
  function init() {
    MapManager.init(CONFIG.API_KEY || '', onMapClick);
    // API key đã khóa cứng trong js/secrets.js — không cần modal nhập key
    UI.initCollapsible();
    UI.initVehicleSelector(v => { state.vehicle = v; });

    document.getElementById('btn-add-stop').addEventListener('click', () => addStopRow());
    document.getElementById('btn-add-dropoff').addEventListener('click', () => addDropoffRow());
    document.getElementById('btn-optimize').addEventListener('click', runOptimize);
    document.getElementById('btn-reset').addEventListener('click', resetAll);

    setupInputAutocomplete(
      document.getElementById('origin-input'),
      document.getElementById('origin-suggestions'),
      'origin'
    );

    document.getElementById('btn-origin-gps').addEventListener('click', () => {
      if (!navigator.geolocation) { UI.toast('Trình duyệt không hỗ trợ GPS','warn'); return; }
      navigator.geolocation.getCurrentPosition(
        pos => placeOrigin(pos.coords.longitude, pos.coords.latitude),
        ()  => UI.toast('Không lấy được vị trí GPS','error')
      );
    });

    UI.setMapHint('💡 Click bản đồ để đặt điểm xuất phát');
  }

  // ── Map click ──
  function onMapClick(lng, lat) {
    if (state.clickMode === 'origin') {
      placeOrigin(lng, lat);
    } else if (state.clickMode && state.clickMode.startsWith('stop-')) {
      placeStop(state.clickMode.replace('stop-',''), lng, lat);
      state.clickMode = null;
      UI.setMapHint('💡 Click bản đồ để thêm điểm');
    } else if (state.clickMode && state.clickMode.startsWith('dropoff-')) {
      placeDropoff(state.clickMode.replace('dropoff-',''), lng, lat);
      state.clickMode = null;
      UI.setMapHint('💡 Click bản đồ để thêm điểm');
    }
  }

  // ── Auto-compute GA params based on total number of stops ──
  function autoGAParams(n) {
    // Tiered: more stops → larger population & more generations
    let pop, gen;
    if (n <= 3)       { pop =  60; gen = 120; }
    else if (n <= 6)  { pop = 100; gen = 200; }
    else if (n <= 10) { pop = 150; gen = 300; }
    else if (n <= 15) { pop = 200; gen = 450; }
    else if (n <= 20) { pop = 250; gen = 550; }
    else              { pop = 300; gen = 700; }

    // Update display labels
    const genEl = document.getElementById('ga-gen-display');
    const popEl = document.getElementById('ga-pop-display');
    if (genEl) genEl.textContent = gen;
    if (popEl) popEl.textContent = pop;

    return { MAX_GENERATIONS: gen, POPULATION_SIZE: pop };
  }

  // ── Normalize search result item → { lat, lng, address } ──
  function normalizeItem(item) {
    const lat = item.lat      ?? item.latitude
               ?? item.geometry?.coordinates?.[1] ?? null;
    const lng = item.lng      ?? item.longitude
               ?? item.geometry?.coordinates?.[0] ?? null;
    const address = item.display || item.name || item.properties?.name || '';
    return {
      lat: lat != null ? parseFloat(lat) : null,
      lng: lng != null ? parseFloat(lng) : null,
      address
    };
  }

  // ── Get valid coords: from item directly OR via place detail API ──
  async function resolveCoords(item) {
    let { lat, lng, address } = normalizeItem(item);
    // If lat/lng are valid numbers, use them directly
    if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
      return { lat, lng, address };
    }
    // Try place detail API using ref_id
    const refId = item.ref_id || item.id || item.properties?.ref_id;
    if (refId) {
      const detail = await RouteManager.getPlaceDetail(refId);
      if (detail && !isNaN(detail.lat) && !isNaN(detail.lng)) {
        return { lat: detail.lat, lng: detail.lng, address: detail.address || address };
      }
    }
    return null;
  }

  // ── Place origin ──
  async function placeOrigin(lng, lat, address = null) {
    const label = address || await RouteManager.reverseGeocode(lat, lng);
    state.origin = { lat, lng, address: label, role: 'origin' };
    const inp = document.getElementById('origin-input');
    inp.value = label;
    inp.title = label;
    MapManager.setOriginMarker(lng, lat, 'A');
    state.clickMode = null;
    UI.setMapHint('💡 Click bản đồ để thêm điểm dừng / trả khách');
    UI.showLegend();
    checkOptimizeReady();
  }

  // ── Place B stop ──
  async function placeStop(id, lng, lat, address = null) {
    const label = address || await RouteManager.reverseGeocode(lat, lng);
    const idx = state.stops.findIndex(s => s.id === id);
    if (idx === -1) return;
    state.stops[idx] = { ...state.stops[idx], lat, lng, address: label };
    updateDisplay(`stop-item-${id}`, `stop-input-${id}`, label);
    MapManager.setStopMarker(`stop-${id}`, lng, lat, String(idx+1));
    checkOptimizeReady();
  }

  // ── Place C dropoff ──
  async function placeDropoff(id, lng, lat, address = null) {
    const label = address || await RouteManager.reverseGeocode(lat, lng);
    const idx = state.dropoffs.findIndex(d => d.id === id);
    if (idx === -1) return;
    state.dropoffs[idx] = { ...state.dropoffs[idx], lat, lng, address: label };
    updateDisplay(`dropoff-item-${id}`, `dropoff-input-${id}`, label);
    MapManager.setDropoffMarker(`dropoff-${id}`, lng, lat, `C${idx+1}`);
    checkOptimizeReady();
  }

  // ── Show selected address as wrapped label, hide input ──
  function updateDisplay(itemId, inputId, address) {
    const item  = document.getElementById(itemId);
    const input = document.getElementById(inputId);
    if (!item || !input) return;

    input.style.display = 'none';

    let label = item.querySelector('.addr-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'addr-label';
      // Click label → switch back to edit mode
      label.addEventListener('click', () => {
        label.style.display = 'none';
        input.style.display = '';
        input.value = '';
        input.focus();
      });
      input.parentNode.appendChild(label);
    }
    label.textContent = address;
    label.title = address;
    label.style.display = '';
  }

  // ── Add B stop row ──
  function addStopRow(prefill = null) {
    const id = String(state.nextStopId++);
    state.stops.push({ id, lat: null, lng: null, address: '' });
    document.getElementById('stops-empty')?.remove();

    const list = document.getElementById('stops-list');
    const item = document.createElement('div');
    item.className = 'stop-item'; item.id = `stop-item-${id}`;
    item.innerHTML = `
      <div class="stop-num">${state.stops.length}</div>
      <div style="flex:1;position:relative;">
        <input type="text" id="stop-input-${id}" class="stop-input"
          placeholder="Nhập địa chỉ điểm đón khách..." autocomplete="off"
          value="${prefill ? prefill.replace(/"/g,'&quot;') : ''}"/>
        <div class="suggestions-box" id="stop-sug-${id}"></div>
      </div>
      <button class="btn-icon-sm" id="stop-pin-${id}" style="position:static;transform:none;font-size:.85rem;" title="Click bản đồ">📍</button>
      <button class="stop-del" id="stop-del-${id}">✕</button>`;
    list.appendChild(item);

    setupInputAutocomplete(document.getElementById(`stop-input-${id}`), document.getElementById(`stop-sug-${id}`), `stop:${id}`);
    document.getElementById(`stop-pin-${id}`).addEventListener('click', () => {
      state.clickMode = `stop-${id}`;
      UI.setMapHint(`📍 Click bản đồ để chọn điểm B${state.stops.findIndex(s=>s.id===id)+1}`);
    });
    document.getElementById(`stop-del-${id}`).addEventListener('click', () => removeStop(id));
    UI.updateStopCount(state.stops.length);
    checkOptimizeReady();
  }

  // ── Add C dropoff row ──
  function addDropoffRow(prefill = null) {
    const id = String(state.nextDropoffId++);
    state.dropoffs.push({ id, lat: null, lng: null, address: '' });
    document.getElementById('dropoffs-empty')?.remove();

    const list = document.getElementById('dropoffs-list');
    const item = document.createElement('div');
    item.className = 'dropoff-item'; item.id = `dropoff-item-${id}`;
    item.innerHTML = `
      <div class="dropoff-num">C${state.dropoffs.length}</div>
      <div style="flex:1;position:relative;">
        <input type="text" id="dropoff-input-${id}" class="stop-input"
          placeholder="Nhập địa chỉ điểm trả khách..." autocomplete="off"
          value="${prefill ? prefill.replace(/"/g,'&quot;') : ''}"/>
        <div class="suggestions-box" id="dropoff-sug-${id}"></div>
      </div>
      <button class="btn-icon-sm" id="dropoff-pin-${id}" style="position:static;transform:none;font-size:.85rem;" title="Click bản đồ">📍</button>
      <button class="stop-del" id="dropoff-del-${id}">✕</button>`;
    list.appendChild(item);

    setupInputAutocomplete(document.getElementById(`dropoff-input-${id}`), document.getElementById(`dropoff-sug-${id}`), `dropoff:${id}`);
    document.getElementById(`dropoff-pin-${id}`).addEventListener('click', () => {
      state.clickMode = `dropoff-${id}`;
      UI.setMapHint(`📍 Click bản đồ để chọn điểm C${state.dropoffs.findIndex(d=>d.id===id)+1}`);
    });
    document.getElementById(`dropoff-del-${id}`).addEventListener('click', () => removeDropoff(id));

    document.getElementById('dropoff-count').textContent = state.dropoffs.length;
    checkOptimizeReady();
  }

  // ── Remove B stop ──
  function removeStop(id) {
    const idx = state.stops.findIndex(s => s.id === id);
    if (idx === -1) return;
    state.stops.splice(idx, 1);
    document.getElementById(`stop-item-${id}`)?.remove();
    MapManager.removeStopMarker(`stop-${id}`);
    state.stops.forEach((s, i) => {
      document.querySelector(`#stop-item-${s.id} .stop-num`).textContent = i+1;
      if (s.lat) MapManager.setStopMarker(`stop-${s.id}`, s.lng, s.lat, String(i+1));
    });
    if (!state.stops.length) document.getElementById('stops-list').innerHTML =
      `<div class="stops-empty" id="stops-empty"><span>Chưa có điểm đón khách</span><br/><small>Nhấn "+ Thêm" hoặc click bản đồ</small></div>`;
    UI.updateStopCount(state.stops.length);
    checkOptimizeReady();
  }

  // ── Remove C dropoff ──
  function removeDropoff(id) {
    const idx = state.dropoffs.findIndex(d => d.id === id);
    if (idx === -1) return;
    state.dropoffs.splice(idx, 1);
    document.getElementById(`dropoff-item-${id}`)?.remove();
    MapManager.removeStopMarker(`dropoff-${id}`);
    state.dropoffs.forEach((d, i) => {
      document.querySelector(`#dropoff-item-${d.id} .dropoff-num`).textContent = `C${i+1}`;
      if (d.lat) MapManager.setDropoffMarker(`dropoff-${d.id}`, d.lng, d.lat, `C${i+1}`);
    });
    if (!state.dropoffs.length) document.getElementById('dropoffs-list').innerHTML =
      `<div class="stops-empty" id="dropoffs-empty"><span>Chưa có điểm trả khách</span><br/><small>Nhấn "+ Thêm" hoặc click bản đồ</small></div>`;
    document.getElementById('dropoff-count').textContent = state.dropoffs.length;
    checkOptimizeReady();
  }

  // ── Autocomplete setup ──
  function setupInputAutocomplete(input, sugBox, roleKey) {
    input.addEventListener('input', () => {
      clearTimeout(debounceTimers[roleKey]);
      const val = input.value.trim();
      if (val.length < 2) { sugBox.classList.remove('open'); return; }
      debounceTimers[roleKey] = setTimeout(async () => {
        const c = state.origin
          ? [state.origin.lat, state.origin.lng]
          : [CONFIG.DEFAULT_CENTER[1], CONFIG.DEFAULT_CENTER[0]];
        const results = await RouteManager.searchAddress(val, c[0], c[1]);
        positionSugBox(input, sugBox);
        renderSuggestions(sugBox, results, async item => {
          // ── 1. Fill text + close dropdown IMMEDIATELY ──
          const display = item.display || item.name || item.properties?.name || '';
          input.value = display;
          sugBox.classList.remove('open');

          // ── 2. Resolve coordinates (direct or via detail API) ──
          const coords = await resolveCoords(item);
          if (!coords) {
            UI.toast('Không lấy được tọa độ địa điểm này', 'warn');
            return;
          }
          const { lat, lng, address } = coords;
          input.value = address || display;

          // ── 3. Place marker ──
          if (roleKey === 'origin') {
            placeOrigin(lng, lat, address || display);
          } else if (roleKey.startsWith('stop:')) {
            placeStop(roleKey.replace('stop:',''), lng, lat, address || display);
          } else if (roleKey.startsWith('dropoff:')) {
            placeDropoff(roleKey.replace('dropoff:',''), lng, lat, address || display);
          }
        });
      }, 350);
    });
    input.addEventListener('blur',  () => setTimeout(() => sugBox.classList.remove('open'), 200));
    input.addEventListener('focus', () => {
      if (sugBox.children.length) { positionSugBox(input, sugBox); sugBox.classList.add('open'); }
    });
    document.querySelector('.sidebar-scroll')?.addEventListener('scroll', () => {
      if (sugBox.classList.contains('open')) positionSugBox(input, sugBox);
    }, { passive: true });
  }

  // ── Render suggestions dropdown ──
  function renderSuggestions(box, results, onSelect) {
    box.innerHTML = '';
    if (!results || !results.length) { box.classList.remove('open'); return; }
    results.slice(0, 8).forEach(item => {
      const display = item.display || item.name || item.properties?.name || '';
      const sub     = item.ref_id   || item.address || '';
      const div     = document.createElement('div');
      div.className = 'suggestion-item';
      div.innerHTML = `
        <span class="suggestion-icon">📍</span>
        <div>
          <div class="suggestion-main">${display}</div>
          ${sub ? `<div class="suggestion-sub">${sub}</div>` : ''}
        </div>`;
      div.addEventListener('mousedown', e => { e.preventDefault(); onSelect(item); });
      box.appendChild(div);
    });
    box.classList.add('open');
  }

  // ── Nearby suggestions ──
  function showNearbyFor(lat, lng) {
    NearbyManager.renderCategoryChips(lat, lng, async catKey => {
      NearbyManager.showLoading();
      const res = await NearbyManager.searchNearby(lat, lng, catKey);
      NearbyManager.renderPanel(res, lat, lng, place => {
        addStopRow(place.name);
        const newId = String(state.nextStopId - 1);
        const idx = state.stops.findIndex(s => s.id === newId);
        if (idx !== -1) {
          state.stops[idx] = { ...state.stops[idx], lat: place.lat, lng: place.lng, address: place.name };
          MapManager.setStopMarker(`stop-${newId}`, place.lng, place.lat, String(idx+1));
          checkOptimizeReady();
        }
        UI.toast(`Đã thêm: ${place.name}`, 'success', 2000);
      });
    });
    NearbyManager.showChips();
    NearbyManager.showLoading();
    NearbyManager.searchNearby(lat, lng, 'cafe').then(res => {
      NearbyManager.renderPanel(res, lat, lng, place => {
        addStopRow(place.name);
        const newId = String(state.nextStopId - 1);
        const idx = state.stops.findIndex(s => s.id === newId);
        if (idx !== -1) {
          state.stops[idx] = { ...state.stops[idx], lat: place.lat, lng: place.lng, address: place.name };
          MapManager.setStopMarker(`stop-${newId}`, place.lng, place.lat, String(idx+1));
          checkOptimizeReady();
        }
        UI.toast(`Đã thêm: ${place.name}`, 'success', 2000);
      });
    });
    setTimeout(() => {
      const chip = document.querySelector('#nearby-chips .chip[data-key="cafe"]');
      if (chip) { document.querySelectorAll('#nearby-chips .chip').forEach(c=>c.classList.remove('active')); chip.classList.add('active'); }
    }, 80);
  }

  // ── Check optimize button state ──
  function checkOptimizeReady() {
    const hasOrigin = state.origin?.lat != null;
    const validB    = state.stops.filter(s => s.lat != null);
    const validC    = state.dropoffs.filter(d => d.lat != null);
    UI.setOptimizeEnabled(hasOrigin && (validB.length + validC.length) >= 1 && !state.running);
  }

  // ── Main Two-Phase Optimize ──
  async function runOptimize() {
    if (state.running) return;
    state.running = true;
    UI.setOptimizeEnabled(false);
    UI.hideResults();

    const validB = state.stops.filter(s => s.lat != null);
    const validC = state.dropoffs.filter(d => d.lat != null);

    if (!state.origin || (validB.length + validC.length) < 1) {
      UI.toast('Cần ít nhất 1 điểm dừng hoặc điểm trả khách!','warn');
      state.running = false; checkOptimizeReady(); return;
    }

    const nb = validB.length, nc = validC.length;
    const autoParams = autoGAParams(nb + nc);
    const totalGen = autoParams.MAX_GENERATIONS;

    try {
      // Build full matrix: [A, B1..Bn, C1..Cm]
      const allLocs = [state.origin, ...validB, ...validC];
      UI.toast('Đang lấy ma trận khoảng cách...','info',2000);
      const { matrix, source } = await MatrixManager.fetchMatrix(allLocs, state.vehicle);
      if (source === 'haversine') UI.toast('Dùng khoảng cách đường thẳng (Matrix API không khả dụng)','warn');

      // Run two-phase GA
      UI.showProgress(totalGen);
      UI.toast('🧬 Đang chạy Genetic Algorithm (2 pha)...','info',1500);
      const gaParams = { ...state.gaParams, ...autoParams };

      const { bestRoute } = await GeneticAlgorithm.optimize(
        matrix, nb, nc, gaParams,
        ({ gen, pct, bestCost: bc }) => {
          const costStr = bc < 1000 ? `${bc} m` : `${(bc/1000).toFixed(1)} km`;
          UI.updateProgress(gen, pct, costStr, totalGen);
        }
      );

      UI.hideProgress();

      // Reconstruct ordered B and C
      const orderedB = bestRoute.slice(0, nb).map(i => validB[i]);
      const orderedC = bestRoute.slice(nb).map(j => validC[j]);
      const fullRoute = [state.origin, ...orderedB, ...orderedC];

      // Fetch real route
      UI.toast('Đang tính toán đường đi...','info',2000);
      const { distance, time, coords } = await RouteManager.fetchRoute(fullRoute, state.vehicle);

      // Draw map
      MapManager.clearRoute();
      MapManager.drawRoute(coords);
      MapManager.animateRoute();
      MapManager.setOptimizedMarkers(orderedB, orderedC);
      MapManager.fitToBounds(fullRoute);

      // Show results (two-phase)
      UI.showResults(distance, time, state.origin, orderedB, orderedC);
      UI.toast('✅ Tối ưu xong!','success',4000);

    } catch (err) {
      UI.hideProgress();
      UI.toast(`Lỗi: ${err.message}`,'error');
      console.error('[App]', err);
    } finally {
      state.running = false;
      checkOptimizeReady();
    }
  }

  // ── Reset ──
  function resetAll() {
    GeneticAlgorithm.cancel();
    Object.assign(state, {
      origin: null, stops: [], dropoffs: [], running: false,
      clickMode: 'origin', nextStopId: 0, nextDropoffId: 0
    });

    document.getElementById('origin-input').value = '';
    document.getElementById('stops-list').innerHTML =
      `<div class="stops-empty" id="stops-empty"><span>Chưa có điểm đón khách</span><br/><small>Nhấn "+ Thêm" hoặc click bản đồ</small></div>`;
    document.getElementById('dropoffs-list').innerHTML =
      `<div class="stops-empty" id="dropoffs-empty"><span>Chưa có điểm trả khách</span><br/><small>Nhấn "+ Thêm" hoặc click bản đồ</small></div>`;

    MapManager.reset();
    NearbyManager.hidePanel();
    UI.hideProgress(); UI.hideResults();
    UI.updateStopCount(0);
    document.getElementById('dropoff-count').textContent = '0';
    UI.setOptimizeEnabled(false);
    UI.setMapHint('💡 Click bản đồ để đặt điểm xuất phát');
    UI.toast('Đã làm mới ứng dụng','info');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
