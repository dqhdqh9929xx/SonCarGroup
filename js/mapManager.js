'use strict';
/* ── mapManager.js — Leaflet.js với OSM tiles + VietMap overlay ── */

const MapManager = (() => {
  let map   = null;
  let markers = {};      // { 'origin': L.Marker, 'stop-0': L.Marker, ... }
  let routeLayer  = null;
  let shadowLayer = null;

  /* ── Tạo custom icon HTML ── */
  function createIcon(label, type) {
    const colors = {
      origin:  ['#00d4ff', '#0099cc'],
      stop:    ['#7b2ff7', '#5512c2'],
      dropoff: ['#ff9f43', '#ee5a24'],
      opt:     ['#00e676', '#00b050']
    };
    const [c1, c2] = colors[type] || colors.stop;
    return L.divIcon({
      className: '',
      html: `<div style="
        width:32px;height:32px;border-radius:50%;
        background:linear-gradient(135deg,${c1},${c2});
        display:flex;align-items:center;justify-content:center;
        font-size:12px;font-weight:800;color:#fff;
        border:2.5px solid rgba(255,255,255,.8);
        box-shadow:0 4px 16px rgba(0,0,0,.5);
        font-family:'Outfit',sans-serif;cursor:pointer;
      ">${label}</div>`,
      iconSize: [32,32], iconAnchor: [16,16], popupAnchor: [0,-16]
    });
  }

  /* ── Init map với Leaflet + OSM tiles ── */
  function init(apiKey, onMapClick) {
    if (map) { map.remove(); map = null; }

    map = L.map('map', {
      center: [CONFIG.DEFAULT_CENTER[1], CONFIG.DEFAULT_CENTER[0]],
      zoom:   CONFIG.DEFAULT_ZOOM,
      zoomControl: false
    });

    // Sử dụng CartoDB Voyager thay cho OSM mặc định để tránh lỗi 403 Blocked trên localhost
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, © <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
      subdomains: ['a', 'b', 'c', 'd']
    }).addTo(map);

    // Zoom control góc phải
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Scale bar
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

    // Map click
    map.on('click', e => onMapClick(e.lngLat ? e.lngLat.lng : e.latlng.lng,
                                    e.lngLat ? e.lngLat.lat : e.latlng.lat));

    return map;
  }

  /* ── Reload VietMap style khi có key (noop với Leaflet) ── */
  function reloadStyle(apiKey) {
    // Không cần làm gì — tiles đã load, VietMap key dùng cho APIs
  }

  /* ── Đặt marker xuất phát ── */
  function setOriginMarker(lng, lat, label = 'A') {
    if (markers['origin']) markers['origin'].remove();
    markers['origin'] = L.marker([lat, lng], { icon: createIcon(label, 'origin') })
      .addTo(map);
  }

  /* ── Đặt marker điểm dừng B ── */
  function setStopMarker(id, lng, lat, label) {
    if (markers[id]) markers[id].remove();
    markers[id] = L.marker([lat, lng], { icon: createIcon(label, 'stop') }).addTo(map);
  }

  /* ── Đặt marker điểm trả khách C ── */
  function setDropoffMarker(id, lng, lat, label) {
    if (markers[id]) markers[id].remove();
    markers[id] = L.marker([lat, lng], { icon: createIcon(label, 'dropoff') }).addTo(map);
  }

  /* ── Cập nhật markers sau tối ưu hóa (B=xanh lá, C=cam) ── */
  function setOptimizedMarkers(orderedB, orderedC) {
    Object.keys(markers).forEach(k => {
      if (k !== 'origin') { markers[k].remove(); delete markers[k]; }
    });
    orderedB.forEach((loc, i) => {
      const id = `opt-b-${i}`;
      markers[id] = L.marker([loc.lat, loc.lng], { icon: createIcon(`B${i+1}`, 'opt') }).addTo(map);
    });
    orderedC.forEach((loc, i) => {
      const id = `opt-c-${i}`;
      markers[id] = L.marker([loc.lat, loc.lng], { icon: createIcon(`C${i+1}`, 'dropoff') }).addTo(map);
    });
  }

  /* ── Xóa marker ── */
  function removeStopMarker(id) {
    if (markers[id]) { markers[id].remove(); delete markers[id]; }
  }

  /* ── Vẽ route polyline ── */
  function drawRoute(geojsonCoords) {
    clearRoute();
    if (!geojsonCoords || geojsonCoords.length < 2) return;

    // Convert [lng, lat] → [lat, lng] cho Leaflet
    const latLngs = geojsonCoords.map(c => [c[1], c[0]]);

    // Shadow glow
    shadowLayer = L.polyline(latLngs, {
      color: '#7b2ff7', weight: 10, opacity: 0.3
    }).addTo(map);

    // Main line
    routeLayer = L.polyline(latLngs, {
      color: '#00d4ff', weight: 4, opacity: 0.9,
      lineCap: 'round', lineJoin: 'round'
    }).addTo(map);
  }

  /* ── Animate: Leaflet không cần vì line đã show ngay ── */
  function animateRoute() { /* noop */ }

  /* ── Xóa route ── */
  function clearRoute() {
    if (routeLayer)  { routeLayer.remove();  routeLayer  = null; }
    if (shadowLayer) { shadowLayer.remove(); shadowLayer = null; }
  }

  /* ── Fit bounds ── */
  function fitToBounds(locations) {
    if (!locations || locations.length === 0) return;
    const bounds = L.latLngBounds(locations.map(l => [l.lat, l.lng]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
  }

  /* ── Bay đến tọa độ ── */
  function flyTo(lng, lat, zoom = 15) {
    map.flyTo([lat, lng], zoom, { duration: 0.8 });
  }

  /* ── Xóa tất cả markers ── */
  function clearAllMarkers() {
    Object.values(markers).forEach(m => m.remove());
    markers = {};
  }

  /* ── Reset ── */
  function reset() {
    clearAllMarkers();
    clearRoute();
  }

  return {
    init, reloadStyle,
    setOriginMarker, setStopMarker, setDropoffMarker,
    removeStopMarker, setOptimizedMarkers,
    drawRoute, animateRoute, clearRoute,

    fitToBounds, flyTo, clearAllMarkers, reset
  };
})();
