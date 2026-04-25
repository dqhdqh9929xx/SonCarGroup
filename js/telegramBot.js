'use strict';
/* ══════════════════════════════════════════════════════════════
   telegramBot.js — Nhận khách hàng mới từ Telegram Bot
   ─────────────────────────────────────────────────────────────
   Flow:
   1. Polling getUpdates mỗi 5s
   2. Parse /add  Tên | SĐT | Địa chỉ đón | Địa chỉ trả
   3. Geocode địa chỉ → tọa độ (VietMap Search API)
   4. Hiển thị trong panel sidebar → user bấm "Thêm vào lộ trình"
   5. Reply xác nhận về Telegram
══════════════════════════════════════════════════════════════ */

const TelegramBot = (() => {

  const TG_API = 'https://api.telegram.org/bot';

  /* ── State ── */
  let _token = '';
  let _offset = 0;       // Telegram update offset
  let _polling = false;
  let _pollTimer = null;
  let _customers = [];      // { id, name, phone, pickupAddr, dropoffAddr, pickupLat, pickupLng, dropoffLat, dropoffLng, status:'pending'|'added'|'geocoding', tgChatId, tgMsgId }
  let _nextCustId = 1;
  let _onCustomerReady = null; // callback(customer) khi user bấm "Thêm"
  let _notifSound = null;

  /* ── Init ── */
  function init(onCustomerReady) {
    _onCustomerReady = onCustomerReady;

    // Lấy token từ SECRETS hoặc localStorage
    _token = (typeof SECRETS !== 'undefined' && SECRETS.TELEGRAM_BOT_TOKEN)
      ? SECRETS.TELEGRAM_BOT_TOKEN
      : localStorage.getItem('tg_bot_token') || '';

    // Pre-create notification sound (HTML5 Audio)
    try {
      _notifSound = new Audio('data:audio/wav;base64,UklGRl4FAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YToFAABkAGQAZABkAGQAZABkAH4AoADSAPQAJAFGAWABagFoAVoBPgEaAe4AugCCAEoAFADi/7L/iv9k/0r/Ov80/zr/Sv9k/4r/sv/i/xQAMgBKAGIAdgCIAJgApgCuALIAsACsAKIAlACCAG4AWgBEAC4AGAAEAPb/6P/g/9r/2P/c/+L/7P/4/wQAEgAgAC4AOgBEAEoATgBOAEwASABCADoAMAAkABgADAACADj/');
    } catch (_) { }

    // Setup UI events
    setupPanel();

    // Nếu đã có token → bắt đầu polling
    if (_token) {
      startPolling();
    }
  }

  /* ── Setup Telegram Panel UI ── */
  function setupPanel() {
    const toggleBtn = document.getElementById('tg-toggle');
    const tokenInput = document.getElementById('tg-token-input');
    const saveBtn = document.getElementById('tg-token-save');
    const tokenSection = document.getElementById('tg-token-section');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (_polling) {
          stopPolling();
        } else {
          if (!_token) {
            // Show token input
            if (tokenSection) tokenSection.style.display = '';
            if (tokenInput) tokenInput.focus();
            return;
          }
          startPolling();
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const val = tokenInput?.value?.trim();
        if (!val) {
          UI.toast('Vui lòng nhập Bot Token!', 'warn');
          return;
        }
        _token = val;
        localStorage.setItem('tg_bot_token', val);
        if (tokenSection) tokenSection.style.display = 'none';
        startPolling();
      });
    }

    // Pre-fill token if available
    if (tokenInput && _token) {
      tokenInput.value = _token;
    }
  }

  /* ── Start polling ── */
  function startPolling() {
    if (!_token) {
      UI.toast('Chưa có Bot Token!', 'warn');
      return;
    }
    _polling = true;
    updateStatusUI(true);
    UI.toast('📨 Telegram Bot đang lắng nghe...', 'success', 3000);

    // Poll immediately then every 5s
    poll();
    _pollTimer = setInterval(poll, 5000);
  }

  /* ── Stop polling ── */
  function stopPolling() {
    _polling = false;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    updateStatusUI(false);
    UI.toast('Telegram Bot đã tắt', 'info', 2000);
  }

  /* ── Update status indicator ── */
  function updateStatusUI(active) {
    const dot = document.getElementById('tg-status-dot');
    const text = document.getElementById('tg-status-text');
    const toggleBtn = document.getElementById('tg-toggle');

    if (dot) {
      dot.className = 'tg-status-dot ' + (active ? 'active' : 'inactive');
    }
    if (text) {
      text.textContent = active ? 'Đang lắng nghe' : 'Đã tắt';
    }
    if (toggleBtn) {
      toggleBtn.textContent = active ? '⏸ Tạm dừng' : '▶ Bật Bot';
      toggleBtn.className = 'tg-toggle-btn ' + (active ? 'active' : '');
    }
  }

  /* ── Poll Telegram API ── */
  let _pollBusy = false;
  const _processedMsgIds = new Set();

  async function poll() {
    if (!_polling || !_token || _pollBusy) return;
    _pollBusy = true;

    try {
      const url = `${TG_API}${_token}/getUpdates?offset=${_offset}&timeout=0&allowed_updates=["message"]`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[TgBot] API error:', resp.status);
        if (resp.status === 401) {
          UI.toast('❌ Bot Token không hợp lệ!', 'error');
          stopPolling();
        }
        return;
      }

      const data = await resp.json();
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        _offset = update.update_id + 1;
        if (update.message?.text) {
          const msgId = update.message.message_id;
          if (_processedMsgIds.has(msgId)) continue; // skip duplicate
          _processedMsgIds.add(msgId);
          handleMessage(update.message);
        }
      }
    } catch (err) {
      console.warn('[TgBot] Poll error:', err.message);
    } finally {
      _pollBusy = false;
    }
  }

  /* ── Handle incoming message ── */
  function handleMessage(msg) {
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    // Chỉ xử lý lệnh /add
    if (!text.startsWith('/add')) {
      // Gửi hướng dẫn nếu không phải /add
      if (text === '/start' || text === '/help') {
        sendReply(chatId, '🚗 *Son Car Group Bot*\n\nĐể thêm khách hàng mới, gửi:\n\n`/add Tên | SĐT | Địa chỉ đón | Địa chỉ trả`\n\nVí dụ:\n`/add Nguyễn Văn A | 0912345678 | 122 Lê Lợi, Lê Lợi, TP Bắc Giang, Bắc Giang | 55 Phố Huế, Hai Bà Trưng, Hà Nội`');
      }
      return;
    }

    // Parse /add command
    let content = text.replace(/^\/add\s*/i, '').trim();

    // Support multi-line format
    let parts;
    if (content.includes('|')) {
      parts = content.split('|').map(s => s.trim());
    } else if (content.includes('\n')) {
      parts = content.split('\n').map(s => s.trim()).filter(s => s);
    } else if (!content) {
      // Check if message has text after /add on next lines
      sendReply(chatId, '❌ Sai format!\n\nDùng: `/add Tên | SĐT | Đón | Trả`\n\nVí dụ:\n`/add Nguyễn Văn A | 0912345678 | 122 Lê Lợi, TP Bắc Giang | 55 Phố Huế, Hà Nội`');
      return;
    } else {
      // Try comma separation as fallback
      parts = content.split(',').map(s => s.trim());
    }

    if (parts.length < 4) {
      sendReply(chatId, '❌ Thiếu thông tin! Cần đủ 4 mục:\n`Tên | SĐT | Địa chỉ đón | Địa chỉ trả`\n\nBạn gửi ' + parts.length + ' mục.');
      return;
    }

    const [name, phone, pickupAddr, dropoffAddr] = parts;

    if (!name || !phone || !pickupAddr || !dropoffAddr) {
      sendReply(chatId, '❌ Thông tin không hợp lệ! Mỗi mục không được để trống.');
      return;
    }

    // Create customer object — chỉ lưu text, web sẽ geocode
    const customer = {
      id: 'tg-' + (_nextCustId++),
      name: name,
      phone: phone,
      pickupAddr: pickupAddr,
      dropoffAddr: dropoffAddr,
      pickupLat: null,
      pickupLng: null,
      dropoffLat: null,
      dropoffLng: null,
      status: 'pending',
      tgChatId: chatId,
      tgMsgId: msgId,
      timestamp: Date.now()
    };

    _customers.unshift(customer);
    renderCustomerList();

    // Play notification sound
    playNotifSound();

    // Toast notification
    UI.toast(`📨 Khách mới từ Telegram: ${name}`, 'success', 5000);

    // Reply to Telegram
    sendReply(chatId, `✅ Đã nhận!\n\n👤 *${name}*\n📞 ${phone}\n🟢 Đón: ${pickupAddr}\n🔵 Trả: ${dropoffAddr}\n\n📡 Đã gửi đến tài xế.`);
  }

  /* ── Send reply to Telegram ── */
  async function sendReply(chatId, text) {
    if (!_token) return;
    try {
      await fetch(`${TG_API}${_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown'
        })
      });
    } catch (e) {
      console.warn('[TgBot] sendReply error:', e.message);
    }
  }

  /* ── Play notification sound ── */
  function playNotifSound() {
    try {
      // Use Web Audio API for reliable cross-browser notification
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch (_) { }
  }

  /* ── Render customer list in sidebar panel AND nav overlay ── */
  function renderCustomerList() {
    // Render vào cả 2 nơi: sidebar panel + nav overlay
    const targets = [
      document.getElementById('tg-customer-list'),
      document.getElementById('nav-tg-list')
    ].filter(Boolean);

    const pendingCount = _customers.filter(c => c.status === 'pending').length;

    // Update all count badges
    const countEls = [
      document.getElementById('tg-count'),
      document.getElementById('nav-tg-badge')
    ];
    countEls.forEach(el => {
      if (el) {
        el.textContent = pendingCount;
        if (pendingCount > 0) el.classList.add('has-new');
        else el.classList.remove('has-new');
      }
    });

    targets.forEach(listEl => {
      if (_customers.length === 0) {
        listEl.innerHTML = `
          <div class="tg-empty">
            <div class="tg-empty-icon">📨</div>
            <span>Chưa có khách hàng từ Telegram</span>
            <small>Gửi /add vào bot để thêm khách</small>
          </div>`;
        return;
      }

      listEl.innerHTML = '';
      _customers.forEach(cust => {
        const card = document.createElement('div');
        card.className = 'tg-customer-card' + (cust.status === 'added' ? ' added' : '');

        const initials = cust.name.split(' ').map(w => w[0]).slice(-2).join('');
        const timeStr = new Date(cust.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

        let statusBadge = '';
        let actionBtn = '';

        if (cust.status === 'added') {
          statusBadge = '<span class="tg-status-badge added">✓ Đã thêm</span>';
          actionBtn = '<button class="tg-add-btn" disabled>✓</button>';
        } else {
          statusBadge = '<span class="tg-status-badge ready">✅ Sẵn sàng</span>';
          actionBtn = `<button class="tg-add-btn ready" data-cust-id="${cust.id}" title="Thêm vào lộ trình">＋ Thêm</button>`;
        }

        card.innerHTML = `
          <div class="tg-card-header">
            <div class="tg-avatar">${initials}</div>
            <div class="tg-card-info">
              <div class="tg-card-name">${cust.name}</div>
              <div class="tg-card-phone">📞 ${cust.phone}</div>
            </div>
            <div class="tg-card-time">${timeStr}</div>
          </div>
          <div class="tg-card-addresses">
            <div class="tg-card-addr"><span class="tg-addr-dot pickup"></span>${cust.pickupAddr}</div>
            <div class="tg-card-addr"><span class="tg-addr-dot dropoff"></span>${cust.dropoffAddr}</div>
          </div>
          <div class="tg-card-footer">
            ${statusBadge}
            ${actionBtn}
          </div>`;

        listEl.appendChild(card);

        // Attach add event
        if (cust.status === 'pending') {
          const btn = card.querySelector(`[data-cust-id="${cust.id}"]`);
          if (btn) btn.addEventListener('click', () => addCustomerToRoute(cust));
        }
      });
    });
  }

  /* ── Add customer to route (B/C sidebar) ── */
  function addCustomerToRoute(customer) {
    if (customer.status !== 'pending') return;

    customer.status = 'added';

    // Build passenger object compatible with App.addPassengerToRoute
    const passenger = {
      pickupAddress: customer.pickupAddr,
      pickupLat: customer.pickupLat,
      pickupLng: customer.pickupLng,
      dropoffAddress: customer.dropoffAddr,
      dropoffLat: customer.dropoffLat,
      dropoffLng: customer.dropoffLng
    };

    if (_onCustomerReady) {
      _onCustomerReady(passenger);
    }

    renderCustomerList();

    // Notify Telegram
    sendReply(customer.tgChatId,
      `🚗 *${customer.name}* đã được thêm vào lộ trình!\n\nTài xế sẽ đón bạn tại: ${customer.pickupAddr}`
    );

    UI.toast(`✅ Đã thêm ${customer.name} vào lộ trình`, 'success', 3000);
  }

  /* ── Nav-mode Telegram panel ── */
  function showNavBtn() {
    const btn = document.getElementById('nav-tg-btn');
    const closeBtn = document.getElementById('nav-tg-close');
    const backdrop = document.getElementById('nav-tg-backdrop');

    if (btn) {
      btn.style.display = '';
      btn.onclick = () => showNavPanel();
    }
    if (closeBtn) closeBtn.onclick = () => hideNavPanel();
    if (backdrop) backdrop.addEventListener('click', e => { if (e.target === backdrop) hideNavPanel(); });

    // Update badge
    const pendingCount = _customers.filter(c => c.status === 'pending').length;
    const badge = document.getElementById('nav-tg-badge');
    if (badge) badge.textContent = pendingCount;
  }

  /* ── Get customers list (for QuickAddPassenger integration) ── */
  function getCustomers() {
    return _customers;
  }

  /* ── Mark a customer as added (called from QuickAddPassenger) ── */
  function markCustomerAdded(custId) {
    const cust = _customers.find(c => c.id === custId);
    if (!cust || cust.status === 'added') return;
    cust.status = 'added';

    // Notify Telegram
    sendReply(cust.tgChatId,
      `🚗 *${cust.name}* đã được thêm vào lộ trình!\n\nTài xế sẽ đón bạn tại: ${cust.pickupAddr}`
    );

    renderCustomerList();
  }

  /* ── Public API ── */
  return { init, getCustomers, markCustomerAdded };
})();
