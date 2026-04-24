'use strict';
/* ── navigationManager.js — Dẫn đường thời gian thực ──
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
     '5': { icon: '📍', label: 'Điểm dừng' },
     '6': { icon: '⭕', label: 'Vòng xoay' },
    '-7': { icon: '↙', label: 'Giữ bên trái' },
     '7': { icon: '↘', label: 'Giữ bên phải' },
  };

  /* ─── Constants ─── */
  const OFF_ROUTE_DIST    = 50;   // m — xa hơn này → reroute
  const OFF_ROUTE_SECS    = 4;    // giây cần duy trì trước khi reroute
  const STEP_ADVANCE_DIST = 25;   // m — gần hơn này → chuyển step

  /* ─── State ─── */
  let _instructions    = [];   // [{sign,text,streetName,distance,lat,lng}, ...]
  let _coords          = [];   // [[lng,lat], ...] full route polyline
  let _waypoints       = [];   // [{lat,lng}, ...] remaining stops (for reroute)
  let _stepIdx         = 0;
  let _watchId         = null;
  let _offRouteStart   = null; // timestamp when first detected off-route
  let _reroutingActive = false;
  let _active          = false;
  let _onExitCb        = null;
  let _lastUserPos     = null;
  let _totalDist       = 0;    // total route distance in meters
  let _elapsedDist     = 0;    // approximate distance covered

  /* ─────────────────────────────────────────────
     HAVERSINE — khoảng cách giữa 2 điểm (meters)
  ───────────────────────────────────────────── */
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ─────────────────────────────────────────────
     SNAP-TO-ROAD
     Tìm điểm gần nhất trên polyline _coords
     coords: [[lng,lat],...]
     Returns: { lat, lng, distToRoute (m), segIdx }
  ───────────────────────────────────────────── */
  function snapToRoute(userLng, userLat, coords) {
    let minDist = Infinity;
    let bestLat = userLat, bestLng = userLng, bestSeg = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];       // [lng, lat]
      const [x2, y2] = coords[i + 1];

      // Vector projection
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

      if (d < minDist) {
        minDist = d;
        bestLat = projLat;
        bestLng = projLng;
        bestSeg = i;
      }
    }
    return { lat: bestLat, lng: bestLng, distToRoute: minDist, segIdx: bestSeg };
  }

  /* ─────────────────────────────────────────────
     HEADING — góc bearing từ A đến B (degrees)
  ───────────────────────────────────────────── */
  function bearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* ─────────────────────────────────────────────
     FORMAT
  ───────────────────────────────────────────── */
  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }
  function fmtTime(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} phút`;
    return `${Math.floor(min / 60)}g ${min % 60}p`;
  }

  /* ─────────────────────────────────────────────
     UPDATE HUD
  ───────────────────────────────────────────── */
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
      ? `${info.label} vào ${step.streetName}`
      : info.label;

    // Remaining distance (approximate)
    const remaining = Math.max(0, _totalDist - _elapsedDist);
    if (remEl) remEl.textContent = fmtDist(remaining);

    // ETA
    if (etaEl) {
      const now = new Date();
      // Assume 30 km/h average in city
      const remainMs = (remaining / 1000 / 30) * 3600000;
      const eta = new Date(now.getTime() + remainMs);
      etaEl.textContent = eta.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    }
  }

  /* Arrived at final destination */
  function showArrived() {
    const iconEl   = document.getElementById('nav-turn-icon');
    const distEl   = document.getElementById('nav-dist');
    const streetEl = document.getElementById('nav-street');
    if (iconEl)   iconEl.textContent   = '🏁';
    if (distEl)   distEl.textContent   = '0 m';
    if (streetEl) streetEl.textContent = 'Đã đến nơi!';
    setTimeout(() => stop(), 4000);
  }

  /* Update speed display */
  function updateSpeed(speedMps) {
    const el = document.getElementById('nav-speed');
    if (el) el.textContent = speedMps != null
      ? Math.round(speedMps * 3.6)  // m/s → km/h
      : '—';
  }

  /* Show/hide rerouting indicator */
  function setRerouting(active) {
    const el = document.getElementById('nav-rerouting');
    if (el) el.hidden = !active;
    _reroutingActive = active;
  }

  /* ─────────────────────────────────────────────
     RE-ROUTE — gọi lại route API từ vị trí hiện tại
  ───────────────────────────────────────────── */
  async function reroute(userLat, userLng) {
    if (_reroutingActive) return;
    setRerouting(true);

    try {
      const userLoc = { lat: userLat, lng: userLng };
      // Lấy các waypoints còn lại
      const remaining = [userLoc, ..._waypoints];
      const result = await RouteManager.fetchRoute(remaining, 'car');

      _coords = result.coords;
      _instructions = result.instructions;
      _totalDist = result.distance;
      _elapsedDist = 0;
      _stepIdx = 0;
      _offRouteStart = null;

      // Vẽ lại route trên bản đồ
      MapManager.clearRoute();
      MapManager.drawRoute(_coords);

      console.log('[Nav] Rerouted. Steps:', _instructions.length);
    } catch (err) {
      console.error('[Nav] Reroute failed:', err.message);
    } finally {
      setRerouting(false);
    }
  }

  /* ─────────────────────────────────────────────
     HANDLE GPS POSITION
  ───────────────────────────────────────────── */
  function handlePosition(pos) {
    if (!_active) return;

    const userLat = pos.coords.latitude;
    const userLng = pos.coords.longitude;
    const heading = pos.coords.heading; // null nếu đứng yên
    const speed   = pos.coords.speed;

    // Update speed
    updateSpeed(speed);

    // Snap to road
    const snapped = snapToRoute(userLng, userLat, _coords);
    _lastSnapped = { lat: snapped.lat, lng: snapped.lng }; // lưu để re-center

    // Update user marker
    const h = heading != null ? heading : (_lastUserPos
      ? bearing(_lastUserPos.lat, _lastUserPos.lng, userLat, userLng)
      : 0);
    MapManager.setUserMarker(snapped.lat, snapped.lng, h);
    MapManager.followUser(snapped.lat, snapped.lng);

    // Approximate elapsed distance
    if (_lastUserPos) {
      _elapsedDist += haversine(_lastUserPos.lat, _lastUserPos.lng, userLat, userLng);
    }
    _lastUserPos = { lat: userLat, lng: userLng };

    // Find current step
    if (_stepIdx < _instructions.length) {
      const step = _instructions[_stepIdx];
      const distToStep = haversine(snapped.lat, snapped.lng, step.lat, step.lng);

      updateHUD(step, distToStep);

      // Advance to next step when close enough
      if (distToStep < STEP_ADVANCE_DIST) {
        _stepIdx++;
        if (_stepIdx >= _instructions.length) {
          showArrived();
          return;
        }
      }
    }

    // Off-route detection
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

  /* ─────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────── */

  let _lastSnapped = null;  // { lat, lng } — vị trí snap gần nhất

  /**
   * Bắt đầu dẫn đường.
   */
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

    // Show Nav HUD
    document.getElementById('nav-hud').classList.remove('hidden');
    // Hide sidebar
    document.getElementById('sidebar').classList.add('nav-hidden');

    // Start GPS + bắt đầu follow (zoom 17)
    if (!navigator.geolocation) {
      alert('Trình duyệt không hỗ trợ GPS!');
      return;
    }
    MapManager.startFollowing(17);

    // Ngay lập tức fly đến điểm đầu tiên của route
    if (coords.length > 0) {
      const first = coords[0]; // [lng, lat]
      MapManager.followUser(first[1], first[0]);
    }

    _watchId = navigator.geolocation.watchPosition(
      pos => handlePosition(pos),
      err => handleGPSError(err),
      { enableHighAccuracy: true, maximumAge: 1500, timeout: 10000 }
    );

    // Init HUD với bước đầu tiên
    if (instructions.length > 0) {
      updateHUD(instructions[0], instructions[0].distance);
    }

    // Wire zoom + re-center buttons
    const btnZoomIn  = document.getElementById('nav-zoom-in');
    const btnZoomOut = document.getElementById('nav-zoom-out');
    const btnRecenter = document.getElementById('nav-recenter');

    if (btnZoomIn) btnZoomIn.onclick = () => {
      MapManager.setNavZoom(Math.min(19, (MapManager._navZoom || 17) + 1));
    };
    if (btnZoomOut) btnZoomOut.onclick = () => {
      MapManager.setNavZoom(Math.max(10, (MapManager._navZoom || 17) - 1));
    };
    if (btnRecenter) btnRecenter.onclick = () => {
      if (_lastSnapped) MapManager.followUser(_lastSnapped.lat, _lastSnapped.lng);
    };

    console.log('[Nav] Started. Steps:', instructions.length, 'Total:', totalDist, 'm');
  }

  function stop() {
    _active = false;
    if (_watchId != null) {
      navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
    MapManager.stopFollowing();
    MapManager.removeUserMarker();

    // Clear button handlers
    const btnZoomIn   = document.getElementById('nav-zoom-in');
    const btnZoomOut  = document.getElementById('nav-zoom-out');
    const btnRecenter = document.getElementById('nav-recenter');
    if (btnZoomIn)  btnZoomIn.onclick  = null;
    if (btnZoomOut) btnZoomOut.onclick = null;
    if (btnRecenter) btnRecenter.onclick = null;

    // Hide Nav HUD
    document.getElementById('nav-hud').classList.add('hidden');
    // Show sidebar
    document.getElementById('sidebar').classList.remove('nav-hidden');

    if (_onExitCb) _onExitCb();
    console.log('[Nav] Stopped.');
  }

  return { start, stop };
})();
