'use strict';
/* ── matrixManager.js — VietMap Matrix API + haversine fallback ── */

const MatrixManager = (() => {

  /* ── Haversine fallback (straight-line km) ── */
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  /* ── Build haversine matrix ── */
  function buildHaversineMatrix(locations) {
    const n = locations.length;
    const matrix = Array.from({length: n}, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== j)
          matrix[i][j] = haversine(locations[i].lat, locations[i].lng,
                                   locations[j].lat, locations[j].lng);
    return matrix;
  }

  /* ── Fetch distance matrix from VietMap Matrix API ── */
  async function fetchMatrix(locations, vehicle = 'car') {
    const apiKey = CONFIG.API_KEY;
    const pointsParam = locations.map(l => `point=${l.lat},${l.lng}`).join('&');
    const url = `${CONFIG.MATRIX_API}?${pointsParam}&vehicle=${vehicle}&out_array=distances&out_array=times&apikey=${apiKey}`;

    try {
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // VietMap matrix response: { distances: [[...]], times: [[...]] }
      if (data.distances && Array.isArray(data.distances)) {
        return { matrix: data.distances, times: data.times || null, source: 'api' };
      }
      throw new Error('Unexpected response format');
    } catch (err) {
      console.warn('[MatrixManager] API error, using haversine fallback:', err.message);
      const matrix = buildHaversineMatrix(locations);
      return { matrix, times: null, source: 'haversine' };
    }
  }

  return { fetchMatrix, buildHaversineMatrix, haversine };
})();
