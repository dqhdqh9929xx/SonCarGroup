with open('js/navigationManager.js', 'rb') as f:
    raw = f.read()
text = raw.decode('utf-8-sig')

# Exact positions found via inspection
hav_start  = 18284   # '/* ── Haversine (metres) ── */'  (inside QuickAddPassenger)
fmt_start  = text.find('  /* Format delta */')
rc_start   = 21382   # '/* ── Render card (có cả pickup + dropoff) ── */'
rl_start   = 22967   # '/* ── Render danh sách ── */'
ap_start   = 23715   # '/* ── Thêm khách vào lộ trình (pickup + dropoff) ── */'
pub_start  = 25724   # '/* ── Public API ── */'

# Need to account for the 2-space indent before each block
# actual text[hav_start] is '/' and preceded by 2 spaces
# Let's step back 2 chars for those that start with '  /*'
def find_indent(pos):
    # Check if there are 2 spaces before the marker
    if pos >= 2 and text[pos-2:pos] == '  ':
        return pos - 2
    return pos

hav_start2  = find_indent(hav_start)
rc_start2   = find_indent(rc_start)
rl_start2   = find_indent(rl_start)
ap_start2   = find_indent(ap_start)
pub_start2  = find_indent(pub_start)

print("Adjusted positions:")
print(f"  hav:   {hav_start2}  fmt: {fmt_start}")
print(f"  rc:    {rc_start2}")
print(f"  rl:    {rl_start2}")
print(f"  ap:    {ap_start2}")
print(f"  pub:   {pub_start2}")

assert fmt_start > 0, "fmt_start not found"

# ── New haversine + estimateDeltaRoute block ──────────────────────────────────
new_hav_block = '''  /* \u2500\u2500 Haversine (metres) \u2500\u2500 */
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
   * T\u00ednh delta l\u1ed9 tr\u00ecnh TH\u1ef0C T\u1ebe (API route) khi th\u00eam passenger.
   * G\u1ecdi RouteManager.fetchRoute: tuy\u1ebfn hi\u1ec7n t\u1ea1i & tuy\u1ebfn sau khi th\u00eam.
   * Tr\u1ea3 v\u1ec1 delta metres (d\u01b0\u01a1ng = th\u00eam qu\u00e3ng \u0111\u01b0\u1eddng).
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

'''

# ── New renderCard block ──────────────────────────────────────────────────────
new_render_card = '''  /* \u2500\u2500 Render card (c\u00f3 c\u1ea3 pickup + dropoff) \u2500\u2500 */
  function renderCard(passenger, deltaM, loading = false) {
    const isAdded  = _addedIds.has(passenger.id);
    const card     = document.createElement('div');
    card.className = 'qap-card' + (isAdded ? ' added' : '');
    card.id        = `qap-card-${passenger.id}`;

    const initials = passenger.name.split(' ').map(w => w[0]).slice(-2).join('');
    const isNeg    = deltaM != null && deltaM < 0;
    const deltaStr = loading
      ? '<span class="qap-delta-loading">\u23f3</span>'
      : fmtDelta(deltaM);
    const deltaTitle = loading
      ? '\u0110ang t\u00ednh l\u1ed9 tr\u00ecnh th\u1ef1c t\u1ebf...'
      : 'Ch\u00eanh l\u1ec7ch qu\u00e3ng \u0111\u01b0\u1eddng l\u1ed9 tr\u00ecnh th\u1ef1c t\u1ebf khi th\u00eam kh\u00e1ch n\u00e0y';

    card.innerHTML = `
      <div class="qap-avatar">${initials}</div>
      <div class="qap-info">
        <div class="qap-name">${passenger.name}</div>
        <div class="qap-phone">\ud83d\udcde ${passenger.phone}</div>
        <div class="qap-addr"><span class="qap-addr-icon">\ud83d\udfe2</span>${passenger.pickupAddress}</div>
        <div class="qap-addr qap-addr-dropoff"><span class="qap-addr-icon" style="color:#00d4ff">\ud83d\udd35</span>${passenger.dropoffAddress}</div>
      </div>
      <div class="qap-meta">
        <div class="qap-delta${isNeg ? ' negative' : ''}" id="qap-delta-${passenger.id}" title="${deltaTitle}">
          ${deltaStr}
        </div>
        <button class="qap-add-btn" id="qap-add-${passenger.id}"
          ${isAdded ? 'disabled title="\u0110\u00e3 th\u00eam v\u00e0o B/C"' : 'title="Th\u00eam \u0111\u1ecba ch\u1ec9 v\u00e0o m\u1ee5c B/C \u0111\u1ec3 ch\u1ec9 \u0111\u01b0\u1eddng"'}>
          ${isAdded ? '\u2713' : '+'}
        </button>
      </div>`;

    if (!isAdded) {
      card.querySelector(`#qap-add-${passenger.id}`)
        .addEventListener('click', () => addPassenger(passenger));
    }
    return card;
  }

'''

# ── New renderList block ──────────────────────────────────────────────────────
new_render_list = '''  /* \u2500\u2500 Render danh s\u00e1ch + t\u00ednh delta route th\u1ef1c t\u1ebf tu\u1ea7n t\u1ef1 \u2500\u2500 */
  function renderList(waypoints, currentDistM) {
    const listEl = document.getElementById('qap-list');
    const loadEl = document.getElementById('qap-loading');
    if (!listEl) return;

    if (loadEl) loadEl.style.display = 'block';

    setTimeout(() => {
      if (loadEl) loadEl.style.display = 'none';
      listEl.querySelectorAll('.qap-card').forEach(el => el.remove());

      // Render t\u1ea5t c\u1ea3 cards ngay v\u1edbi delta \u0111ang loading
      MOCK_PASSENGERS.forEach(p => {
        const card = renderCard(p, null, !_addedIds.has(p.id));
        listEl.appendChild(card);
      });

      const badge = document.getElementById('qab-badge');
      if (badge) badge.textContent = MOCK_PASSENGERS.length - _addedIds.size;

      // T\u00ednh delta l\u1ed9 tr\u00ecnh th\u1ef1c t\u1ebf tu\u1ea7n t\u1ef1 (tr\u00e1nh spam API)
      (async () => {
        for (const p of MOCK_PASSENGERS) {
          if (_addedIds.has(p.id)) continue;
          const deltaEl = document.getElementById(`qap-delta-${p.id}`);
          if (!deltaEl) continue;
          try {
            const deltaM = await estimateDeltaRoute(p, waypoints);
            const isNeg  = deltaM != null && deltaM < 0;
            deltaEl.className = 'qap-delta' + (isNeg ? ' negative' : '');
            deltaEl.title = 'Ch\u00eanh l\u1ec7ch qu\u00e3ng \u0111\u01b0\u1eddng l\u1ed9 tr\u00ecnh th\u1ef1c t\u1ebf khi th\u00eam kh\u00e1ch n\u00e0y';
            deltaEl.innerHTML = fmtDelta(deltaM);
          } catch (_) {
            deltaEl.innerHTML = '?';
          }
        }
      })();
    }, 150);
  }

'''

# ── New addPassenger block ────────────────────────────────────────────────────
new_add_passenger = '''  /* \u2500\u2500 Th\u00eam \u0111\u1ecba ch\u1ec9 kh\u00e1ch v\u00e0o sidebar B/C \u0111\u1ec3 ch\u1ec9 \u0111\u01b0\u1eddng \u2500\u2500 */
  function addPassenger(passenger) {
    if (_addedIds.has(passenger.id)) return;

    const btn  = document.getElementById(`qap-add-${passenger.id}`);
    const card = document.getElementById(`qap-card-${passenger.id}`);
    if (btn) { btn.disabled = true; btn.textContent = '\u2713'; }

    // Th\u00eam \u0111\u1ecba ch\u1ec9 \u0111\u00f3n v\u00e0o m\u1ee5c B, tr\u1ea3 v\u00e0o m\u1ee5c C trong sidebar
    if (typeof App !== 'undefined' && App.addPassengerToRoute) {
      App.addPassengerToRoute(passenger);
    }

    _addedIds.add(passenger.id);
    if (card) card.classList.add('added');

    const badge = document.getElementById('qab-badge');
    if (badge) badge.textContent = MOCK_PASSENGERS.length - _addedIds.size;

    const deltaEl = document.getElementById(`qap-delta-${passenger.id}`);
    if (deltaEl) deltaEl.title = '\u0110\u00e3 th\u00eam v\u00e0o B/C';

    UI.toast(`\u2705 \u0110\u00e3 th\u00eam ${passenger.name} v\u00e0o m\u1ee5c B/C \u2014 nh\u1ea5n T\u1ed1i \u01b0u \u0111\u1ec3 c\u1eadp nh\u1eadt l\u1ed9 tr\u00ecnh`, 'success', 4000);
  }

'''

# ── Assemble ──────────────────────────────────────────────────────────────────
# Segment 1: before hav_start2
# Segment 2: between fmt_start and rc_start2 (Format delta + fmtDelta function)
# Segment 3: between pub_start2 and end

text_out = (
    text[:hav_start2] +
    new_hav_block +
    text[fmt_start:rc_start2] +
    new_render_card +
    new_render_list +
    new_add_passenger +
    text[pub_start2:]
)

with open('js/navigationManager.js', 'wb') as f:
    f.write('\ufeff'.encode('utf-8'))
    f.write(text_out.encode('utf-8'))

print(f"Done! Output size: {len(text_out)} chars (was {len(text)})")
print("Verify:")
checks = [
    ('estimateDeltaRoute', True),
    ('addPassengerToRoute', True),
    ('qap-delta-loading', True),
    ('Thêm địa chỉ vào mục B/C', True),
    ('Chênh lệch quãng đường lộ trình thực tế', True),
    ('async function addPassenger', False),   # should be removed
    ('totalHav', False),                       # should be removed
]
for c, expect in checks:
    found = c in text_out
    status = 'OK' if found == expect else 'FAIL'
    print(f"  {status}: {'FOUND' if found else 'MISSING'} {c}")
