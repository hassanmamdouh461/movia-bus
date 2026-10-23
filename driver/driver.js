/* Movia Bus — Driver Interface (two-button control, students' Ready requests, inline chat).
   No stations: the bus drives the route line; students' Ready requests appear as anonymous pins. */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت نقطة الركوب', 'هنتظر دقيقة', 'هتأخر 5 دقائق'];
  const STATUS_STEPS = [['scheduled', 'لم تبدأ'], ['en_route', 'في الطريق'], ['arrived', 'وصل الجامعة / انتهت']];
  const SEED_CHAT = [
    { from: 'student', text: 'السلام عليكم يا كابتن، الحافلة فين حالياً؟', ago: 12 * 60000 },
    { from: 'driver', text: 'وعليكم السلام، أنا في الطريق وهشوف طلبات الركوب', ago: 10 * 60000 },
    { from: 'student', text: 'تمام، أنا منتظر عند نقطة الركوب', ago: 3 * 60000 },
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

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  function isPaused(trip) {
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    return !!(pos && pos.paused);
  }

  /* ---- distance along the route (metres), from the polyline ---- */
  const cumCache = {};
  function cumOf(trip) {
    const key = trip.routeId + ':' + trip.direction;
    if (!cumCache[key]) {
      const poly = MB.polyOf(trip), cum = [0];
      for (let i = 1; i < poly.length; i++) {
        const dy = (poly[i][0] - poly[i - 1][0]) * 111000, dx = (poly[i][1] - poly[i - 1][1]) * 96000;
        cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
      }
      cumCache[key] = cum;
    }
    return cumCache[key];
  }
  function metersAt(trip, p) {
    const cum = cumOf(trip), n = cum.length;
    const f = Math.max(0, Math.min(1, p)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f)), t = f - i;
    return cum[i] + (cum[i + 1] - cum[i]) * t;
  }
  function distAhead(trip, pk, pos) { return Math.max(0, metersAt(trip, pk.progress) - metersAt(trip, pos.progress)); }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' م' : (m / 1000).toFixed(1) + ' كم'; }
  function secsLeft(k) { return Math.max(0, Math.ceil(((k.boardingUntil || 0) - Date.now()) / 1000)); }

  /* active requests still ahead of the bus, nearest first (boarding ones on top) */
  function aheadRequests(trip) {
    const pos = MB.position(trip);
    if (!pos) return [];
    const out = [];
    MB.pickupsOf(trip.id, true).forEach((k) => {
      if (k.status === 'boarding') { out.push({ k, eta: 0, dist: 0 }); return; }
      const eta = MB.etaToPickup(trip, k);
      if (eta == null) return;
      out.push({ k, eta, dist: distAhead(trip, k, pos) });
    });
    return out.sort((a, b) => (b.k.status === 'boarding') - (a.k.status === 'boarding') || a.dist - b.dist);
  }

  let map = null, routeLayer = null, pinLayer = null, busLayer = null;
  let lastTripId = null, lastPinSig = '', lastReqSig = '', lastChatSig = '';
  let knownPickups = null;

  function initMap() {
    if (typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([30.04, 31.27], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
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
    const term = (latlng, name, cls) => L.marker(latlng, {
      icon: L.divIcon({
        className: 'mb-icon',
        html: '<div class="pin term ' + cls + '">' + esc(name) + '</div>',
        iconSize: [170, 24],
        iconAnchor: [85, 12],
      }),
    }).addTo(routeLayer);
    term(poly[0], trip.direction === 'go' ? route.fromName : route.toName, 'start');
    term(poly[poly.length - 1], trip.direction === 'go' ? route.toName : route.fromName, 'end');
    map.fitBounds(L.latLngBounds(poly), { padding: [28, 28] });
  }

  function renderPins(trip) {
    if (!map) return;
    const act = MB.pickupsOf(trip.id, true);
    const sig = trip.id + '|' + act.map((k) => k.id + k.status).join(',');
    if (sig === lastPinSig) return;
    lastPinSig = sig;
    pinLayer.clearLayers();
    act.forEach((k) => {
      const cls = k.status === 'accepted' ? 'acc' : k.status === 'boarding' ? 'brd' : 'wait';
      const tip = k.status === 'accepted' ? 'هتقف له' : k.status === 'boarding' ? 'واقف — بيركبوا' : 'طلب ركوب منتظر';
      L.marker([k.lat, k.lng], {
        icon: L.divIcon({
          className: 'mb-icon',
          html: '<div class="pin req ' + cls + '">طالب</div>',
          iconSize: [44, 26],
          iconAnchor: [22, 13],
        }),
      }).bindTooltip(tip).addTo(pinLayer);
    });
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
    const paused = isPaused(trip);
    const state = !trip ? 'off' : paused ? 'paused' : trip.status === 'en_route' ? 'live' : 'on';
    const pill = $('statusPill');
    pill.dataset.state = state;
    $('statusText').textContent =
      state === 'paused' ? 'واقف للركوب' :
      state === 'live' ? 'بث الموقع شغال أثناء الرحلة' : 'متصل (لا يتم تتبعك خارج الرحلة)';
  }

  function renderHeader(trip) {
    const s = trip.status;
    const paused = isPaused(trip);
    $('tripTitle').textContent = MB.tripLabel(trip);
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'حافلة: ' + plate + ' · الحجوزات: ' + trip.booked + ' من ' + trip.capacity +
      (trip.waitlist ? ' · انتظار: ' + trip.waitlist : '');

    const idx = s === 'en_route' ? 1 : s === 'arrived' ? 2 : 0;
    $('chain').innerHTML = STATUS_STEPS.map((st, i) => {
      let label = st[1];
      if (i === 0 && s === 'at_start') label = MB.statusLabel.at_start;
      if (i === 1 && paused) label = 'واقف للركوب';
      return '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' + label + '</li>';
    }).join('');

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
      'اضغط «ابدأ الرحلة» عند التحرك من نقطة البداية لتظهر الحافلة فوراً للطلاب.';
    $('chatSub').textContent = MB.tripLabel(trip);
  }

  function setNext(label, name, badge, num, unit) {
    $('nextLabel').textContent = label;
    $('nextName').textContent = name;
    $('nextWait').textContent = badge;
    $('etaNum').textContent = num;
    $('etaUnit').textContent = unit;
  }

  function renderNext(trip) {
    const card = $('nextCard');
    const route = MB.R[trip.routeId];
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    const reqs = pos ? aheadRequests(trip) : [];
    const waitCount = MB.pickupsOf(trip.id, true).filter((k) => k.status === 'waiting').length;
    const boarding = reqs.find((r) => r.k.status === 'boarding');
    const nearest = reqs.find((r) => r.k.status === 'waiting') || reqs.find((r) => r.k.status === 'accepted');
    const hot = !!(nearest && nearest.k.status === 'waiting' && !boarding);
    card.classList.toggle('hot', hot);

    if (boarding) {
      setNext('واقف للركوب', 'الطلاب بيركبوا دلوقتي', 'باقي ' + secsLeft(boarding.k) + ' ث',
        String(secsLeft(boarding.k)), 'ثانية');
    } else if (nearest) {
      const isWait = nearest.k.status === 'waiting';
      setNext(isWait ? 'أقرب طلب ركوب' : 'أقرب موقف مؤكد',
        'طالب على بُعد ' + fmtDist(nearest.dist),
        isWait ? 'ينتظر · ' + waitCount + ' طلب نشط' : 'هتقف له',
        String(nearest.eta), 'دقيقة');
    } else if (pos) {
      setNext('الطريق قدامك', route.toName, 'مفيش طلبات قدامك', '—', '');
    } else if (trip.status === 'scheduled' || trip.status === 'at_start') {
      setNext('موعد الانطلاق', route.fromName, 'طلبات منتظرة: ' + waitCount, trip.time, 'موعد البدء');
    } else {
      setNext('نهاية المسار', route.toName, 'تم الوصول', '✓', 'انتهت');
    }
  }

  function renderReqs(trip) {
    const box = $('reqList');
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    const reqs = pos ? aheadRequests(trip) : [];
    const sig = trip.id + '|' + (pos ? 1 : 0) + '|' + reqs.map((r) =>
      r.k.id + ':' + r.k.status + ':' + (r.k.status === 'boarding' ? secsLeft(r.k) : r.eta)).join(',');
    if (sig === lastReqSig) return;
    lastReqSig = sig;
    $('reqCount').textContent = reqs.length;

    if (!pos) {
      box.innerHTML = '<p class="mute req-empty">طلبات الركوب بتظهر هنا لما الرحلة تبدأ.</p>';
      return;
    }
    if (!reqs.length) {
      box.innerHTML = '<p class="mute req-empty">مفيش طلبات ركوب قدامك حالياً.</p>';
      return;
    }
    box.innerHTML = reqs.map((r) => {
      const k = r.k, id = esc(k.id);
      if (k.status === 'boarding') {
        return '<div class="req-row boarding">' +
          '<div class="req-info"><strong>طالب</strong>' +
          '<span class="req-state brd">واقف — الطلاب بيركبوا</span>' +
          '<span class="req-count">باقي ' + secsLeft(k) + ' ث</span></div></div>';
      }
      if (k.status === 'accepted') {
        return '<div class="req-row accepted">' +
          '<div class="req-info"><strong>طالب</strong>' +
          '<span class="req-state acc">هتقف بعد ' + r.eta + ' دقيقة</span></div></div>';
      }
      return '<div class="req-row waiting">' +
        '<div class="req-info"><strong>طالب</strong>' +
        '<span class="req-state wait">على بُعد ' + fmtDist(r.dist) + ' · يوصل خلال ' + r.eta + ' د</span></div>' +
        '<div class="req-actions">' +
        '<button class="btn ok big" type="button" data-accept="' + id + '">تمام، هقف له</button>' +
        '</div></div>';
    }).join('');
  }

  /* subtle alert when a NEW waiting request shows up for one of this driver's trips */
  function checkNewRequests() {
    const all = MB.state.pickups.filter((k) => k.status === 'waiting');
    if (knownPickups === null) { knownPickups = new Set(all.map((k) => k.id)); return; }
    const myTrips = driverTrips().map((t) => t.id);
    const fresh = all.filter((k) => !knownPickups.has(k.id));
    all.forEach((k) => knownPickups.add(k.id));
    if (fresh.some((k) => myTrips.indexOf(k.tripId) >= 0)) {
      if (navigator.vibrate) { try { navigator.vibrate([120]); } catch (e) {} }
      toast('طلب ركوب جديد من طالب على المسار');
    }
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
    checkNewRequests();
    const trip = currentTrip();
    if (!trip) return;
    if (seedChat(trip)) return;

    renderHeader(trip);
    if (trip.id !== lastTripId) {
      lastTripId = trip.id;
      lastPinSig = ''; lastReqSig = ''; lastChatSig = '';
      drawRoute(trip);
    }
    renderPill(trip);
    renderBus(trip);
    renderNext(trip);
    renderPins(trip);
    renderReqs(trip);
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

    $('reqList').addEventListener('click', (e) => {
      const a = e.target.closest('button[data-accept]');
      if (a) { MB.acceptPickup(a.dataset.accept); toast('تم — هتقف للطالب على المسار'); }
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
