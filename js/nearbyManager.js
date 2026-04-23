'use strict';
/* ── nearbyManager.js — Nearby Places from VietMap Search API ── */

const NearbyManager = (() => {

  const CATEGORIES = [
    { key: 'cafe',      icon: '☕', label: 'Cà phê',      query: 'cà phê coffee' },
    { key: 'restaurant',icon: '🍜', label: 'Nhà hàng',    query: 'nhà hàng restaurant' },
    { key: 'hospital',  icon: '🏥', label: 'Bệnh viện',   query: 'bệnh viện hospital' },
    { key: 'gas',       icon: '⛽', label: 'Xăng dầu',    query: 'cây xăng petrol' },
    { key: 'hotel',     icon: '🏨', label: 'Khách sạn',   query: 'khách sạn hotel' },
    { key: 'market',    icon: '🛒', label: 'Siêu thị',    query: 'siêu thị market' },
    { key: 'atm',       icon: '🏧', label: 'ATM',         query: 'ATM ngân hàng' },
    { key: 'pharmacy',  icon: '💊', label: 'Nhà thuốc',   query: 'nhà thuốc pharmacy' }
  ];

  /* ── Search nearby places ── */
  async function searchNearby(lat, lng, category, radius = 2000) {
    const apiKey = CONFIG.API_KEY;
    if (!apiKey) return [];
    const cat = CATEGORIES.find(c => c.key === category);
    if (!cat) return [];

    try {
      const url = `${CONFIG.SEARCH_API}?text=${encodeURIComponent(cat.query)}&focus=${lat},${lng}&radius=${radius}&size=8&apikey=${apiKey}`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.features || []);
      // Normalize
      return items.map(item => {
        const p = item.properties || item;
        return {
          name:    p.display || p.name || item.display || 'Địa điểm',
          address: p.address || p.ref_id || '',
          lat:     p.lat     || (item.geometry && item.geometry.coordinates[1]) || item.lat,
          lng:     p.lng     || (item.geometry && item.geometry.coordinates[0]) || item.lng,
          icon:    cat.icon,
          category: cat.key
        };
      }).filter(p => p.lat && p.lng);
    } catch (err) {
      console.warn('[NearbyManager] Error:', err.message);
      return [];
    }
  }

  /* ── Render nearby panel into sidebar ── */
  function renderPanel(results, anchorLat, anchorLng, onAddStop) {
    let panel = document.getElementById('nearby-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nearby-panel';
      panel.className = 'nearby-panel';
      // Insert before optimize button
      const optimizeBtn = document.getElementById('btn-optimize');
      optimizeBtn.parentNode.insertBefore(panel, optimizeBtn);
    }

    if (!results || results.length === 0) {
      panel.innerHTML = '<div class="nearby-empty">Không tìm thấy địa điểm gần đây</div>';
      panel.classList.add('visible');
      return;
    }

    const items = results.map((p, i) => {
      // Calc approx distance
      const dist = haversineKm(anchorLat, anchorLng, p.lat, p.lng);
      const distStr = dist < 1 ? `${Math.round(dist*1000)} m` : `${dist.toFixed(1)} km`;
      return `
        <div class="nearby-item" data-idx="${i}">
          <span class="nearby-icon">${p.icon}</span>
          <div class="nearby-info">
            <div class="nearby-name">${p.name}</div>
            ${p.address ? `<div class="nearby-addr">${p.address}</div>` : ''}
          </div>
          <div class="nearby-meta">
            <span class="nearby-dist">${distStr}</span>
            <button class="nearby-add" data-idx="${i}" title="Thêm điểm dừng">＋</button>
          </div>
        </div>
      `;
    }).join('');

    panel.innerHTML = `
      <div class="nearby-header">📍 Địa điểm gần đây</div>
      <div class="nearby-list">${items}</div>
    `;
    panel.classList.add('visible');

    // Wire up add buttons
    panel.querySelectorAll('.nearby-add').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = +btn.dataset.idx;
        onAddStop(results[idx]);
        btn.textContent = '✓';
        btn.style.background = 'rgba(0,230,118,.2)';
        btn.style.color = '#00e676';
        btn.disabled = true;
      });
    });

    // Store results for external access
    panel._results = results;
  }

  /* ── Render category chips ── */
  function renderCategoryChips(anchorLat, anchorLng, onSelect) {
    let chips = document.getElementById('nearby-chips');
    if (!chips) {
      chips = document.createElement('div');
      chips.id = 'nearby-chips';
      chips.className = 'nearby-chips';
      const panel = document.getElementById('nearby-panel');
      if (panel) panel.parentNode.insertBefore(chips, panel);
      else {
        const optimizeBtn = document.getElementById('btn-optimize');
        optimizeBtn.parentNode.insertBefore(chips, optimizeBtn);
      }
    }

    chips.innerHTML = CATEGORIES.map(c =>
      `<button class="chip" data-key="${c.key}">${c.icon} ${c.label}</button>`
    ).join('');

    chips.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        chips.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onSelect(btn.dataset.key);
      });
    });
  }

  /* ── Show loading skeleton ── */
  function showLoading() {
    let panel = document.getElementById('nearby-panel');
    if (!panel) return;
    panel.innerHTML = `
      <div class="nearby-header">📍 Đang tải địa điểm...</div>
      <div class="nearby-skeleton">
        ${Array(4).fill('<div class="skeleton-row"><div class="sk sk-icon"></div><div class="sk-lines"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>').join('')}
      </div>
    `;
    panel.classList.add('visible');
  }

  /* ── Hide panel ── */
  function hidePanel() {
    const panel = document.getElementById('nearby-panel');
    if (panel) panel.classList.remove('visible');
    const chips = document.getElementById('nearby-chips');
    if (chips) chips.classList.remove('visible');
  }

  /* ── Show chips ── */
  function showChips() {
    const chips = document.getElementById('nearby-chips');
    if (chips) chips.classList.add('visible');
  }

  /* ── Internal haversine ── */
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  return {
    CATEGORIES, searchNearby,
    renderPanel, renderCategoryChips,
    showLoading, hidePanel, showChips
  };
})();
