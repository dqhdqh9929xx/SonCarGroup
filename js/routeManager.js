'use strict';
/* ── routeManager.js — VietMap Route API v3 + Geocoding ── */

const RouteManager = (() => {

  /* ── Geocoding: search address ── */
  async function searchAddress(text, focusLat, focusLng) {
    const apiKey = CONFIG.API_KEY;
    if (!apiKey || !text || text.length < 2) return [];
    try {
      const focus = (focusLat && focusLng) ? `&focus=${focusLat},${focusLng}` : '';
      const url = `${CONFIG.SEARCH_API}?text=${encodeURIComponent(text)}${focus}&apikey=${apiKey}`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (data.features) return data.features;
      return [];
    } catch (err) {
      console.warn('[RouteManager] Geocoding error:', err.message);
      return [];
    }
  }

  /* ── Place detail: resolve ref_id → { lat, lng, address } ── */
  async function getPlaceDetail(refId) {
    const apiKey = CONFIG.API_KEY;
    if (!apiKey || !refId) return null;
    try {
      const url = `https://maps.vietmap.vn/api/place/v3?refid=${encodeURIComponent(refId)}&apikey=${apiKey}`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const item = Array.isArray(data) ? data[0] : data;
      if (!item) return null;
      const lat = item.lat ?? item.latitude ?? item.geometry?.coordinates?.[1] ?? null;
      const lng = item.lng ?? item.longitude ?? item.geometry?.coordinates?.[0] ?? null;
      const address = item.display || item.name || '';
      return { lat: parseFloat(lat), lng: parseFloat(lng), address };
    } catch (err) {
      console.warn('[RouteManager] Place detail error:', err.message);
      return null;
    }
  }

  /* ── Reverse geocode: coordinates → address ── */
  async function reverseGeocode(lat, lng) {
    const apiKey = CONFIG.API_KEY;
    try {
      const url = `${CONFIG.REVERSE_API}?lat=${lat}&lng=${lng}&apikey=${apiKey}`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data[0].display || data[0].name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } catch {
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }

  /* ── Route API: get route for ordered list of locations ── */
  async function fetchRoute(orderedLocations, vehicle = 'car') {
    const apiKey = CONFIG.API_KEY;
    if (orderedLocations.length < 2) throw new Error('Cần ít nhất 2 điểm');

    const pointsParam = orderedLocations.map(l => `point=${l.lat},${l.lng}`).join('&');
    const url = `${CONFIG.ROUTE_API}?${pointsParam}&vehicle=${vehicle}&points_encoded=false&apikey=${apiKey}`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Route API HTTP ${res.status}`);
    const data = await res.json();

    if (!data.paths || data.paths.length === 0) throw new Error('Không tìm được đường đi');
    const path = data.paths[0];

    // Extract GeoJSON coords [[lng,lat],...]
    let coords = [];
    const pts = path.points;
    if (pts && pts.coordinates) {
      coords = pts.coordinates;
    } else if (pts && pts.type === 'LineString') {
      coords = pts.coordinates;
    }

    // Extract turn-by-turn instructions
    const instructions = [];
    if (Array.isArray(path.instructions)) {
      for (const inst of path.instructions) {
        // interval[0] = index vào coords array của điểm maneuver
        const ptIdx = Array.isArray(inst.interval) ? inst.interval[0] : 0;
        const coord = coords[ptIdx] || coords[0]; // [lng, lat]
        instructions.push({
          sign:       inst.sign ?? 0,
          text:       inst.text || '',
          streetName: inst.street_name || '',
          distance:   inst.distance || 0,   // meters to NEXT maneuver
          time:       inst.time || 0,       // ms
          lng:        coord ? coord[0] : 0,
          lat:        coord ? coord[1] : 0,
          ptIdx
        });
      }
    }

    return {
      distance:     path.distance || 0,  // meters
      time:         path.time     || 0,  // milliseconds
      coords,                            // [[lng,lat], ...]
      instructions                       // [{sign,text,streetName,distance,lat,lng}, ...]
    };
  }

  return { searchAddress, getPlaceDetail, reverseGeocode, fetchRoute };
})();

