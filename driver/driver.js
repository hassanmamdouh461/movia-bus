/* Movia Bus — Driver Interface (Simple two-button control, station demand, inline chat) */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت المحطة', 'هنتظر دقيقة', 'هتأخر 5 دقائق'];
  const STATUS_STEPS = [['scheduled', 'لم تبدأ'], ['en_route', 'في الطريق'], ['arrived', 'وصل الجامعة / انتهت']];
  const SEED_CHAT = [
    { from: 'student', text: 'السلام عليكم يا كابتن، الحافلة فين حالياً؟', ago: 12 * 60000 },
    { from: 'driver', text: 'وعليكم السلام، أنا في الطريق للمحطة', ago: 10 * 60000 },
    { from: 'student', text: 'تمام، أنا منتظر عند المحطة', ago: 3 * 60000 },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const maskPhones = (t) => String(t).replace(/\+?\d[\d\s-]{6,}\d/g, '••••');

  function loadDriverId() {
    let id = null;
    try { id = localStorage.getItem(DRIVER_KEY); } catch (e) {}
    return MB.drivers.some((d) => d.id === id) ? id : MB.drivers[0].id;
  }
  function saveDriverId(id) { try { localStorage.setItem(DRIVER_KEY, id); } catch (e) {} }
  let driverId = loadDriverId();
  let selectedTripId = null;

  function driverTrips() {
    return MB.state.trips
      .filter((t) => t.driverId === driverId && t.status !== 'cancelled')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  function currentTrip() {
    const list = driverTrips();
    if (selectedTripId) {
      const found = list.find((t) => t.id === selectedTripId);
      if (found) return found;
    }
    return list.find((t) => t.status === 'en_route')
      || list.find((t) => t.status === 'at_start' || t.status === 'scheduled')
      || list[0]
      || null;
  }

  function nextIndex(trip) {
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    return pos ? pos.nextStopIdx : -1;
  }

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  let map = null, routeLayer = null, crowdLayer = null, busLayer = null;
  let lastTripId = null, lastDemandSig = '', lastSaveSig = '', lastChatSig = '';

  function initMap() {
    if (typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([30.04, 31.27], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    crowdLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 50);
    window.addEventListener('resize', () => map && map.invalidateSize());
  }

  function drawRoute(trip) {
    if (!map) return;
    routeLayer.clearLayers();
    const route = MB.R[trip.routeId];
    const poly = MB.polyOf(trip);
    L.polyline(poly, { color: route.color, weight: 6, opacity: 0.9 }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(poly), { padding: [28, 28] });
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
            html: '<div class="pin ' + (n > 0 ? 'crowd' : '') + '">' + n + '</div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          }),
        }).bindTooltip(st.name + ': ' + n + ' منتظر').addTo(crowdLayer);
      });
    }
    $('demandList').innerHTML = stops.map((sid, i) => {
      const n = counts[sid] || 0;
      const cls = i < nextIdx ? 'passed' : i === nextIdx ? 'next' : '';
      return '<div class="stop-row ' + cls + '"><span class="stop-dot"></span>' +
        '<span class="grow">' + (i + 1) + '. ' + esc(MB.S[sid].name) + '</span>' +
        '<span class="' + chipClass(n) + '">' + (n > 0 ? n + ' طالب منتظر' : '0 — محطة خالية') + '</span></div>';
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
          html: '<div class="pin bus">الحافلة</div>',
          iconSize: [68, 28],
          iconAnchor: [34, 14],
        }),
      }).addTo(busLayer);
    } else {
      busLayer.eachLayer((m) => m.setLatLng([pos.lat, pos.lng]));
    }
  }

  function renderPill(trip) {
    const state = !trip ? 'off' : trip.status === 'en_route' ? 'live' : 'on';
    const pill = $('statusPill');
    pill.dataset.state = state;
    $('statusText').textContent = state === 'live' ? 'بث الموقع شغال أثناء الرحلة' : 'متصل (لا يتم تتبعك خارج الرحلة)';
  }

  function renderHeader(trip) {
    const s = trip.status;
    $('tripTitle').textContent = MB.tripLabel(trip);
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'حافلة: ' + plate + ' · الحجوزات: ' + trip.booked + ' من ' + trip.capacity +
      (trip.waitlist ? ' · انتظار: ' + trip.waitlist : '');

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
      btn.textContent = 'إعادة تشغيل الرحلة (للتجربة)';
      btn.className = 'btn big go-btn sec';
      btn.disabled = false;
    }

    $('hint').textContent =
      s === 'en_route' ? 'حالة الرحلة وموقعك يتحدثان تلقائياً للطلاب والإدارة لحظياً.' :
      s === 'arrived' ? 'انتهت هذه الرحلة. يمكنك اختيار رحلة أخرى من القائمة أو إعادة تشغيلها للتجربة.' :
      'اضغط «ابدأ الرحلة» عند التحرك من محطة البداية لتظهر الحافلة فوراً للطلاب.';
    $('chatSub').textContent = MB.tripLabel(trip);
  }

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
      $('nextLabel').textContent = 'محطة الانطلاق';
      $('nextName').textContent = MB.S[first].name;
      $('nextWait').textContent = (counts[first] || 0) + ' طالب منتظر';
      $('etaNum').textContent = trip.time;
      $('etaUnit').textContent = 'موعد البدء';
    } else {
      $('nextLabel').textContent = 'نهاية المسار';
      $('nextName').textContent = MB.S[stops[stops.length - 1]].name;
      $('nextWait').textContent = 'تم الوصول';
      $('etaNum').textContent = '✓';
      $('etaUnit').textContent = 'انتهت';
    }
  }

  function renderSave(trip) {
    const box = $('saveList');
    const skip = trip.status === 'en_route'
      ? MB.emptyAhead(trip)
      : MB.stopsOf(trip).slice(1, -1).filter((sid) => !(MB.waitingCounts(trip.id)[sid] > 0));
    const stops = MB.stopsOf(trip);
    const seg = Math.max(1, Math.round(((MB.TRIP_MS / 60000) * 3) / (stops.length - 1)));
    const sig = trip.id + '|' + trip.status + '|' + skip.join(',') + '|' + seg;
    if (sig === lastSaveSig) return;
    lastSaveSig = sig;
    if (!skip.length) {
      box.innerHTML = '<p class="mute" style="margin:0">جميع المحطات القادمة عليها طلاب منتظرون حالياً.</p>';
      return;
    }
    box.innerHTML =
      '<p class="save-sum">يوجد <b>' + skip.length + '</b> محطات خالية بدون أي طلاب منتظرين · يمكنك تخطيها وتوفير <b>~' +
      (skip.length * seg) + ' دقيقة</b>:</p>' +
      skip.map((sid) =>
        '<div class="row-item"><span class="grow">' + esc(MB.S[sid].name) + '</span>' +
        '<span class="badge ok">توفير ~' + seg + ' د</span>' +
        '<button class="btn sm sec" type="button" data-skip="' + esc(sid) + '" data-min="' + seg + '">تأكيد التخطي</button></div>').join('');
  }

  function chatMsgs(trip) {
    return (MB.state.chat || []).filter((m) => m.tripId === trip.id).sort((a, b) => a.ts - b.ts);
  }

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

  function renderChat(trip) {
    const msgs = chatMsgs(trip).slice(-50);
    const sig = trip.id + '|' + msgs.map((m) => m.id).join(',');
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    const box = $('chatList');
    box.innerHTML = msgs.length
      ? msgs.map((m) =>
          '<div class="bubble ' + (m.from === 'driver' ? 'driver' : 'student') + '">' +
          '<span>' + esc(maskPhones(m.text)) + '</span>' +
          '<time>' + (m.from === 'driver' ? 'أنت · ' : 'طالب · ') + MB.fmtTime(m.ts) + '</time></div>'
        ).join('')
      : '<p class="mute" style="margin:auto">لا توجد رسائل بعد.</p>';
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

  function renderTripSelect() {
    const list = driverTrips();
    const sel = $('tripSel');
    const cur = currentTrip();
    sel.innerHTML = list.map((t) =>
      '<option value="' + esc(t.id) + '"' + (cur && cur.id === t.id ? ' selected' : '') + '>' +
      esc(MB.tripLabel(t)) + ' (' + esc(MB.statusLabel[t.status]) + ')</option>'
    ).join('');
  }

  function refresh() {
    renderTripSelect();
    const trip = currentTrip();
    if (!trip) return;
    if (seedChat(trip)) return;

    renderHeader(trip);
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
  }

  function renderDriverSelect() {
    const sel = $('driverSel');
    sel.innerHTML = MB.drivers.map((d) => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('');
    sel.value = driverId;
    sel.onchange = () => {
      driverId = sel.value;
      selectedTripId = null;
      saveDriverId(driverId);
      lastTripId = null;
      refresh();
    };
  }

  function bindActions() {
    $('tripSel').onchange = () => {
      selectedTripId = $('tripSel').value;
      lastTripId = null;
      refresh();
    };

    $('btnMain').onclick = () => {
      const t = currentTrip();
      if (!t) return;
      if (t.status === 'scheduled' || t.status === 'at_start' || t.status === 'arrived') {
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) { x.status = 'en_route'; x.startedAt = Date.now() - 45000; }
        });
        MB.notify('انطلقت الحافلة في ' + MB.tripLabel(t), 'bus');
        toast('بدأت الرحلة وتم تفعيل البث التلقائي للموقع');
      } else if (t.status === 'en_route') {
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) x.status = 'arrived';
        });
        toast('تم إنهاء الرحلة وتوقف بث الموقع تلقائياً');
      }
    };

    $('saveList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-skip]');
      if (!b) return;
      toast('تم تخطي محطة «' + MB.S[b.dataset.skip].name + '» الخالية · توفير ~' + b.dataset.min + ' دقائق');
    });

    $('quick').innerHTML = QUICK_REPLIES.map((q) =>
      '<button class="qchip" type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('');
    $('quick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (b) sendChat(b.dataset.q);
    });

    const submit = () => {
      const inp = $('chatIn');
      const v = inp.value;
      if (!v.trim()) return;
      inp.value = '';
      sendChat(v);
    };
    $('chatSend').onclick = submit;
    $('chatIn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  initMap();
  renderDriverSelect();
  bindActions();
  refresh();
  MB.subscribe(refresh);
  setInterval(refresh, 1000);
})();
