/* Lotus Bus — Driver Interface (two-button control, students' Ready requests, inline chat).
   No stations: the bus drives the route line; students' Ready requests appear as anonymous pins. */
(function () {
  'use strict';

  const DRIVER_KEY = 'mb_driver_id';
  const QUICK_REPLIES = ['أنا في الطريق', 'وصلت نقطة الركوب', 'هنتظر دقيقة', 'هتأخر 5 دقائق'];
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

  let map = null, routeLayer = null, pinLayer = null, linkLayer = null;
  let lastTripId = null, lastPinSig = '', lastReqSig = '', lastChatSig = '';
  let knownPickups = null;
  // map focus: 'auto' keeps the bus and the nearest student in frame (only moves when it has to), 'manual' = the driver moved the map, 'all' = whole route
  let focusMode = 'auto', focusBtns = {}, lastTouchAt = 0;
  let routeObj = null, routePoly = null, dbus = null, pinMarkers = {}, linkLine = null, linkLbl = null, lastTick = 0;

  function initMap() {
    if (typeof L === 'undefined') return;
    map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([28.11, 30.80], 12);
    MBMap.addTiles(map, { night: true });
    routeLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    linkLayer = L.layerGroup().addTo(map);
    const takeOver = () => { lastTouchAt = Date.now(); if (focusMode === 'auto') { focusMode = 'manual'; updateFocusBtn(); } };
    map.on('dragstart drag', takeOver);
    // route end labels fade out when zoomed in close
    map.on('zoomend', () => map.getContainer().classList.toggle('zoomed-in', map.getZoom() >= 15));
    const FocusCtl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'map-tools');
        const mk = (key, text, fn) => {
          const b = L.DomUtil.create('button', 'btn sm map-focus-btn map-tool', box);
          b.type = 'button';
          b.textContent = text;
          L.DomEvent.disableClickPropagation(b);
          L.DomEvent.on(b, 'click', fn);
          focusBtns[key] = b;
        };
        mk('auto', 'تتبّع تلقائي', () => {
          focusMode = 'auto';
          updateFocusBtn();
          if (lastTrip) autoFocus(lastTrip, true);
        });
        mk('all', 'المسار كله', () => {
          focusMode = 'all';
          updateFocusBtn();
          if (lastTrip) map.fitBounds(L.latLngBounds(MB.polyOf(lastTrip)), { padding: [28, 28] });
        });
        return box;
      },
    });
    new FocusCtl().addTo(map);
    updateFocusBtn();
    setTimeout(() => map.invalidateSize(), 50);
    window.addEventListener('resize', () => map && map.invalidateSize());
    requestAnimationFrame(driverFrame);
  }

  let lastTrip = null;
  function updateFocusBtn() {
    if (focusBtns.auto) focusBtns.auto.classList.toggle('on', focusMode === 'auto');
    if (focusBtns.all) focusBtns.all.classList.toggle('on', focusMode === 'all');
  }

  /* Auto focus = a camera that follows the bus like a navigation app.
     It only keeps the bus in the middle (gliding every animation frame); the ZOOM is the driver's: we set a starting zoom
     once per trip and never touch it again, so he can zoom in or out as much as he likes while it keeps following. */
  let camBus = null, camZoomSet = false, camLockUntil = 0;

  function autoFocus(trip, force) {
    // the driver moved the map: leave it alone for 8 s, then go back to following the bus
    if (map && focusMode === 'manual' && Date.now() - lastTouchAt > 8000) { focusMode = 'auto'; updateFocusBtn(); force = true; }
    if (!map || focusMode !== 'auto' || trip.status !== 'en_route') return;
    const pos = MB.position(trip);
    if (!pos) return;
    const bus = L.latLng(pos.lat, pos.lng);
    if (!camZoomSet) {
      // starting view of a trip: close on the bus
      camZoomSet = true;
      camLockUntil = performance.now() + 900;
      map.setView(bus, 15, { animate: true, duration: 0.8 });
    } else if (force) {
      // back to following: keep the zoom the driver has now, just bring the bus to the middle
      camLockUntil = performance.now() + 900;
      map.panTo(bus, { animate: true, duration: 0.6 });
    }
  }

  /* every frame: glide the camera so the bus stays in the middle (same zoom as now) */
  function followCamera() {
    if (!map || focusMode !== 'auto' || !camBus || performance.now() < camLockUntil || map._animatingZoom) return;
    const c = map.getCenter(), k = 0.18;
    map.setView(L.latLng(c.lat + (camBus[0] - c.lat) * k, c.lng + (camBus[1] - c.lng) * k), map.getZoom(), { animate: false });
  }

  function drawRoute(trip) {
    if (!map) return;
    routeLayer.clearLayers();
    if (routeObj) routeObj.destroy();
    if (dbus) { dbus.remove(); dbus = null; }
    pinMarkers = {}; linkLine = null; linkLbl = null; linkLayer.clearLayers();
    const route = MB.R[trip.routeId];
    routePoly = MB.polyOf(trip);
    routeObj = MBMap.route(map, routePoly, route.color);
    const term = (latlng, name, cls) => L.marker(latlng, {
      icon: L.divIcon({
        className: 'mb-icon',
        html: '<div class="pin term ' + cls + '">' + esc(name) + '</div>',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive: false,
    }).addTo(routeLayer);
    term(routePoly[0], trip.direction === 'go' ? route.fromName : route.toName, 'start');
    term(routePoly[routePoly.length - 1], trip.direction === 'go' ? route.toName : route.fromName, 'end');
    // no animation: a pending animated fit would later undo the starting zoom set right after
    map.fitBounds(L.latLngBounds(routePoly), { padding: [28, 28], animate: false });
    camZoomSet = false;
  }

  /* students ahead as numbered dots (1 = nearest), same numbers as on the strip */
  function renderPins(trip) {
    if (!map) return;
    const reqs = trip.status === 'en_route' && MB.position(trip) ? aheadRequests(trip) : [];
    const sig = trip.id + '|' + reqs.map((r) => r.k.id + r.k.status).join(',');
    if (sig === lastPinSig) return;
    lastPinSig = sig;
    pinLayer.clearLayers();
    pinMarkers = {};
    reqs.forEach((r, i) => {
      const k = r.k;
      const cls = k.status === 'boarding' ? 'brd' : 'acc';
      const tip = k.status === 'boarding' ? 'واقف — بيركبوا' : 'هتقف له';
      pinMarkers[k.id] = L.marker([k.lat, k.lng], {
        icon: L.divIcon({
          className: 'mb-icon',
          html: '<div class="pin req ' + cls + '">' + (i + 1) + '</div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
      }).bindTooltip(tip).addTo(pinLayer);
    });
  }

  /* ---- the bus: glides (position is drawn every animation frame from the clock), with a trail and a line to the nearest student ---- */
  function busLabelFor(trip) {
    const reqs = aheadRequests(trip);
    if (reqs.some((r) => r.k.status === 'boarding')) return 'واقف للركوب';
    const n = reqs[0];
    return n ? 'طالب بعد ' + (n.eta < 1 ? 'أقل من دقيقة' : n.eta + ' د') : '';
  }

  function paintBus(trip) {
    if (!map || !routeObj) return;
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    if (!pos) {
      camBus = null;
      if (dbus) { dbus.remove(); dbus = null; }
      routeObj.done.setLatLngs([]);
      routeObj.line.setLatLngs(routePoly);
      if (linkLine) { linkLayer.clearLayers(); linkLine = linkLbl = null; }
      return;
    }
    const ll = [pos.lat, pos.lng];
    if (!dbus) dbus = MBMap.bus(map, ll);
    dbus.move(ll, MBMap.headingAt(routePoly, pos.progress));
    camBus = ll;
    const now = performance.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    // trail: grey behind the bus, route colour ahead
    const i = Math.min(routePoly.length - 2, Math.floor(pos.progress * (routePoly.length - 1)));
    routeObj.done.setLatLngs(routePoly.slice(0, i + 1).concat([ll]));
    routeObj.line.setLatLngs([ll].concat(routePoly.slice(i + 1)));
    dbus.label(busLabelFor(trip));
    // dotted line along the road from the bus to the nearest student, with the distance; a ring on a student the bus is about to reach
    const reqs = aheadRequests(trip);
    const nearest = reqs.find((r) => r.k.status !== 'boarding');
    reqs.forEach((r) => {
      const m = pinMarkers[r.k.id], el = m && m.getElement(), pin = el && el.querySelector('.pin');
      if (pin) pin.classList.toggle('alert', r.k.status !== 'boarding' && r.dist <= 100);
    });
    if (!nearest) {
      if (linkLine) { linkLayer.clearLayers(); linkLine = linkLbl = null; }
      return;
    }
    const pts = MBMap.sliceBetween(routePoly, pos.progress, nearest.k.progress);
    pts[0] = ll;
    const mid = pts[Math.floor(pts.length / 2)];
    const icon = L.divIcon({ className: 'mb-icon', html: '<div class="link-lbl">' + esc(fmtDist(nearest.dist)) + '</div>', iconSize: [0, 0] });
    if (!linkLine) {
      linkLine = L.polyline(pts, { color: '#fff', weight: 4, dashArray: '1 10', lineCap: 'round', opacity: 1, interactive: false }).addTo(linkLayer);
      linkLbl = L.marker(mid, { icon, interactive: false, zIndexOffset: 700 }).addTo(linkLayer);
    } else {
      linkLine.setLatLngs(pts);
      linkLbl.setLatLng(mid);
      linkLbl.setIcon(icon);
    }
  }

  function driverFrame() {
    requestAnimationFrame(driverFrame);
    if (!map || !lastTrip) return;
    const t = MB.trip(lastTrip.id);
    if (t) paintBus(t);
    followCamera();
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

  /* ---- state of the page ---- */
  const NEAR_END = 0.9;   // from here on the trip counts as "almost there": the end button becomes the main action
  let reqExpanded = false, chatSeenTs = Date.now(), chatVisible = false, stripSig = '', schedSig = '';
  const reqLimit = () => 3;

  function tripProgress(trip) {
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    return pos ? pos.progress : (trip.status === 'arrived' ? 1 : 0);
  }
  // "25 د" / "2 س 15 د"
  function fmtWhen(mins) {
    if (mins < 60) return mins + ' د';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h + ' س' + (m ? ' ' + m + ' د' : '');
  }

  /* trip line (one line; the full schedule opens on tap) + the main button text */
  function renderHeader(trip) {
    const list = driverTrips();
    const idx = list.findIndex((t) => t.id === trip.id);
    const route = MB.R[trip.routeId] || {};
    $('tripTitle').textContent = trip.status === 'arrived' && idx === list.length - 1
      ? 'جدول اليوم خلص (' + list.length + ' رحلات)'
      : 'رحلة ' + (idx + 1) + ' من ' + list.length + ' · ' + trip.time + ' · ' + (route.name || '') + ' (' + (trip.direction === 'go' ? 'ذهاب' : 'عودة') + ')';
    const plate = (MB.bus[trip.busId] || {}).plate || '';
    $('tripMeta').textContent = 'حافلة: ' + plate + ' · المسجّلون: ' + trip.booked;
    $('chatSub').textContent = MB.tripLabel(trip);

    const btn = $('btnMain'), s = trip.status;
    if (s === 'en_route') {
      const near = tripProgress(trip) >= NEAR_END;
      btn.textContent = near ? 'وصلت — أنهِ الرحلة' : 'أنهِ مبكراً';
      btn.className = 'btn big go-btn ' + (near ? 'end' : 'early');
      btn.disabled = false;
    } else if (s === 'scheduled' || s === 'at_start') {
      btn.textContent = 'ابدأ الرحلة';
      btn.className = 'btn big go-btn ok';
      btn.disabled = false;
    } else {
      btn.textContent = 'خلّصت جدول اليوم ✓';
      btn.className = 'btn big go-btn sec';
      btn.disabled = true;
    }
  }

  /* one coloured banner says where the trip stands: grey not started / green running / orange boarding / blue almost there */
  function renderStatus(trip) {
    const route = MB.R[trip.routeId] || {};
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    let tone = 'grey', main = '', sub = '';
    if (trip.status === 'en_route') {
      const prog = pos ? pos.progress : 0;
      const left = MB.etaToProgress(trip, 1);
      if (isPaused(trip)) {
        const k = MB.pickupsOf(trip.id, true).find((x) => x.status === 'boarding');
        tone = 'orange'; main = 'واقف للركوب'; sub = k ? 'باقي ' + secsLeft(k) + ' ث' : '';
      } else {
        const spent = Math.round(prog * (route.minutes || 30));
        tone = prog >= NEAR_END ? 'blue' : 'green';
        main = prog >= NEAR_END ? 'وصلت تقريباً — أنهِ الرحلة' : 'في الطريق';
        sub = (spent >= 1 ? 'بدأت من ' + spent + ' د' : 'لسه في أول الخط') + (left != null && prog < NEAR_END ? ' · باقي حوالي ' + left + ' د' : '');
      }
    } else if (trip.status === 'at_start') {
      tone = 'blue'; main = 'جاهز للانطلاق'; sub = 'اضغط «ابدأ الرحلة» عند التحرك';
    } else if (trip.status === 'scheduled') {
      const mins = Math.round((trip.scheduledAt - Date.now()) / 60000);
      main = 'لم تبدأ'; sub = 'موعد ' + trip.time + (mins > 0 ? ' · بعد ' + fmtWhen(mins) : ' · حان الموعد');
    } else {
      tone = 'done'; main = 'الرحلة انتهت ✓'; sub = '';
    }
    $('statusBanner').dataset.tone = tone;
    $('statusMain').textContent = main;
    $('statusSub').textContent = sub;
  }

  /* progress strip: the bus on the line from the start to the end, one dot per student still ahead (tap = look at him on the map) */
  function renderStrip(trip) {
    const box = $('drvStrip'), route = MB.R[trip.routeId] || {};
    const cum = cumOf(trip), total = cum[cum.length - 1] || 1;
    const X = (p) => Math.max(0, Math.min(100, metersAt(trip, p) / total * 100));
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    const busP = pos ? pos.progress : trip.status === 'arrived' ? 1 : 0;
    const reqs = pos ? aheadRequests(trip) : [];
    const from = trip.direction === 'go' ? route.fromName : route.toName;
    const to = trip.direction === 'go' ? route.toName : route.fromName;
    const bx = X(busP).toFixed(1) + '%';
    const sig = trip.id + '|' + (pos ? 1 : 0) + '|' + reqs.map((r) => r.k.id + r.k.status).join(',');
    if (sig !== stripSig) {
      stripSig = sig;
      const dots = reqs.map((r, i) => '<button class="ds-dot ' + (r.k.status === 'boarding' ? 'brd' : 'acc') + (i === 0 ? ' near' : '') +
        '" type="button" data-k="' + esc(r.k.id) + '" style="right:' + X(r.k.progress).toFixed(1) + '%" aria-label="طالب على بعد ' + fmtDist(r.dist) + '">' + (i + 1) + '</button>').join('');
      box.innerHTML = '<div class="ds-track"><i class="ds-fill" style="width:' + bx + '"></i>' + dots +
        '<span class="ds-bus" style="right:' + bx + '">🚌</span></div>' +
        '<div class="ds-ends"><span>' + esc(from) + '</span><span class="ds-count">' + (reqs.length ? reqs.length + ' طالب قدامك' : '') + '</span><span>' + esc(to) + '</span></div>';
    } else {
      const f = box.querySelector('.ds-fill'), b = box.querySelector('.ds-bus');
      if (f) f.style.width = bx;
      if (b) b.style.right = bx;
    }
  }

  /* only the nearest few requests, big and simple; the rest behind "+N أخرى" */
  function renderReqs(trip) {
    const box = $('reqList');
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    const reqs = pos ? aheadRequests(trip) : [];
    const limit = reqLimit();
    const sig = trip.id + '|' + (pos ? 1 : 0) + '|' + reqExpanded + '|' + limit + '|' + reqs.map((r) =>
      r.k.id + ':' + r.k.status + ':' + (r.k.status === 'boarding' ? secsLeft(r.k) : r.eta)).join(',');
    if (sig === lastReqSig) return;
    lastReqSig = sig;
    $('reqCount').textContent = reqs.length;

    if (!pos) {
      box.innerHTML = '<p class="mute req-empty">طلبات الركوب بتظهر هنا أول ما تبدأ الرحلة.</p>';
      return;
    }
    if (!reqs.length) {
      box.innerHTML = '<p class="mute req-empty">مفيش طلبات ركوب قدامك حالياً.</p>';
      return;
    }
    const shown = reqExpanded ? reqs : reqs.slice(0, limit);
    box.innerHTML = shown.map((r) => {
      const k = r.k, id = esc(k.id);
      if (k.status === 'boarding') {
        return '<div class="req-row boarding"><div class="req-d">' + secsLeft(k) + ' ث</div>' +
          '<div class="req-info"><strong>طالب</strong><span class="req-state brd">واقف — الطلاب بيركبوا</span></div></div>';
      }
      const waiting = k.status !== 'accepted';
      return '<div class="req-row ' + (waiting ? 'waiting' : 'accepted') + '"><div class="req-d">' + esc(fmtDist(r.dist)) + '</div>' +
        '<div class="req-info"><strong>طالب</strong><span class="req-state ' + (waiting ? 'wait' : 'acc') + '">' +
        (waiting ? 'يوصل خلال ' : 'هتقف بعد ') + (r.eta < 1 ? 'أقل من دقيقة' : r.eta + ' د') + '</span></div>' +
        (waiting ? '<button class="btn ok" type="button" data-accept="' + id + '">تمام، هقف له</button>' : '') + '</div>';
    }).join('') + (reqs.length > limit
      ? '<button class="btn sec sm req-more" type="button" data-more="1">' + (reqExpanded ? 'عرض أقل' : '+' + (reqs.length - limit) + ' أخرى') + '</button>' : '');
  }

  /* counters on the sticky bottom bar */
  function renderBottom(trip) {
    const pos = trip.status === 'en_route' ? MB.position(trip) : null;
    const n = pos ? aheadRequests(trip).length : 0;
    $('bbCount').textContent = n;
    $('bbReq').classList.toggle('hot', n > 0);
    if (chatVisible) chatSeenTs = Date.now();
    const unread = chatMsgs(trip).filter((m) => m.from !== 'driver' && m.ts > chatSeenTs).length;
    const c = $('bbChatCount');
    c.textContent = unread;
    c.hidden = !unread;
    $('bbChat').classList.toggle('hot', unread > 0);
  }

  /* ---- driver-safety alerts: chime (Web Audio), Arabic voice, vibration, top banner ---- */
  const alertsEnabled = true;
  let audioCtx = null, audioReady = false, bannerTimer = null, voiceTimer = null;

  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    return audioCtx;
  }

  function updateAudioHint() { const h = $('audioHint'); if (h) h.hidden = audioReady; }

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

  function chatMsgs(trip) {
    return (MB.state.chat || []).filter((m) => m.tripId === trip.id).sort((a, b) => a.ts - b.ts);
  }

  function renderChat(trip) {
    const msgs = chatMsgs(trip).slice(-3);
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
    toast('اتبعتت ✓');
  }

  /* the full day's schedule: collapsed behind the trip line */
  function renderSchedule(cur) {
    const box = $('drvSchedule');
    if (!box) return;
    const list = driverTrips();
    const sig = (cur ? cur.id : '') + '|' + list.map((t) => t.id + t.status).join(',');
    if (sig === schedSig) return;
    schedSig = sig;
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
          ? (t.status === 'en_route' ? '● جارية الآن' : '● رحلتك الآن')
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
        '<strong>📋 جدولك اليومي من الإدارة (' + list.length + ' رحلات)</strong>' +
        '<span class="mute">بالترتيب ولا يمكن تخطي رحلة</span>' +
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
      lastPinSig = ''; lastReqSig = ''; lastChatSig = ''; stripSig = '';
      drawRoute(trip);
    }
    renderStatus(trip);
    renderPill(trip);
    lastTrip = trip;
    paintBus(trip);
    autoFocus(trip);
    renderStrip(trip);
    renderPins(trip);
    renderReqs(trip);
    renderChat(trip);
    renderBottom(trip);
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

  /* toast with an "undo" button (ending a trip by mistake) */
  function toastUndo(msg, onUndo) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'toast toast-undo';
    const sp = document.createElement('span');
    sp.textContent = msg;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'تراجع';
    b.onclick = () => { t.remove(); onUndo(); };
    t.append(sp, b);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 7000);
  }

  function endTrip(t) {
    MB.update((s) => {
      const x = s.trips.find((z) => z.id === t.id);
      if (x) x.status = 'arrived';
    });
    const next = currentTrip();
    toastUndo(next && next.status !== 'arrived'
      ? 'تم إنهاء الرحلة — الرحلة الجاية ' + next.time
      : 'تم إنهاء الرحلة — خلّصت جدول اليوم ✓', () => {
      if (driverTrips().some((z) => z.status === 'en_route')) return toast('مش ممكن التراجع — رحلة تانية بدأت');
      MB.update((s) => {
        const x = s.trips.find((z) => z.id === t.id);
        if (x && x.status === 'arrived') x.status = 'en_route';
      });
      toast('رجعت الرحلة شغالة ✓');
    });
  }

  function bindActions() {
    $('alertBanner').addEventListener('click', hideBanner);

    /* the full schedule opens from the trip line */
    $('tripLine').onclick = () => {
      const box = $('drvSchedule'), open = box.hidden;
      box.hidden = !open;
      $('tripLine').setAttribute('aria-expanded', String(open));
    };

    /* main button: start; end (a trip ended early asks first, and any end can be undone) */
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
        toast('بدأت الرحلة — البث التلقائي للموقع شغال ✓');
      } else if (t.status === 'en_route') {
        if (tripProgress(t) >= NEAR_END) { endTrip(t); return; }
        MB.confirm('الباص لسه ما وصلش آخر الخط — تأكيد إنهاء الرحلة؟', { ok: 'أنهِ الرحلة', cancel: 'كمّل', danger: true }).then((yes) => { if (yes) endTrip(t); });
      }
    };

    /* requests: accept (legacy "waiting" ones) and show more / less */
    $('reqList').addEventListener('click', (e) => {
      const a = e.target.closest('button[data-accept]');
      if (a) { MB.acceptPickup(a.dataset.accept); return; }
      if (e.target.closest('button[data-more]')) { reqExpanded = !reqExpanded; lastReqSig = ''; const t = currentTrip(); if (t) renderReqs(t); }
    });

    /* a dot on the strip = look at that student on the map */
    $('drvStrip').addEventListener('click', (e) => {
      const d = e.target.closest('[data-k]');
      if (!d || !map) return;
      const k = (MB.state.pickups || []).find((x) => x.id === d.dataset.k);
      if (!k) return;
      focusMode = 'manual';
      updateFocusBtn();
      map.flyTo([k.lat, k.lng], 17, { duration: 0.8 });
      try { $('map').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (err) {}
    });

    /* sticky bar shortcuts */
    $('bbReq').onclick = () => $('reqCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('bbChat').onclick = () => {
      chatSeenTs = Date.now();
      $('chatCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const t = currentTrip();
      if (t) renderBottom(t);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => es.forEach((e) => {
        chatVisible = e.isIntersecting;
        if (chatVisible) { chatSeenTs = Date.now(); const t = currentTrip(); if (t) renderBottom(t); }
      }), { threshold: 0.6 }).observe($('chatCard'));
    }

    /* quick replies are big buttons; typing is behind "اكتب رسالة" */
    $('quick').innerHTML = QUICK_REPLIES.map((q) =>
      '<button class="qchip" type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('');
    $('quick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (b) sendChat(b.dataset.q);
    });
    $('chatToggle').onclick = () => {
      const row = $('chatInputRow');
      row.hidden = !row.hidden;
      if (!row.hidden) $('chatIn').focus();
    };
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
