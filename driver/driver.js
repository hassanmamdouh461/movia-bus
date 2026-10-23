/* Movia Bus - driver app (ride-hailing layout). Depends on ../shared/core.js (window.MB) and Leaflet (window.L, optional). */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const CHAT_READ_KEY = 'mb_driver_chat_read'; // per-viewer convenience: { tripId: lastReadTs }
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت المحطة', 'هستنى دقيقة', 'هتأخر شوية (5 دقايق)', 'الأتوبيس زحمة'];
  const STATUS_STEPS = [['scheduled', 'لم تبدأ'], ['en_route', 'في الطريق'], ['arrived', 'وصل الجامعة / انتهت']];
  // seeded so the chat is never blank for a trip (ago = ms before now)
  const SEED_CHAT = [
    { from: 'student', text: 'السلام عليكم يا أستاذ، الأتوبيس فين دلوقتي؟', ago: 12 * 60000 },
    { from: 'driver', text: 'وعليكم السلام، أنا في الطريق', ago: 10 * 60000 },
    { from: 'student', text: 'تمام، أنا مستنّي عند المحطة', ago: 3 * 60000 },
  ];
  const NEAR_BOTTOM_PX = 120;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // privacy: never show phone-like numbers in the chat
  const maskPhones = (t) => String(t).replace(/\+?\d[\d\s-]{6,}\d/g, '••••');

  // ---------- driver selection (remembered) ----------
  function loadDriverId() {
    let id = null;
    try { id = localStorage.getItem(DRIVER_KEY); } catch (e) {}
    return MB.drivers.some((d) => d.id === id) ? id : MB.drivers[0].id;
  }
  function saveDriverId(id) { try { localStorage.setItem(DRIVER_KEY, id); } catch (e) {} }
  let driverId = loadDriverId();

  // ---------- trips ----------
  function driverTrips() {
    return MB.state.trips
      .filter((t) => t.driverId === driverId && t.status !== 'cancelled')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }
  // the "next trip": running trip first, then the next not-started one, then the last finished one
  function currentTrip() {
    const list = driverTrips();
    return list.find((t) => t.status === 'en_route')
      || list.find((t) => t.status === 'at_start' || t.status === 'scheduled')
      || list.filter((t) => t.status === 'arrived').pop()
      || list[0] || null;
  }
  function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
  // index of the next stop while running, -1 otherwise
  function nextIndex(trip) {
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    return pos ? pos.nextStopIdx : -1;
  }

  // a scheduled trip becomes "at_start" when the driver opens the app near its time (+/- 30 min)
  function ensureAtStart() {
    const t = currentTrip();
    if (!t || t.status !== 'scheduled') return;
    const diff = t.scheduledAt - Date.now();
    if (diff > 30 * 60000 || diff < -30 * 60000) return;
    MB.update((s) => { const x = s.trips.find((z) => z.id === t.id); if (x && x.status === 'scheduled') x.status = 'at_start'; });
  }

  // ---------- toast / modal ----------
  function toast(msg) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
  function closeModal() { const m = $('skipModal'); if (m) m.remove(); }
  function openSkip(sid, minutes) {
    closeModal();
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'skipModal';
    m.innerHTML =
      '<div class="card" role="dialog" aria-modal="true">' +
      '<h3>تخطي محطة ' + esc(MB.S[sid].name) + '؟</h3>' +
      '<p class="mute">هتوفّر حوالي ' + minutes + ' دقيقة. ده تجربة بس، ومش هيتسجل أي تغيير.</p>' +
      '<div class="row"><button class="btn sec grow" id="skipNo">إلغاء</button>' +
      '<button class="btn grow" id="skipYes">تأكيد التخطي</button></div></div>';
    document.body.appendChild(m);
    m.querySelector('#skipNo').onclick = closeModal;
    m.querySelector('#skipYes').onclick = () => {
      closeModal();
      toast('تم تسجيل التخطي (تجريبي) · توفير ~' + minutes + ' دقيقة');
    };
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
  }

  // ---------- map ----------
  let map = null, routeLayer = null, crowdLayer = null, busLayer = null;
  let lastTripId = null, lastKey = '', lastDemandSig = '', lastSaveSig = '', lastChatSig = '';
  let chatOpen = false, forceChatScroll = false;

  function initMap() {
    if (typeof L === 'undefined') {
      $('map').innerHTML = '<p class="mute" style="padding:16px">الخريطة مش متاحة دلوقتي (محتاج إنترنت). التفاصيل تحت.</p>';
      return;
    }
    map = L.map('map', { zoomControl: false, scrollWheelZoom: false }).setView([30.04, 31.27], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    crowdLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 0);
    window.addEventListener('resize', () => map && map.invalidateSize());
  }

  function drawRoute(trip) {
    if (!map) return;
    routeLayer.clearLayers();
    const route = MB.R[trip.routeId];
    const poly = MB.polyOf(trip);
    L.polyline(poly, { color: route.color, weight: 7, opacity: 0.9 }).addTo(routeLayer);
    // keep the route clear of the top pill and the bottom sheet
    map.fitBounds(L.latLngBounds(poly), {
      paddingTopLeft: [30, 100],
      paddingBottomRight: [30, Math.round(window.innerHeight * 0.6) + 20],
    });
  }

  function chipClass(n) { return n >= 5 ? 'chip warn' : n > 0 ? 'chip info' : 'chip'; }

  function renderDemand(trip) {
    const stops = MB.stopsOf(trip);
    const counts = MB.waitingCounts(trip.id);
    const nextIdx = nextIndex(trip);
    const sig = trip.id + '|' + nextIdx + '|' + stops.map((s) => counts[s] || 0).join(',');
    if (sig === lastDemandSig) return;
    lastDemandSig = sig;
    if (map) {
      crowdLayer.clearLayers();
      stops.forEach((sid) => {
        const st = MB.S[sid], n = counts[sid] || 0;
        L.marker([st.lat, st.lng], {
          icon: L.divIcon({
            className: 'mb-icon',
            html: '<div class="pin crowd">' + n + '</div>',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).bindTooltip(st.name).addTo(crowdLayer);
      });
    }
    $('demandList').innerHTML = stops.map((sid, i) => {
      const n = counts[sid] || 0;
      const cls = i < nextIdx ? 'passed' : i === nextIdx ? 'next' : '';
      return '<div class="stop-row ' + cls + '"><span class="stop-dot"></span>' +
        '<span class="grow">' + esc(MB.S[sid].name) + '</span>' +
        '<span class="' + chipClass(n) + '">' + n + ' منتظر</span></div>';
    }).join('');
  }

  function renderBus(trip) {
    if (!map) return;
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    if (!pos) { busLayer.clearLayers(); return; }
    if (!busLayer.getLayers().length) {
      L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({
          className: 'mb-icon',
          html: '<div class="pin bus lbl">الأتوبيس</div>',
          iconSize: [80, 30],
          iconAnchor: [40, 15],
        }),
      }).addTo(busLayer);
    } else {
      busLayer.eachLayer((m) => m.setLatLng([pos.lat, pos.lng]));
    }
  }

  // ---------- status pill ----------
  function renderPill(trip) {
    const state = !trip ? 'off' : trip.status === 'en_route' ? 'live' : 'on';
    const pill = $('statusPill');
    pill.dataset.state = state;
    $('statusText').textContent = state === 'live' ? 'في رحلة' : state === 'on' ? 'متصل' : 'غير متصل';
  }

  // ---------- trip card (header + primary action) ----------
  function renderHeader(trip) {
    const s = trip.status;
    $('tripTitle').textContent = MB.tripLabel(trip);
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'الأتوبيس ' + plate + ' · المقاعد المحجوزة ' + trip.booked + ' من ' + trip.capacity +
      (trip.waitlist ? ' · قايمة انتظار ' + trip.waitlist : '');

    const idx = s === 'en_route' ? 1 : s === 'arrived' ? 2 : 0;
    $('chain').innerHTML = STATUS_STEPS.map((st, i) =>
      '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' +
      (i === 0 && s === 'at_start' ? MB.statusLabel.at_start : st[1]) + '</li>').join('');

    const btn = $('btnMain');
    if (s === 'en_route') {
      btn.textContent = 'أنهِ الرحلة';
      btn.className = 'btn big go-btn bad';
      btn.disabled = false;
    } else if (s === 'scheduled' || s === 'at_start') {
      btn.textContent = 'ابدأ الرحلة';
      btn.className = 'btn big go-btn ok';
      btn.disabled = false;
    } else {
      btn.textContent = 'الرحلة خلصت';
      btn.className = 'btn big go-btn';
      btn.disabled = true;
    }

    $('hint').textContent =
      s === 'en_route' ? 'ما تقفلش الشاشة عشان البث يفضل شغال.' :
      s === 'arrived' ? 'انتهت الرحلة. الرحلة الجاية هتظهر هنا تلقائيًا.' :
      'اضغط "ابدأ الرحلة" لما تتحرك من محطة البداية.';
    $('chatSub').textContent = MB.tripLabel(trip);
  }

  // big next-stop card: ETA + waiting COUNT only
  function renderNext(trip) {
    const counts = MB.waitingCounts(trip.id);
    const stops = MB.stopsOf(trip);
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    if (pos) {
      const sid = pos.nextStopId, eta = MB.etaMinutes(trip, sid);
      $('nextLabel').textContent = 'المحطة القادمة';
      $('nextName').textContent = MB.S[sid].name;
      $('nextWait').textContent = (counts[sid] || 0) + ' طالب منتظر';
      $('etaNum').textContent = eta != null ? eta : '—';
      $('etaUnit').textContent = 'دقيقة';
    } else if (trip.status === 'scheduled' || trip.status === 'at_start') {
      const first = stops[0];
      $('nextLabel').textContent = 'ميعاد الانطلاق';
      $('nextName').textContent = MB.S[first].name;
      $('nextWait').textContent = (counts[first] || 0) + ' طالب منتظر';
      $('etaNum').textContent = trip.time;
      $('etaUnit').textContent = 'من محطة البداية';
    } else {
      $('nextLabel').textContent = 'الرحلة خلصت';
      $('nextName').textContent = MB.S[stops[stops.length - 1]].name;
      $('nextWait').textContent = '';
      $('etaNum').textContent = '—';
      $('etaUnit').textContent = 'وصلت';
    }
  }

  // earnings-like stat row from existing data
  function renderStats() {
    const today = driverTrips().filter((t) => isToday(t.scheduledAt));
    $('statTrips').textContent = today.length;
    $('statPax').textContent = today.reduce((n, t) => n + (t.booked || 0), 0);
    const d = MB.drv[driverId];
    $('statRating').textContent = d && d.rating ? d.rating.toFixed(1) : '—';
  }

  // ---------- save-time card (skip empty stops) ----------
  function renderSave(trip) {
    const box = $('saveList');
    if (trip.status !== 'en_route') {
      if (lastSaveSig === 'idle') return;
      lastSaveSig = 'idle';
      box.innerHTML = '<p class="mute">المحطات الفاضية اللي قدامك هتظهر لما الرحلة تبدأ.</p>';
      return;
    }
    const skip = MB.emptyAhead(trip);
    const stops = MB.stopsOf(trip);
    const seg = Math.max(1, Math.round(MB.TRIP_MS / 60000 * 3 / (stops.length - 1)));
    const sig = trip.id + '|' + skip.join(',') + '|' + seg;
    if (sig === lastSaveSig) return;
    lastSaveSig = sig;
    if (!skip.length) {
      box.innerHTML = '<p class="mute">كل المحطات اللي قدامك فيها ركاب، مفيش حاجة تتخطى.</p>';
      return;
    }
    box.innerHTML =
      '<p class="save-sum">فيه <b>' + skip.length + '</b> محطات مفيهاش حد منتظر · توفير تقديري <b>' +
      (skip.length * seg) + ' دقيقة</b></p>' +
      skip.map((sid) =>
        '<div class="row-item"><span class="grow">' + esc(MB.S[sid].name) + '</span>' +
        '<span class="mute">~' + seg + ' د</span>' +
        '<button class="btn sm sec" data-skip="' + esc(sid) + '" data-min="' + seg + '">تخطي</button></div>').join('');
  }

  // ---------- chat ----------
  function chatMsgs(trip) {
    return (MB.state.chat || []).filter((m) => m.tripId === trip.id).sort((a, b) => a.ts - b.ts);
  }
  function readMap() {
    try { return JSON.parse(localStorage.getItem(CHAT_READ_KEY)) || {}; } catch (e) { return {}; }
  }
  function markRead(trip) {
    const msgs = chatMsgs(trip);
    const last = msgs.length ? msgs[msgs.length - 1].ts : 0;
    const map_ = readMap();
    if ((map_[trip.id] || 0) >= last) return;
    map_[trip.id] = last;
    try { localStorage.setItem(CHAT_READ_KEY, JSON.stringify(map_)); } catch (e) {}
  }

  // seed a short conversation when a trip has no messages yet (returns true if it wrote state)
  function seedChat(trip) {
    if (chatMsgs(trip).length) return false;
    const now = Date.now();
    MB.update((s) => {
      s.chat = s.chat || [];
      SEED_CHAT.forEach((m, i) => s.chat.push({
        id: 'seed' + trip.id + i, tripId: trip.id, from: m.from, text: m.text, ts: now - m.ago,
      }));
    });
    return true;
  }

  function bubbleHtml(m) {
    return '<div class="bubble ' + (m.from === 'driver' ? 'driver' : 'student') + '">' +
      '<span>' + esc(maskPhones(m.text)) + '</span>' +
      '<time>' + MB.fmtTime(m.ts) + '</time></div>';
  }

  function renderChat(trip) {
    const msgs = chatMsgs(trip).slice(-60);
    const sig = trip.id + '|' + msgs.map((m) => m.id).join(',');
    const box = $('chatList');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    const changed = sig !== lastChatSig;
    if (changed) {
      lastChatSig = sig;
      box.innerHTML = msgs.length ? msgs.map(bubbleHtml).join('')
        : '<p class="mute chat-empty">مفيش رسايل لحد دلوقتي.</p>';
    }
    if (chatOpen && (forceChatScroll || (changed && near))) box.scrollTop = box.scrollHeight;
    forceChatScroll = false;
  }

  function renderChatBadge(trip) {
    if (chatOpen) markRead(trip);
    const read = readMap()[trip.id] || 0;
    const unread = chatOpen ? 0 : chatMsgs(trip).filter((m) => m.from === 'student' && m.ts > read).length;
    const badge = $('chatBadge');
    badge.hidden = !unread;
    badge.textContent = unread > 9 ? '9+' : String(unread);
  }

  function sendChat(text) {
    const t = currentTrip();
    const clean = String(text || '').trim().slice(0, 200);
    if (!t || !clean) return;
    forceChatScroll = true;
    MB.update((s) => {
      s.chat = s.chat || [];
      s.chat.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), tripId: t.id, from: 'driver', text: clean, ts: Date.now() });
    });
  }

  function setChatOpen(on) {
    chatOpen = !!on;
    $('chatScreen').hidden = !chatOpen;
    if (chatOpen) forceChatScroll = true;
    refresh();
  }

  function setChatEnabled(on) {
    $('chatIn').disabled = !on;
    $('chatSend').disabled = !on;
    $('chatFab').disabled = !on;
    document.querySelectorAll('#quick .qchip').forEach((b) => { b.disabled = !on; });
  }

  // ---------- main refresh (idempotent; called on every state change and every second) ----------
  function renderEmpty() {
    renderPill(null);
    if (lastKey === 'EMPTY') return;
    lastKey = 'EMPTY'; lastTripId = null; lastDemandSig = ''; lastSaveSig = ''; lastChatSig = '';
    $('tripTitle').textContent = 'مفيش رحلات مسجلة ليك';
    $('tripMeta').textContent = 'اختار سائق تاني من فوق.';
    $('chain').innerHTML = '';
    $('btnMain').textContent = 'ابدأ الرحلة';
    $('btnMain').className = 'btn big go-btn';
    $('btnMain').disabled = true;
    $('hint').textContent = '';
    $('nextLabel').textContent = 'المحطة القادمة';
    $('nextName').textContent = '—';
    $('nextWait').textContent = '';
    $('etaNum').textContent = '—';
    $('etaUnit').textContent = '';
    $('demandList').innerHTML = '<p class="mute">لا توجد محطات.</p>';
    $('saveList').innerHTML = '<p class="mute">لا توجد محطات.</p>';
    $('chatList').innerHTML = '<p class="mute chat-empty">مفيش محادثة.</p>';
    $('chatSub').textContent = '';
    $('chatBadge').hidden = true;
    if (map) { routeLayer.clearLayers(); crowdLayer.clearLayers(); busLayer.clearLayers(); }
    setChatEnabled(false);
  }

  function refresh() {
    renderStats();
    const trip = currentTrip();
    if (!trip) { renderEmpty(); return; }
    if (seedChat(trip)) return; // seeding emits its own refresh

    setChatEnabled(true);
    const key = trip.id + '|' + trip.status;
    if (key !== lastKey) { lastKey = key; renderHeader(trip); }
    if (trip.id !== lastTripId) {
      lastTripId = trip.id;
      lastDemandSig = ''; lastSaveSig = ''; lastChatSig = '';
      drawRoute(trip);
    }
    renderPill(trip);
    renderBus(trip);
    renderNext(trip);
    renderDemand(trip);
    renderSave(trip);
    renderChat(trip);
    renderChatBadge(trip);
  }

  // ---------- wiring ----------
  function renderDriverSelect() {
    const sel = $('driverSel');
    sel.innerHTML = MB.drivers.map((d) => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('');
    sel.value = driverId;
    sel.onchange = () => {
      driverId = sel.value;
      saveDriverId(driverId);
      lastKey = ''; lastTripId = null;
      ensureAtStart();
      refresh();
    };
  }

  function bindActions() {
    $('btnMain').onclick = () => {
      const t = currentTrip();
      if (!t) return;
      if (t.status === 'scheduled' || t.status === 'at_start') {
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) { x.status = 'en_route'; x.startedAt = Date.now(); }
        });
        MB.notify('بدأت رحلة ' + MB.tripLabel(t), 'bus');
        toast('بدأت الرحلة، البث التلقائي شغال');
      } else if (t.status === 'en_route') {
        if (!window.confirm('متأكد إنك عايز تنهي الرحلة؟')) return;
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) x.status = 'arrived';
        });
        toast('تم إنهاء الرحلة. شكرًا يا أستاذ');
      }
    };

    $('sheetToggle').onclick = () => {
      const collapsed = $('sheet').classList.toggle('collapsed');
      document.body.classList.toggle('sheet-collapsed', collapsed);
      $('sheetToggle').setAttribute('aria-expanded', String(!collapsed));
    };

    $('saveList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-skip]');
      if (b) openSkip(b.getAttribute('data-skip'), Number(b.getAttribute('data-min')) || 1);
    });

    $('chatFab').onclick = () => setChatOpen(true);
    $('chatClose').onclick = () => setChatOpen(false);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && chatOpen) setChatOpen(false); });

    const quick = $('quick');
    QUICK_REPLIES.forEach((txt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qchip';
      b.textContent = txt;
      b.onclick = () => sendChat(txt);
      quick.appendChild(b);
    });

    const input = $('chatIn');
    const send = () => { sendChat(input.value); input.value = ''; };
    $('chatSend').onclick = send;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  // ---------- boot ----------
  renderDriverSelect();
  initMap();
  bindActions();
  MB.subscribe(refresh);
  ensureAtStart();
  refresh();
  setInterval(() => { ensureAtStart(); refresh(); }, 1000);
})();
