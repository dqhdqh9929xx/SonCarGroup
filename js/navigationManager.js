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
   Lấy danh sách khách từ TelegramBot
══════════════════════════════════════════════════════════ */
const QuickAddPassenger = (() => {
  'use strict';

  let _addedIds          = new Set();
  let _currentRouteDistM = 0;
  let _currentWaypoints  = [];

  /* ── Haversine (metres) ── */
  function hav(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── Tính tổng haversine cho chuỗi điểm ── */
  function routeLen(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += hav(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    }
    return total * 1.4; // hệ số đường thực tế
  }

  /* ── Ước tính CHÊNH LỆCH quãng đường (lộ trình mới − cũ) ── */
  function estimateDelta(passenger) {
    if (!passenger.pickupLat || !passenger.dropoffLat) return null;

    const P = { lat: passenger.pickupLat, lng: passenger.pickupLng };
    const D = { lat: passenger.dropoffLat, lng: passenger.dropoffLng };

    // Lấy lộ trình hiện tại từ App
    const currentPts = (typeof App !== 'undefined' && App.getRouteState)
      ? App.getRouteState() : [];

    if (currentPts.length < 2) {
      // Chưa có lộ trình → hiện khoảng cách đón-trả
      return routeLen([P, D]);
    }

    // Tính khoảng cách lộ trình hiện tại
    const oldDist = routeLen(currentPts);

    // Thử chèn P và D vào mọi vị trí, tìm chênh lệch nhỏ nhất
    let minNewDist = Infinity;
    for (let i = 0; i <= currentPts.length; i++) {
      for (let j = i; j <= currentPts.length; j++) {
        const newPts = [
          ...currentPts.slice(0, i),
          P,
          ...currentPts.slice(i, j),
          D,
          ...currentPts.slice(j)
        ];
        const d = routeLen(newPts);
        if (d < minNewDist) minNewDist = d;
      }
    }
    return minNewDist - oldDist;
  }

  function fmtDelta(deltaM) {
    if (deltaM == null) return '…';
    const km = deltaM / 1000;
    return `+${km.toFixed(1)} km`;
  }

  function toPassenger(cust) {
    return {
      id: cust.id, name: cust.name, phone: cust.phone,
      pickupAddress: cust.pickupAddr, pickupLat: cust.pickupLat, pickupLng: cust.pickupLng,
      dropoffAddress: cust.dropoffAddr, dropoffLat: cust.dropoffLat, dropoffLng: cust.dropoffLng,
      needsGeocode: cust.needsGeocode || false
    };
  }

  function renderCard(passenger, deltaM) {
    const isAdded  = _addedIds.has(passenger.id);
    const card = document.createElement('div');
    card.className = 'qap-card' + (isAdded ? ' added' : '');
    card.id = `qap-card-${passenger.id}`;
    const initials = passenger.name.split(' ').map(w => w[0]).slice(-2).join('');
    const deltaStr = fmtDelta(deltaM);
    const deltaTitle = deltaM != null ? 'Ước tính quãng đường đón-trả khách này' : 'Đang xác định tọa độ...';
    card.innerHTML = `
      <div class="qap-avatar">${initials}</div>
      <div class="qap-info">
        <div class="qap-name">${passenger.name}</div>
        <div class="qap-phone">📞 ${passenger.phone}</div>
        <div class="qap-addr"><span class="qap-addr-icon">🟢</span>${passenger.pickupAddress}</div>
        <div class="qap-addr qap-addr-dropoff"><span class="qap-addr-icon" style="color:#00d4ff">🔵</span>${passenger.dropoffAddress}</div>
      </div>
      <div class="qap-meta">
        <div class="qap-delta" id="qap-delta-${passenger.id}" title="${deltaTitle}">${deltaStr}</div>
        <button class="qap-add-btn" id="qap-add-${passenger.id}"
          ${isAdded ? 'disabled title="Đã thêm"' : 'title="Thêm vào lộ trình"'}>${isAdded ? '✓' : '+'}</button>
      </div>`;
    if (!isAdded) {
      card.querySelector(`#qap-add-${passenger.id}`)
        .addEventListener('click', () => addPassenger(passenger));
    }
    return card;
  }

  function renderList(waypoints, currentDistM) {
    const listEl = document.getElementById('qap-list');
    const loadEl = document.getElementById('qap-loading');
    if (!listEl) return;
    const tgCustomers = (typeof TelegramBot !== 'undefined' && TelegramBot.getCustomers)
      ? TelegramBot.getCustomers() : [];
    const passengers = tgCustomers
      .filter(c => c.status === 'pending' || c.status === 'added')
      .map(toPassenger);
    if (loadEl) loadEl.style.display = 'block';

    /* ── Smart geocode: thử nhiều cách, resolve ref_id nếu cần ── */
    async function smartGeocode(address) {
      const queries = [
        address,
        address.replace(/^\d+\s*/, ''),
        address.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim(),
      ];
      const parts = address.replace(/[,]/g, ' ').split(/\s+/).filter(w => w.length > 1);
      if (parts.length >= 2) {
        queries.push(parts.slice(-2).join(' '));
        queries.push(parts.slice(-3).join(' '));
      }
      if (parts.length >= 1) queries.push(parts[parts.length - 1]);

      for (const q of queries) {
        if (!q || q.length < 2) continue;
        try {
          const results = await RouteManager.searchAddress(q);
          if (!results || results.length === 0) continue;
          const item = results[0];
          let lat = item.lat ?? item.latitude ?? item.geometry?.coordinates?.[1];
          let lng = item.lng ?? item.longitude ?? item.geometry?.coordinates?.[0];
          // Nếu không có tọa độ nhưng có ref_id → gọi Place Detail API
          if ((lat == null || lng == null) && item.ref_id) {
            const detail = await RouteManager.getPlaceDetail(item.ref_id);
            if (detail && detail.lat != null && detail.lng != null) {
              lat = detail.lat; lng = detail.lng;
            }
          }
          if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            console.log(`[QAP] Geocoded "${address}" → "${q}" → ${lat},${lng}`);
            return { lat: parseFloat(lat), lng: parseFloat(lng) };
          }
        } catch (_) {}
      }
      console.warn(`[QAP] Geocode failed for: "${address}"`);
      return null;
    }

    const geocodePromises = passengers
      .filter(p => !_addedIds.has(p.id) && (!p.pickupLat || !p.dropoffLat))
      .map(async p => {
        try {
          if (!p.pickupLat) {
            const result = await smartGeocode(p.pickupAddress);
            if (result) {
              p.pickupLat = result.lat; p.pickupLng = result.lng;
              const cust = tgCustomers.find(c => c.id === p.id);
              if (cust) { cust.pickupLat = result.lat; cust.pickupLng = result.lng; }
            }
          }
          if (!p.dropoffLat) {
            const result = await smartGeocode(p.dropoffAddress);
            if (result) {
              p.dropoffLat = result.lat; p.dropoffLng = result.lng;
              const cust = tgCustomers.find(c => c.id === p.id);
              if (cust) { cust.dropoffLat = result.lat; cust.dropoffLng = result.lng; }
            }
          }
        } catch (e) { console.warn('[QAP] Geocode failed:', e.message); }
      });

    Promise.all(geocodePromises).then(() => {
      if (loadEl) loadEl.style.display = 'none';
      listEl.querySelectorAll('.qap-card').forEach(el => el.remove());
      if (passengers.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'qap-loading';
        emptyEl.style.padding = '30px 20px';
        emptyEl.innerHTML = `<div style="font-size:1.5rem;margin-bottom:8px;">📨</div>
          Chưa có khách hàng từ Telegram<br>
          <small style="opacity:.6">Gửi /add vào bot để thêm khách</small>`;
        listEl.appendChild(emptyEl);
        const badge = document.getElementById('qab-badge');
        if (badge) badge.textContent = '0';
        return;
      }
      passengers.forEach(p => {
        const isAdded = _addedIds.has(p.id);
        const deltaM = isAdded ? null : estimateDelta(p);
        const card = renderCard(p, deltaM);
        listEl.appendChild(card);
      });
      const badge = document.getElementById('qab-badge');
      if (badge) badge.textContent = passengers.filter(p => !_addedIds.has(p.id)).length;
    });
  }

  async function addPassenger(passenger) {
    if (_addedIds.has(passenger.id)) return;
    const btn = document.getElementById(`qap-add-${passenger.id}`);
    const card = document.getElementById(`qap-card-${passenger.id}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    // Retry geocode nếu chưa có tọa độ (smartGeocode)
    if (!passenger.pickupLat || !passenger.dropoffLat) {
      async function tryGeocode(addr) {
        const queries = [
          addr,
          addr.replace(/^\d+\s*/, ''),
          addr.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim(),
        ];
        const parts = addr.replace(/[,]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        if (parts.length >= 2) {
          queries.push(parts.slice(-2).join(' '));
          queries.push(parts.slice(-3).join(' '));
        }
        if (parts.length >= 1) queries.push(parts[parts.length - 1]);

        for (const q of queries) {
          if (!q || q.length < 2) continue;
          try {
            const results = await RouteManager.searchAddress(q);
            if (!results || results.length === 0) continue;
            const item = results[0];
            let lat = item.lat ?? item.latitude ?? item.geometry?.coordinates?.[1];
            let lng = item.lng ?? item.longitude ?? item.geometry?.coordinates?.[0];
            if ((lat == null || lng == null) && item.ref_id) {
              const detail = await RouteManager.getPlaceDetail(item.ref_id);
              if (detail && detail.lat != null && detail.lng != null) {
                lat = detail.lat; lng = detail.lng;
              }
            }
            if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng))
              return { lat: parseFloat(lat), lng: parseFloat(lng) };
          } catch (_) {}
        }
        return null;
      }

      try {
        if (!passenger.pickupLat) {
          const r = await tryGeocode(passenger.pickupAddress);
          if (r) { passenger.pickupLat = r.lat; passenger.pickupLng = r.lng; }
        }
        if (!passenger.dropoffLat) {
          const r = await tryGeocode(passenger.dropoffAddress);
          if (r) { passenger.dropoffLat = r.lat; passenger.dropoffLng = r.lng; }
        }
        const tgCusts = (typeof TelegramBot !== 'undefined' && TelegramBot.getCustomers) ? TelegramBot.getCustomers() : [];
        const cust = tgCusts.find(c => c.id === passenger.id);
        if (cust) {
          cust.pickupLat = passenger.pickupLat; cust.pickupLng = passenger.pickupLng;
          cust.dropoffLat = passenger.dropoffLat; cust.dropoffLng = passenger.dropoffLng;
        }
      } catch (e) { console.warn('[QAP] Smart geocode in addPassenger failed:', e.message); }
    }

    if (btn) btn.textContent = '✓';
    if (typeof App !== 'undefined' && App.addPassengerToRoute) {
      App.addPassengerToRoute(passenger);
    }
    _addedIds.add(passenger.id);
    if (card) card.classList.add('added');
    if (typeof TelegramBot !== 'undefined' && TelegramBot.markCustomerAdded) {
      TelegramBot.markCustomerAdded(passenger.id);
    }
    const tgCustomers = (typeof TelegramBot !== 'undefined' && TelegramBot.getCustomers)
      ? TelegramBot.getCustomers() : [];
    const remaining = tgCustomers.filter(c => c.status === 'pending').length;
    const badge = document.getElementById('qab-badge');
    if (badge) badge.textContent = remaining;

    // Auto-optimize nếu có tọa độ hợp lệ
    if (passenger.pickupLat && passenger.dropoffLat) {
      UI.toast(`✅ Đã thêm ${passenger.name} — đang tối ưu lộ trình...`, 'success', 3000);
      setTimeout(() => {
        if (typeof App !== 'undefined' && App.runOptimize) App.runOptimize();
      }, 500);
    } else {
      UI.toast(`⚠️ Đã thêm ${passenger.name} (chưa có tọa độ) — cần xác nhận địa chỉ trên sidebar`, 'warn', 5000);
    }
  }

  function show(waypoints, totalDistM) {
    _currentWaypoints = [...waypoints];
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
    _currentWaypoints = [...waypoints];
    _currentRouteDistM = totalDistM;
    const btn = document.getElementById('nav-quick-add-btn');
    const closeBtn = document.getElementById('qap-close-btn');
    const backdrop = document.getElementById('qap-backdrop');
    if (btn) { btn.style.display = ''; btn.onclick = () => show(_currentWaypoints, _currentRouteDistM); }
    if (closeBtn) closeBtn.onclick = hidePanel;
    if (backdrop) backdrop.addEventListener('click', e => { if (e.target === backdrop) hidePanel(); });
    const tgCustomers = (typeof TelegramBot !== 'undefined' && TelegramBot.getCustomers)
      ? TelegramBot.getCustomers() : [];
    const pending = tgCustomers.filter(c => c.status === 'pending').length;
    const badge = document.getElementById('qab-badge');
    if (badge) badge.textContent = pending;
  }

  return { showBtn, hide, hidePanel };
})();
