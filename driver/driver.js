/* Movia Bus - driver app. Depends on ../shared/core.js (window.MB) and Leaflet (window.L, optional). */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت المحطة', 'هتأخر شوية (5 دقايق)', 'الأتوبيس زحمة'];
  const STATUS_STEPS = [['scheduled', 'لم تبدأ'], ['en_route', 'في الطريق'], ['arrived', 'وصل الجامعة / انتهت']];

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
  function findTrip(id) { return MB.state.trips.find((t) => t.id === id); }

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

  function initMap() {
    if (typeof L === 'undefined') {
      $('map').innerHTML = '<p class="mute" style="padding:16px">الخريطة مش متاحة دلوقتي (محتاج إنترنت). التفاصيل تحت.</p>';
      return;
    }
    map = L.map('map', { scrollWheelZoom: false }).setView([30.04, 31.27], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    crowdLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 0);
  }

  function drawRoute(trip) {
    if (!map) return;
    routeLayer.clearLayers();
    const route = MB.R[trip.routeId];
    const poly = MB.polyOf(trip);
    L.polyline(poly, { color: route.color, weight: 6, opacity: 0.85 }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(poly), { padding: [30, 30] });
  }

  function renderDemand(trip) {
    const stops = MB.stopsOf(trip);
    const counts = MB.waitingCounts(trip.id);
    const sig = trip.id + '|' + stops.map((s) => counts[s] || 0).join(',');
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
    $('demandList').innerHTML = stops.map((sid) => {
      const n = counts[sid] || 0;
      return '<div class="row-item"><span class="grow">' + esc(MB.S[sid].name) + '</span>' +
        '<span class="badge' + (n ? ' info' : '') + '">' + n + ' منتظر</span></div>';
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

  // ---------- trip card ----------
  function renderHeader(trip) {
    const s = trip.status;
    $('tripTitle').textContent = MB.tripLabel(trip);
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'الأتوبيس ' + plate + ' · المقاعد المحجوزة ' + trip.booked + ' من ' + trip.capacity +
      (trip.waitlist ? ' · قايمة انتظار ' + trip.waitlist : '');

    const badge = $('statusBadge');
    badge.textContent = MB.statusLabel[s] || s;
    badge.className = 'badge ' + (s === 'en_route' ? 'info' : s === 'arrived' ? 'ok' : 'warn');

    const idx = s === 'en_route' ? 1 : s === 'arrived' ? 2 : 0;
    $('chain').innerHTML = STATUS_STEPS.map((st, i) =>
      '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' +
      (i === 0 && s === 'at_start' ? MB.statusLabel.at_start : st[1]) + '</li>').join('');

    $('autoBadge').hidden = s !== 'en_route';
    $('btnStart').disabled = !(s === 'scheduled' || s === 'at_start');
    $('btnEnd').disabled = s !== 'en_route';

    $('hint').textContent =
      s === 'en_route' ? 'ما تقفلش الشاشة عشان البث يفضل شغال.' :
      s === 'arrived' ? 'انتهت الرحلة. الرحلة الجاية هتظهر هنا تلقائيًا.' :
      'اضغط "ابدأ الرحلة" لما تتحرك من محطة البداية.';
  }

  function renderEta(trip) {
    const el = $('etaLine');
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    if (pos) {
      const eta = MB.etaMinutes(trip, pos.nextStopId);
      el.textContent = 'المحطة القادمة: ' + MB.S[pos.nextStopId].name + (eta != null ? ' · حوالي ' + eta + ' دقيقة' : '');
    } else if (trip.status === 'at_start' || trip.status === 'scheduled') {
      el.textContent = 'ميعاد الانطلاق ' + trip.time;
    } else {
      el.textContent = 'الرحلة خلصت';
    }
  }

  // ---------- save-time card ----------
  function renderSave(trip) {
    const box = $('saveList');
    if (trip.status !== 'en_route') {
      lastSaveSig = '';
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
    box.innerHTML = skip.map((sid) =>
      '<div class="row-item"><span class="grow">' + esc(MB.S[sid].name) + '</span>' +
      '<span class="mute">توفير ~' + seg + ' د</span>' +
      '<button class="btn sm sec" data-skip="' + esc(sid) + '" data-min="' + seg + '">تخطي</button></div>').join('') +
      '<p class="mute" style="margin-top:8px">إجمالي التوفير التقديري: ' + skip.length * seg + ' دقيقة</p>';
  }

  // ---------- chat ----------
  function renderChat(trip) {
    const msgs = (MB.state.chat || []).filter((m) => m.tripId === trip.id).sort((a, b) => a.ts - b.ts).slice(-50);
    const sig = trip.id + '|' + msgs.map((m) => m.id).join(',');
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    const box = $('chatList');
    if (!msgs.length) { box.innerHTML = '<p class="mute">مفيش رسايل لحد دلوقتي.</p>'; return; }
    box.innerHTML = msgs.map((m) =>
      '<div class="msg ' + (m.from === 'driver' ? 'me' : 'them') + '">' +
      '<div class="mute">' + (m.from === 'driver' ? 'أنت' : 'طالب') + ' · ' + MB.fmtTime(m.ts) + '</div>' +
      '<div>' + esc(maskPhones(m.text)) + '</div></div>').join('');
    box.scrollTop = box.scrollHeight;
  }

  function sendChat(text) {
    const t = currentTrip();
    const clean = String(text || '').trim().slice(0, 200);
    if (!t || !clean) return;
    MB.update((s) => {
      s.chat = s.chat || [];
      s.chat.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), tripId: t.id, from: 'driver', text: clean, ts: Date.now() });
    });
  }

  function setChatEnabled(on) {
    $('chatIn').disabled = !on;
    $('chatSend').disabled = !on;
    document.querySelectorAll('#quick .btn').forEach((b) => { b.disabled = !on; });
  }

  // ---------- main refresh (idempotent; called on every state change and every second) ----------
  function renderEmpty() {
    $('tripTitle').textContent = 'مفيش رحلات مسجلة ليك';
    $('tripMeta').textContent = 'اختار سائق تاني من فوق.';
    $('chain').innerHTML = '';
    $('statusBadge').textContent = '—';
    $('statusBadge').className = 'badge';
    $('autoBadge').hidden = true;
    $('btnStart').disabled = true;
    $('btnEnd').disabled = true;
    $('hint').textContent = '';
    $('etaLine').textContent = '';
    $('demandList').innerHTML = '<p class="mute">لا توجد محطات.</p>';
    $('saveList').innerHTML = '<p class="mute">لا توجد محطات.</p>';
    $('chatList').innerHTML = '<p class="mute">مفيش محادثة.</p>';
    if (map) { routeLayer.clearLayers(); crowdLayer.clearLayers(); busLayer.clearLayers(); }
    lastTripId = null; lastKey = ''; lastDemandSig = ''; lastSaveSig = ''; lastChatSig = '';
    setChatEnabled(false);
  }

  function refresh() {
    const trip = currentTrip();
    if (!trip) { renderEmpty(); return; }
    setChatEnabled(true);

    const key = trip.id + '|' + trip.status;
    if (key !== lastKey) { lastKey = key; renderHeader(trip); }
    if (trip.id !== lastTripId) {
      lastTripId = trip.id;
      lastDemandSig = ''; lastSaveSig = ''; lastChatSig = '';
      drawRoute(trip);
    }
    renderBus(trip);
    renderEta(trip);
    renderDemand(trip);
    renderSave(trip);
    renderChat(trip);
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
    $('btnStart').onclick = () => {
      const t = currentTrip();
      if (!t || (t.status !== 'scheduled' && t.status !== 'at_start')) return;
      MB.update((s) => {
        const x = s.trips.find((z) => z.id === t.id);
        if (x) { x.status = 'en_route'; x.startedAt = Date.now(); }
      });
      MB.notify('بدأت رحلة ' + MB.tripLabel(t), 'bus');
      toast('بدأت الرحلة، البث التلقائي شغال');
    };

    $('btnEnd').onclick = () => {
      const t = currentTrip();
      if (!t || t.status !== 'en_route') return;
      if (!window.confirm('متأكد إنك عايز تنهي الرحلة؟')) return;
      MB.update((s) => {
        const x = s.trips.find((z) => z.id === t.id);
        if (x) x.status = 'arrived';
      });
      toast('تم إنهاء الرحلة. شكرًا يا أستاذ');
    };

    $('saveList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-skip]');
      if (b) openSkip(b.getAttribute('data-skip'), Number(b.getAttribute('data-min')) || 1);
    });

    const quick = $('quick');
    QUICK_REPLIES.forEach((txt) => {
      const b = document.createElement('button');
      b.className = 'btn sec sm';
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
