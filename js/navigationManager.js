'use strict';
/* ── navigationManager.js – Dẫn đường thời gian thực ──
   Luồng: start() → watchPosition → snapToRoute → updateHUD → reroute nếu lệch
*/

const NavigationManager = (() => {

  /* ─── Mapping sign → icon unicode + label ─── */
  const SIGN_MAP = {
    '-3': { icon: '↰', label: 'Rẽ trái gắt' },
    '-2': { icon: '←', label: 'Rẽ trái' },
    '-1': { icon: '↖', label: 'Hơi rẽ trái' },
     '0': { icon: '↑', label: 'Đi thẳng' },
     '1': { icon: '↗', label: 'Hơi rẽ phải' },
     '2': { icon: '→', label: 'Rẽ phải' },
     '3': { icon: '↱', label: 'Rẽ phải gắt' },
     '4': { icon: '🏁', label: 'Đã đến nơi' },
     '5': { icon: '🔴', label: 'Điểm dừng' },
     '6': { icon: '⭕', label: 'Vòng xoay' },
    '-7': { icon: '↙', label: 'Giữ bên trái' },
     '7': { icon: '↘', label: 'Giữ bên phải' },
  };

  /* ─── Constants ─── */
  const OFF_ROUTE_DIST    = 50;
  const OFF_ROUTE_SECS    = 4;
  const STEP_ADVANCE_DIST = 25;

  /* ─── State ─── */
  let _instructions    = [];
  let _coords          = [];
  let _waypoints       = [];
  let _stepIdx         = 0;
  let _watchId         = null;
  let _offRouteStart   = null;
  let _reroutingActive = false;
  let _active          = false;
  let _onExitCb        = null;
  let _lastUserPos     = null;
  let _totalDist       = 0;
  let _elapsedDist     = 0;

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function snapToRoute(userLng, userLat, coords) {
    let minDist = Infinity;
    let bestLat = userLat, bestLng = userLng, bestSeg = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = ((userLng - x1) * dx + (userLat - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }
      const projLng = x1 + t * dx;
      const projLat = y1 + t * dy;
      const d = haversine(userLat, userLng, projLat, projLng);
      if (d < minDist) { minDist = d; bestLat = projLat; bestLng = projLng; bestSeg = i; }
    }
    return { lat: bestLat, lng: bestLng, distToRoute: minDist, segIdx: bestSeg };
  }

  function bearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }
  function fmtTime(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} phút`;
    return `${Math.floor(min / 60)}g ${min % 60}p`;
  }

  function updateHUD(step, distToStep) {
    const info = SIGN_MAP[String(step.sign)] || SIGN_MAP['0'];
    const iconEl   = document.getElementById('nav-turn-icon');
    const distEl   = document.getElementById('nav-dist');
    const streetEl = document.getElementById('nav-street');
    const remEl    = document.getElementById('nav-remain-dist');
    const etaEl    = document.getElementById('nav-eta');
    if (iconEl)   iconEl.textContent   = info.icon;
    if (distEl)   distEl.textContent   = fmtDist(distToStep);
    if (streetEl) streetEl.textContent = step.streetName
      ? `${info.label} vào ${step.streetName}` : info.label;
    const remaining = Math.max(0, _totalDist - _elapsedDist);
    if (remEl) remEl.textContent = fmtDist(remaining);
    if (etaEl) {
      const now = new Date();
      const remainMs = (remaining / 1000 / 30) * 3600000;
      const eta = new Date(now.getTime() + remainMs);
      etaEl.textContent = eta.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    }
  }

  function showArrived() {
    const iconEl   = document.getElementById('nav-turn-icon');
    const distEl   = document.getElementById('nav-dist');
    const streetEl = document.getElementById('nav-street');
    if (iconEl)   iconEl.textContent   = '🏁';
    if (distEl)   distEl.textContent   = '0 m';
    if (streetEl) streetEl.textContent = 'Đã đến nơi!';
    setTimeout(() => stop(), 4000);
  }

  function updateSpeed(speedMps) {
    const el = document.getElementById('nav-speed');
    if (el) el.textContent = speedMps != null ? Math.round(speedMps * 3.6) : '–';
  }

  function setRerouting(active) {
    const el = document.getElementById('nav-rerouting');
    if (el) el.hidden = !active;
    _reroutingActive = active;
  }

  async function reroute(userLat, userLng) {
    if (_reroutingActive) return;
    setRerouting(true);
    try {
      const userLoc = { lat: userLat, lng: userLng };
      const remaining = [userLoc, ..._waypoints];
      const result = await RouteManager.fetchRoute(remaining, 'car');
      _coords = result.coords;
      _instructions = result.instructions;
      _totalDist = result.distance;
      _elapsedDist = 0;
      _stepIdx = 0;
      _offRouteStart = null;
      MapManager.clearRoute();
      MapManager.drawRoute(_coords);
      console.log('[Nav] Rerouted. Steps:', _instructions.length);
    } catch (err) {
      console.error('[Nav] Reroute failed:', err.message);
    } finally {
      setRerouting(false);
    }
  }

  function handlePosition(pos) {
    if (!_active) return;
    const userLat = pos.coords.latitude;
    const userLng = pos.coords.longitude;
    const heading = pos.coords.heading;
    const speed   = pos.coords.speed;
    updateSpeed(speed);
    const snapped = snapToRoute(userLng, userLat, _coords);
    _lastSnapped = { lat: snapped.lat, lng: snapped.lng };
    const h = heading != null ? heading : (_lastUserPos
      ? bearing(_lastUserPos.lat, _lastUserPos.lng, userLat, userLng) : 0);
    MapManager.setUserMarker(snapped.lat, snapped.lng, h);
    MapManager.followUser(snapped.lat, snapped.lng);
    if (_lastUserPos) {
      _elapsedDist += haversine(_lastUserPos.lat, _lastUserPos.lng, userLat, userLng);
    }
    _lastUserPos = { lat: userLat, lng: userLng };
    if (_stepIdx < _instructions.length) {
      const step = _instructions[_stepIdx];
      const distToStep = haversine(snapped.lat, snapped.lng, step.lat, step.lng);
      updateHUD(step, distToStep);
      if (distToStep < STEP_ADVANCE_DIST) {
        _stepIdx++;
        if (_stepIdx >= _instructions.length) { showArrived(); return; }
      }
    }
    if (snapped.distToRoute > OFF_ROUTE_DIST) {
      if (!_offRouteStart) {
        _offRouteStart = Date.now();
      } else if (Date.now() - _offRouteStart > OFF_ROUTE_SECS * 1000) {
        reroute(userLat, userLng);
        _offRouteStart = null;
      }
    } else {
      _offRouteStart = null;
    }
  }

  function handleGPSError(err) {
    console.warn('[Nav] GPS error:', err.message);
    const streetEl = document.getElementById('nav-street');
    if (streetEl) streetEl.textContent = '⚠️ Không có GPS';
  }

  /* ─── PUBLIC API ─── */
  let _lastSnapped = null;

  function start(instructions, coords, totalDist, waypoints, onExit) {
    _instructions  = instructions;
    _coords        = coords;
    _totalDist     = totalDist;
    _waypoints     = waypoints;
    _stepIdx       = 0;
    _offRouteStart = null;
    _reroutingActive = false;
    _active        = true;
    _onExitCb      = onExit;
    _lastUserPos   = null;
    _lastSnapped   = null;
    _elapsedDist   = 0;

    document.getElementById('nav-hud').classList.remove('hidden');
    document.getElementById('sidebar').classList.add('nav-hidden');

    if (!navigator.geolocation) { alert('Trình duyệt không hỗ trợ GPS!'); return; }
    MapManager.startFollowing(17);

    if (coords.length > 0) {
      const first = coords[0];
      MapManager.followUser(first[1], first[0]);
    }

    _watchId = navigator.geolocation.watchPosition(
      pos => handlePosition(pos),
      err => handleGPSError(err),
      { enableHighAccuracy: true, maximumAge: 1500, timeout: 10000 }
    );

    if (instructions.length > 0) updateHUD(instructions[0], instructions[0].distance);

    const btnZoomIn  = document.getElementById('nav-zoom-in');
    const btnZoomOut = document.getElementById('nav-zoom-out');
    const btnRecenter = document.getElementById('nav-recenter');
    if (btnZoomIn)  btnZoomIn.onclick  = () => MapManager.setNavZoom(Math.min(19, (MapManager._navZoom || 17) + 1));
    if (btnZoomOut) btnZoomOut.onclick = () => MapManager.setNavZoom(Math.max(10, (MapManager._navZoom || 17) - 1));
    if (btnRecenter) btnRecenter.onclick = () => { if (_lastSnapped) MapManager.followUser(_lastSnapped.lat, _lastSnapped.lng); };

    console.log('[Nav] Started. Steps:', instructions.length, 'Total:', totalDist, 'm');
    QuickAddPassenger.showBtn(waypoints, totalDist);
  }

  function stop() {
    _active = false;
    if (_watchId != null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
    MapManager.stopFollowing();
    MapManager.removeUserMarker();
    const btnZoomIn   = document.getElementById('nav-zoom-in');
    const btnZoomOut  = document.getElementById('nav-zoom-out');
    const btnRecenter = document.getElementById('nav-recenter');
    if (btnZoomIn)   btnZoomIn.onclick  = null;
    if (btnZoomOut)  btnZoomOut.onclick = null;
    if (btnRecenter) btnRecenter.onclick = null;
    QuickAddPassenger.hide();
    document.getElementById('nav-hud').classList.add('hidden');
    document.getElementById('sidebar').classList.remove('nav-hidden');
    if (_onExitCb) _onExitCb();
    console.log('[Nav] Stopped.');
  }

  function _getLastPos() { return _lastSnapped; }

  function _updateRoute(newCoords, newInstructions, newTotalDist, newWaypoints) {
    _coords        = newCoords;
    _instructions  = newInstructions;
    _totalDist     = newTotalDist;
    _waypoints     = newWaypoints;
    _stepIdx       = 0;
    _elapsedDist   = 0;
    _offRouteStart = null;
    MapManager.clearRoute();
    MapManager.drawRoute(newCoords);
    if (newInstructions.length > 0) updateHUD(newInstructions[0], newInstructions[0].distance);
    console.log('[Nav] Route updated externally. NewDist:', newTotalDist, 'm');
  }

  return { start, stop, _getLastPos, _updateRoute };
})();

/* ══════════════════════════════════════════════════════════
   QuickAddPassenger – Thêm hành khách nhanh trong nav mode
   Dữ liệu mock: 5 hành khách (đón Bắc Ninh / trả Hà Nội)
══════════════════════════════════════════════════════════ */
const QuickAddPassenger = (() => {
  'use strict';

  /* ── Mock passenger data ── */
  const MOCK_PASSENGERS = [
    {
      id: 'p1', name: 'Nguyễn Văn An', phone: '0912 345 678',
      pickupAddress:  '12 Đường Lý Thái Tổ, P. Bắc Giang, Bắc Ninh',
      pickupLat:  21.1881, pickupLng:  106.0748,
      dropoffAddress: '45 Phố Huế, Q. Hai Bà Trưng, Hà Nội',
      dropoffLat: 21.0094, dropoffLng: 105.8527,
    },
    {
      id: 'p2', name: 'Trần Thị Bình', phone: '0987 654 321',
      pickupAddress:  '45 Ngõ 7 Trần Phú, P. Bắc Giang, Bắc Ninh',
      pickupLat:  21.1905, pickupLng:  106.0762,
      dropoffAddress: '18 Trần Duy Hưng, Q. Cầu Giấy, Hà Nội',
      dropoffLat: 21.0108, dropoffLng: 105.7976,
    },
    {
      id: 'p3', name: 'Lê Minh Cường', phone: '0978 111 222',
      pickupAddress:  '8 Phố Bắc Giang, P. Bắc Giang, Bắc Ninh',
      pickupLat:  21.1869, pickupLng:  106.0735,
      dropoffAddress: '22 Lý Thường Kiệt, Q. Hoàn Kiếm, Hà Nội',
      dropoffLat: 21.0258, dropoffLng: 105.8486,
    },
    {
      id: 'p4', name: 'Phạm Thu Hương', phone: '0965 888 777',
      pickupAddress:  '21 Đường Hoàng Quốc Việt, P. Bắc Giang, Bắc Ninh',
      pickupLat:  21.1920, pickupLng:  106.0780,
      dropoffAddress: '6 Nguyễn Thái Học, Q. Ba Đình, Hà Nội',
      dropoffLat: 21.0334, dropoffLng: 105.8387,
    },
    {
      id: 'p5', name: 'Đỗ Quang Khải', phone: '0933 456 789',
      pickupAddress:  '3 Ngách 4/2 Lê Lợi, P. Bắc Giang, Bắc Ninh',
      pickupLat:  21.1856, pickupLng:  106.0720,
      dropoffAddress: '105 Chùa Bộc, Q. Đống Đa, Hà Nội',
      dropoffLat: 21.0167, dropoffLng: 105.8380,
    },
  ];

  /* ── State ── */
  let _addedIds          = new Set();
  let _currentRouteDistM = 0;
  let _currentWaypoints  = [];

  /* ── Haversine (metres) – chỉ dùng nội bộ khi cần ── */
  function hav(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /*
   * Tính delta lộ trình THỰC TẾ (API route) khi thêm passenger.
   * Gọi RouteManager.fetchRoute: tuyến hiện tại & tuyến sau khi thêm.
   * Trả về delta metres (dương = thêm quãng đường).
   */
  async function estimateDeltaRoute(passenger, waypoints) {
    const gps = NavigationManager._getLastPos ? NavigationManager._getLastPos() : null;
    const seq = [];
    if (gps && gps.lat != null) seq.push(gps);
    seq.push(...waypoints);
    if (seq.length < 1) return null;

    const P = { lat: passenger.pickupLat,  lng: passenger.pickupLng  };
    const D = { lat: passenger.dropoffLat, lng: passenger.dropoffLng };
    const baseSeq = seq.length >= 2 ? seq : [seq[0], seq[0]];

    try {
      const oldRoute = await RouteManager.fetchRoute(baseSeq, 'car');
      const oldDist  = oldRoute.distance;

      let minNewDist = Infinity;
      for (let i = 0; i <= seq.length - 1; i++) {
        const newSeq = [...seq.slice(0, i + 1), P, D, ...seq.slice(i + 1)];
        if (newSeq.length >= 2) {
          try {
            const r = await RouteManager.fetchRoute(newSeq, 'car');
            if (r.distance < minNewDist) minNewDist = r.distance;
          } catch (_) {}
        }
      }
      if (!isFinite(minNewDist)) return null;
      return minNewDist - oldDist;
    } catch (err) {
      console.warn('[QAP] estimateDeltaRoute failed:', err.message);
      return null;
    }
  }

  /* Format delta */
  function fmtDelta(deltaM) {
    if (deltaM == null) return '?';
    const km = deltaM / 1000;
    const sign = km >= 0 ? '+' : '';
    return `${sign}${km.toFixed(1)} km`;
  }

  /* ── Render card ── */
  function renderCard(passenger, deltaM, loading = false) {
    const isAdded  = _addedIds.has(passenger.id);
    const card     = document.createElement('div');
    card.className = 'qap-card' + (isAdded ? ' added' : '');
    card.id        = `qap-card-${passenger.id}`;

    const initials = passenger.name.split(' ').map(w => w[0]).slice(-2).join('');
    const isNeg    = deltaM != null && deltaM < 0;
    const deltaStr = loading
      ? '<span class="qap-delta-loading">⏳</span>'
      : fmtDelta(deltaM);
    const deltaTitle = loading
      ? 'Đang tính lộ trình thực tế...'
      : 'Chênh lệch quãng đường lộ trình thực tế khi thêm khách này';

    card.innerHTML = `
      <div class="qap-avatar">${initials}</div>
      <div class="qap-info">
        <div class="qap-name">${passenger.name}</div>
        <div class="qap-phone">📞 ${passenger.phone}</div>
        <div class="qap-addr"><span class="qap-addr-icon">🟢</span>${passenger.pickupAddress}</div>
        <div class="qap-addr qap-addr-dropoff"><span class="qap-addr-icon" style="color:#00d4ff">🔵</span>${passenger.dropoffAddress}</div>
      </div>
      <div class="qap-meta">
        <div class="qap-delta${isNeg ? ' negative' : ''}" id="qap-delta-${passenger.id}" title="${deltaTitle}">
          ${deltaStr}
        </div>
        <button class="qap-add-btn" id="qap-add-${passenger.id}"
          ${isAdded ? 'disabled title="Đã thêm vào B/C"' : 'title="Thêm địa chỉ vào mục B/C để chỉ đường"'}>
          ${isAdded ? '✓' : '+'}
        </button>
      </div>`;

    if (!isAdded) {
      card.querySelector(`#qap-add-${passenger.id}`)
        .addEventListener('click', () => addPassenger(passenger));
    }
    return card;
  }

  /* ── Render danh sách + tính delta route thực tế tuần tự ── */
  function renderList(waypoints, currentDistM) {
    const listEl = document.getElementById('qap-list');
    const loadEl = document.getElementById('qap-loading');
    if (!listEl) return;

    if (loadEl) loadEl.style.display = 'block';

    setTimeout(() => {
      if (loadEl) loadEl.style.display = 'none';
      listEl.querySelectorAll('.qap-card').forEach(el => el.remove());

      // Render tất cả cards ngay với delta đang loading
      MOCK_PASSENGERS.forEach(p => {
        const card = renderCard(p, null, !_addedIds.has(p.id));
        listEl.appendChild(card);
      });

      const badge = document.getElementById('qab-badge');
      if (badge) badge.textContent = MOCK_PASSENGERS.length - _addedIds.size;

      // Tính delta lộ trình thực tế tuần tự (tránh spam API)
      (async () => {
        for (const p of MOCK_PASSENGERS) {
          if (_addedIds.has(p.id)) continue;
          const deltaEl = document.getElementById(`qap-delta-${p.id}`);
          if (!deltaEl) continue;
          try {
            const deltaM = await estimateDeltaRoute(p, waypoints);
            const isNeg  = deltaM != null && deltaM < 0;
            deltaEl.className = 'qap-delta' + (isNeg ? ' negative' : '');
            deltaEl.title = 'Chênh lệch quãng đường lộ trình thực tế khi thêm khách này';
            deltaEl.innerHTML = fmtDelta(deltaM);
          } catch (_) {
            deltaEl.innerHTML = '?';
          }
        }
      })();
    }, 150);
  }

  /* ── Thêm địa chỉ khách vào sidebar B/C để chỉ đường ── */
  function addPassenger(passenger) {
    if (_addedIds.has(passenger.id)) return;

    const btn  = document.getElementById(`qap-add-${passenger.id}`);
    const card = document.getElementById(`qap-card-${passenger.id}`);
    if (btn) { btn.disabled = true; btn.textContent = '✓'; }

    // Thêm địa chỉ đón vào mục B, trả vào mục C trong sidebar
    if (typeof App !== 'undefined' && App.addPassengerToRoute) {
      App.addPassengerToRoute(passenger);
    }

    _addedIds.add(passenger.id);
    if (card) card.classList.add('added');

    const badge = document.getElementById('qab-badge');
    if (badge) badge.textContent = MOCK_PASSENGERS.length - _addedIds.size;

    const deltaEl = document.getElementById(`qap-delta-${passenger.id}`);
    if (deltaEl) deltaEl.title = 'Đã thêm vào B/C';

    UI.toast(`✅ Đã thêm ${passenger.name} vào mục B/C — nhấn Tối ưu để cập nhật lộ trình`, 'success', 4000);
  }

  /* ── Public API ── */
  function show(waypoints, totalDistM) {
    _currentWaypoints  = [...waypoints];
    _currentRouteDistM = totalDistM;
    const backdrop = document.getElementById('qap-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');
    renderList(waypoints, totalDistM);
  }

  function hidePanel() {
    const backdrop = document.getElementById('qap-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
  }

  function hide() {
    const btn = document.getElementById('nav-quick-add-btn');
    if (btn) btn.style.display = 'none';
    hidePanel();
    _addedIds.clear();
  }

  function showBtn(waypoints, totalDistM) {
    _currentWaypoints  = [...waypoints];
    _currentRouteDistM = totalDistM;

    const btn      = document.getElementById('nav-quick-add-btn');
    const closeBtn = document.getElementById('qap-close-btn');
    const backdrop = document.getElementById('qap-backdrop');

    if (btn)      { btn.style.display = ''; btn.onclick = () => show(_currentWaypoints, _currentRouteDistM); }
    if (closeBtn) closeBtn.onclick = hidePanel;
    if (backdrop) backdrop.addEventListener('click', e => { if (e.target === backdrop) hidePanel(); });
  }

  return { showBtn, hide, hidePanel };
})();
