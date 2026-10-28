/* Lotus Bus — Driver Interface (two-button control, students' Ready requests, inline chat).
   No stations: the bus drives the route line; students' Ready requests appear as anonymous pins. */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت نقطة الركوب', 'هنتظر دقيقة', 'هتأخر 5 دقائق'];
  const STATUS_STEPS = [['scheduled', 'لم تبدأ'], ['en_route', 'في الطريق'], ['arrived', 'وصل الجامعة / انتهت']];
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

  function driverTrips() {
    return MB.state.trips
      .filter((t) => t.driverId === driverId && t.status !== 'cancelled' && t.published !== false)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  /* Mandatory trip assigned by Admin in strict chronological order (driver cannot pick or skip) */
  function currentTrip() {
    const list = driverTrips();
    return list.find((t) => t.status === 'en_route')
      || list.find((t) => t.status === 'at_start' || t.status === 'scheduled')
      || list[list.length - 1]
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
  // map focus: 'auto' keeps the bus and the nearest student request in frame, 'manual' leaves the map to the driver
  let focusMode = 'auto', lastFitAt = 0, lastFitKey = '', focusBtn = null;

  function initMap() {
    if (typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([28.11, 30.80], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    const takeOver = () => { if (focusMode === 'auto') { focusMode = 'manual'; updateFocusBtn(); } };
    map.on('dragstart', takeOver);
    map.getContainer().addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.leaflet-control-zoom')) takeOver(); });
    const FocusCtl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const b = L.DomUtil.create('button', 'btn sm map-focus-btn');
        b.type = 'button';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => {
          focusMode = focusMode === 'auto' ? 'manual' : 'auto';
          lastFitKey = ''; lastFitAt = 0;
          if (focusMode === 'manual' && lastTrip) map.fitBounds(L.latLngBounds(MB.polyOf(lastTrip)), { padding: [28, 28] });
          updateFocusBtn();
          if (lastTrip) autoFocus(lastTrip);
        });
        focusBtn = b;
        return b;
      },
    });
    new FocusCtl().addTo(map);
    updateFocusBtn();
    setTimeout(() => map.invalidateSize(), 50);
    window.addEventListener('resize', () => map && map.invalidateSize());
  }

  let lastTrip = null;
  function updateFocusBtn() {
    if (focusBtn) focusBtn.textContent = focusMode === 'auto' ? 'عرض المسار كله' : 'تتبّع تلقائي';
  }

  /* Auto focus: while the trip is running, keep the bus and the nearest student request in frame
     (zoomed in close); with no requests ahead just follow the bus; while boarding stay on the bus. */
  function autoFocus(trip) {
    if (!map || focusMode !== 'auto' || trip.status !== 'en_route') return;
    const pos = MB.position(trip);
    if (!pos) return;
    const reqs = aheadRequests(trip);
    const target = reqs[0];
    const now = Date.now();
    const bus = [pos.lat, pos.lng];
    if (target && target.k.status !== 'boarding') {
      const key = 'req|' + target.k.id;
      // refit when the nearest request changes, otherwise every 2s as the bus closes in
      if (key === lastFitKey && now - lastFitAt < 2000) return;
      lastFitKey = key; lastFitAt = now;
      map.fitBounds(L.latLngBounds([bus, [target.k.lat, target.k.lng]]), { padding: [60, 60], maxZoom: 17, animate: true, duration: 0.8 });
    } else {
      const key = target ? 'brd' : 'follow';
      if (key === lastFitKey && now - lastFitAt < 1500) return;
      lastFitKey = key; lastFitAt = now;
      map.setView(bus, target ? 17 : 15, { animate: true, duration: 0.8 });
    }
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
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    }).addTo(routeLayer);
    term(poly[0], trip.direction === 'go' ? route.fromName : route.toName, 'start');
    term(poly[poly.length - 1], trip.direction === 'go' ? route.toName : route.fromName, 'end');
    map.fitBounds(L.latLngBounds(poly), { padding: [28, 28] });
    lastFitKey = ''; lastFitAt = 0;
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
          iconSize: [0, 0],
          iconAnchor: [0, 0],
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
          iconSize: [0, 0],
          iconAnchor: [0, 0],
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
    document.body.classList.toggle('pre-trip', s !== 'en_route');
    const paused = isPaused(trip);
    const list = driverTrips();
    const posInSched = list.findIndex((t) => t.id === trip.id);
    const sb = $('schedBadge');
    if (sb) {
      sb.textContent = list.length
        ? 'رحلة ' + (posInSched + 1) + ' من ' + list.length + ' · إلزامية من الإدارة 🔒'
        : 'جدول إلزامي من الإدارة 🔒';
    }
    $('tripTitle').textContent = MB.tripLabel(trip);
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'حافلة: ' + plate + ' · المسجّلون: ' + trip.booked;

    const idx = s === 'en_route' ? 1 : s === 'arrived' ? 2 : 0;
    $('chain').innerHTML = STATUS_STEPS.map((st, i) => {
      let label = st[1];
      if (i === 0 && s === 'at_start') label = MB.statusLabel.at_start;
      if (i === 1 && paused) label = 'واقف للركوب';
      return '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' + label + '</li>';
    }).join('');

    const btn = $('btnMain');
    if (s === 'en_route') {
      btn.textContent = 'أنهِ الرحلة والانتقال للتالية';
      btn.className = 'btn big go-btn bad';
      btn.disabled = false;
    } else if (s === 'scheduled' || s === 'at_start') {
      btn.textContent = 'ابدأ الرحلة الإلزامية الآن';
      btn.className = 'btn big go-btn ok';
      btn.disabled = false;
    } else {
      btn.textContent = 'أتممت جدول اليوم — إعادة فتح الجدول (للتجربة)';
      btn.className = 'btn big go-btn sec';
      btn.disabled = false;
    }

    $('hint').textContent =
      s === 'en_route' ? 'حالة الرحلة وموقعك يتحدثان تلقائياً للطلاب والإدارة لحظياً.' :
      s === 'arrived' ? 'أتممت جميع رحلات جدولك الإلزامي المعتمد من الإدارة لهذا اليوم ✓' :
      'هذه رحلتك الإلزامية الحالية المقررة من الإدارة. اضغط «ابدأ الرحلة» عند التحرك من نقطة البداية.';
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
    const waitCount = MB.pickupsOf(trip.id, true).filter((k) => k.status === 'accepted').length;
    const boarding = reqs.find((r) => r.k.status === 'boarding');
    const nearest = reqs.find((r) => r.k.status === 'accepted') || reqs.find((r) => r.k.status === 'accepted');
    const hot = !!(nearest && nearest.k.status === 'accepted' && !boarding);
    card.classList.toggle('hot', hot);

    if (boarding) {
      setNext('واقف للركوب', 'الطلاب بيركبوا دلوقتي', 'باقي ' + secsLeft(boarding.k) + ' ث',
        String(secsLeft(boarding.k)), 'ثانية');
    } else if (nearest) {
      const isWait = nearest.k.status === 'accepted';
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
      box.innerHTML = '<p class="mute req-empty">تتفتح طلبات الركوب تلقائياً بمجرد ضغط «ابدأ الرحلة».</p>';
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
          '<span class="req-state acc">هتقف بعد ' + r.eta + ' دقيقة · على بُعد ' + fmtDist(r.dist) + '</span></div></div>';
      }
      return '<div class="req-row waiting">' +
        '<div class="req-info"><strong>طالب</strong>' +
        '<span class="req-state wait">على بُعد ' + fmtDist(r.dist) + ' · يوصل خلال ' + r.eta + ' د</span></div>' +
        '<div class="req-actions">' +
        '<button class="btn ok big" type="button" data-accept="' + id + '">تمام، هقف له</button>' +
        '</div></div>';
    }).join('');
  }

  /* ---- driver-safety alerts: chime (Web Audio), Arabic voice, vibration, top banner ---- */
  const ALERT_KEY = 'lotus_driver_alerts';
  let alertsEnabled = true;
  try { alertsEnabled = localStorage.getItem(ALERT_KEY) !== '0'; } catch (e) {}
  let audioCtx = null, audioReady = false, bannerTimer = null, voiceTimer = null;

  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    return audioCtx;
  }

  function updateAudioHint() { $('audioHint').hidden = audioReady; }

  /* Browsers only allow audio after a user gesture: unlock on the first tap/key, and when the trip starts. */
  function unlockAudio() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const buf = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) {}
    Promise.resolve(ctx.resume ? ctx.resume() : null).catch(() => {}).then(() => {
      if (ctx.state === 'running' && !audioReady) {
        audioReady = true;
        document.removeEventListener('pointerdown', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
      }
      updateAudioHint();
    });
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  function playChime() {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    try {
      const t0 = ctx.currentTime;
      [[784, 0], [1047, 0.24]].forEach(([freq, dt]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + dt);
        gain.gain.exponentialRampToValueAtTime(0.4, t0 + dt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + dt);
        osc.stop(t0 + dt + 0.22);
      });
    } catch (e) {}
  }

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const arNum = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[d]);
  /* same thresholds as fmtDist, spoken in Arabic */
  function speechDist(m) {
    return m < 1000 ? arNum(Math.round(m)) + ' متر' : arNum((m / 1000).toFixed(1).replace('.', '٫')) + ' كيلومتر';
  }

  function speak(text) {
    try {
      if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
      const voices = speechSynthesis.getVoices() || [];
      const voice = voices.find((v) => /^ar[-_]EG/i.test(v.lang)) || voices.find((v) => /^ar/i.test(v.lang));
      if (!voice) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang || 'ar-EG';
      u.rate = 0.95;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  function hideBanner() {
    clearTimeout(bannerTimer);
    $('alertBanner').hidden = true;
  }

  function showBanner(r, more) {
    const b = $('alertBanner');
    $('alertTitle').textContent = 'طالب جديد قدامك — ' + fmtDist(r.dist);
    $('alertSub').textContent = 'يوصل خلال ' + (r.eta < 1 ? 'أقل من دقيقة' : r.eta + ' دقيقة');
    $('alertMore').textContent = more > 0 ? '+' + more + ' طلبات' : '';
    $('alertMore').hidden = !(more > 0);
    b.hidden = false;
    b.classList.remove('show');
    void b.offsetWidth; // restart the entrance animation
    b.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 6000);
  }

  /* r = { dist (m), eta (min) } of the nearest new request; more = other new requests arriving together */
  function fireAlert(r, more) {
    playChime();
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) {} }
    showBanner(r, more);
    clearTimeout(voiceTimer);
    voiceTimer = setTimeout(() => speak('طالب جديد قدامك، على بعد ' + speechDist(r.dist)), 900);
  }

  function alertsOn() { return alertsEnabled; }

  /* new (accepted|waiting) requests ahead of the bus on the trip being driven, not seen by this page before */
  function checkNewRequests() {
    const active = MB.state.pickups.filter((k) => k.status === 'accepted' || k.status === 'waiting');
    if (knownPickups === null) { knownPickups = new Set(active.map((k) => k.id)); return; }
    const fresh = active.filter((k) => !knownPickups.has(k.id));
    active.forEach((k) => knownPickups.add(k.id));
    const drive = driverTrips().find((t) => t.status === 'en_route');
    if (!drive || !fresh.length) return;
    const freshIds = new Set(fresh.filter((k) => k.tripId === drive.id).map((k) => k.id));
    if (!freshIds.size) return;
    const ahead = aheadRequests(drive)
      .filter((r) => freshIds.has(r.k.id) && r.k.status !== 'boarding')
      .sort((a, b) => a.dist - b.dist);
    if (!ahead.length || !alertsOn()) return;
    fireAlert(ahead[0], ahead.length - 1);
  }

  function renderAlertToggle() {
    const b = $('alertToggle');
    b.textContent = '🔔 التنبيهات: ' + (alertsEnabled ? 'تشغيل' : 'إيقاف');
    b.setAttribute('aria-pressed', String(alertsEnabled));
    if (!alertsEnabled) hideBanner();
  }

  function chatMsgs(trip) {
    return (MB.state.chat || []).filter((m) => m.tripId === trip.id).sort((a, b) => a.ts - b.ts);
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

  function renderSchedule(cur) {
    const box = $('drvSchedule');
    if (!box) return;
    const list = driverTrips();
    if (!list.length) {
      box.innerHTML = '<div class="drv-sched-head"><strong>📋 جدولك اليومي من الإدارة</strong><span class="mute">لا توجد رحلات معتمدة لك حالياً</span></div>';
      return;
    }
    const items = list.map((t, i) => {
      const r = MB.R[t.routeId] || {};
      const dir = t.direction === 'go' ? 'ذهاب' : 'عودة';
      const isCur = cur && cur.id === t.id && t.status !== 'arrived';
      const isDone = t.status === 'arrived';
      const cls = isDone ? 'done' : isCur ? 'cur' : 'locked';
      const stateTxt = isDone
        ? '✓ تم التنفيذ'
        : isCur
          ? (t.status === 'en_route' ? '● جارية الآن' : '● رحلتك الإلزامية الآن')
          : '🔒 تالية بالترتيب';
      return '<div class="drv-sched-item ' + cls + '">' +
        '<span class="drv-sched-num">' + (i + 1) + '</span>' +
        '<div class="drv-sched-main">' +
          '<strong>' + esc(t.time) + ' · ' + esc(r.name || '') + ' (' + dir + ')</strong>' +
        '</div>' +
        '<span class="drv-sched-tag">' + stateTxt + '</span>' +
      '</div>';
    }).join('');
    box.innerHTML =
      '<div class="drv-sched-head">' +
        '<strong>📋 جدولك اليومي المعتمد من الإدارة (' + list.length + ' رحلات)</strong>' +
        '<span class="mute">يُنفّذ بالترتيب الإلزامي ولا يمكن تخطي رحلة</span>' +
      '</div>' +
      '<div class="drv-sched-list">' + items + '</div>';
  }

  function refresh() {
    checkNewRequests();
    const trip = currentTrip();
    renderSchedule(trip);
    if (!trip) return;

    renderHeader(trip);
    if (trip.id !== lastTripId) {
      lastTripId = trip.id;
      lastPinSig = ''; lastReqSig = ''; lastChatSig = '';
      drawRoute(trip);
    }
    renderPill(trip);
    renderBus(trip);
    lastTrip = trip;
    autoFocus(trip);
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
      saveDriverId(driverId);
      lastTripId = null;
      refresh();
    };
  }

  function bindActions() {
    $('alertToggle').onclick = () => {
      alertsEnabled = !alertsEnabled;
      try { localStorage.setItem(ALERT_KEY, alertsEnabled ? '1' : '0'); } catch (e) {}
      renderAlertToggle();
      if (alertsEnabled) unlockAudio();
    };
    /* test always fires (explicit action), with a fake 800 m request */
    $('alertTest').onclick = () => {
      unlockAudio();
      fireAlert({ dist: 800, eta: 2 }, 0);
    };
    $('alertBanner').addEventListener('click', hideBanner);

    $('btnMain').onclick = () => {
      unlockAudio();
      const t = currentTrip();
      if (!t) return;
      if (t.status === 'scheduled' || t.status === 'at_start') {
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) { x.status = 'en_route'; x.startedAt = Date.now() - 45000; }
        });
        MB.notify('انطلقت الحافلة في ' + MB.tripLabel(t), 'bus');
        toast('بدأت الرحلة الإلزامية وتم تفعيل البث التلقائي للموقع ✓');
      } else if (t.status === 'en_route') {
        MB.update((s) => {
          const x = s.trips.find((z) => z.id === t.id);
          if (x) x.status = 'arrived';
        });
        const next = currentTrip();
        if (next && next.status !== 'arrived') {
          toast('تم إنهاء الرحلة — انتقل جدولك تلقائياً للرحلة التالية: ' + MB.tripLabel(next) + ' ✓');
        } else {
          toast('تم إنهاء الرحلة وأتممت جميع رحلات جدولك اليومي ✓');
        }
      } else if (t.status === 'arrived') {
        MB.update((s) => {
          s.trips.forEach((z) => {
            if (z.driverId === driverId && z.status === 'arrived') {
              z.status = 'scheduled';
              z.startedAt = null;
            }
          });
        });
        toast('تمت إعادة فتح جدول اليوم للتجربة ✓');
      }
    };

    $('reqList').addEventListener('click', (e) => {
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
  renderAlertToggle();
  updateAudioHint();
  refresh();
  MB.subscribe(refresh);
  setInterval(refresh, 1000);
})();
