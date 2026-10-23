/* Movia Bus — shared core: mock data + live simulation + synced state.
   Include with <script src="../shared/core.js"></script>. Exposes window.MB.

   Model (no stations): each route is a fixed path (polyline). The bus drives continuously along it.
   A student taps "Ready" -> shares a pickup location on/near the path (state.pickups). The driver sees
   those anonymous pins live and acknowledges them ("تمام، هقف له"). The driver can't skip: the bus
   always pauses at each pickup for a few seconds (boarding) and then continues. */
(function () {
  const KEY = 'movia_state_v3';
  const TRIP_MS = 8 * 60 * 1000;   // a full trip takes 8 real minutes in the demo
  const BOARD_MS = 8 * 1000;       // how long the bus waits at an accepted pickup

  // waypoints only shape the paths — they are NOT stations and are never shown as stops
  const way = {
    w1: { name: 'البوابة الرئيسية للجامعة', lat: 30.0780, lng: 31.2850 },
    w2: { name: 'الجيزة',                    lat: 30.0131, lng: 31.2089 },
    w3: { name: 'وسط البلد',                 lat: 30.0444, lng: 31.2357 },
    w4: { name: 'الهرم',                     lat: 29.9870, lng: 31.1760 },
    w5: { name: 'مدينة نصر',                 lat: 30.0626, lng: 31.3300 },
    w6: { name: 'التجمع',                    lat: 30.0300, lng: 31.4300 },
    w7: { name: 'المعادي',                   lat: 29.9602, lng: 31.2569 },
    w8: { name: 'حدائق الأهرام',             lat: 29.9950, lng: 31.1300 },
  };
  const routeDefs = [
    { id: 'r1', name: 'خط الجيزة',  color: '#165b40', path: ['w1', 'w3', 'w2', 'w4', 'w8'] },
    { id: 'r2', name: 'خط التجمع',  color: '#1e40af', path: ['w1', 'w5', 'w6'] },
    { id: 'r3', name: 'خط المعادي', color: '#b45309', path: ['w1', 'w3', 'w7'] },
  ];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));

  function buildPolyline(path) {
    const pts = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = way[path[i]], b = way[path[i + 1]];
      const steps = 14;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const bend = Math.sin(t * Math.PI * 3) * 0.0035;
        pts.push([a.lat + (b.lat - a.lat) * t + bend, a.lng + (b.lng - a.lng) * t - bend]);
      }
    }
    const last = way[path[path.length - 1]];
    pts.push([last.lat, last.lng]);
    return pts;
  }
  const routes = routeDefs.map((r) => ({
    id: r.id, name: r.name, color: r.color,
    fromName: way[r.path[0]].name, toName: way[r.path[r.path.length - 1]].name,
    polyline: buildPolyline(r.path),
  }));
  const R = byId(routes);

  const drivers = [
    { id: 'd1', name: 'أ. محمود السيد',   phone: '01001234567', rating: 4.7 },
    { id: 'd2', name: 'أ. عصام فتحي',     phone: '01112345678', rating: 4.5 },
    { id: 'd3', name: 'أ. سعيد عبدالله',  phone: '01223456789', rating: 4.8 },
    { id: 'd4', name: 'أ. ياسر منصور',    phone: '01554321098', rating: 4.2 },
  ];
  const buses = [
    { id: 'b1', plate: 'ن ص ع 4821', capacity: 40 },
    { id: 'b2', plate: 'ق ه م 7310', capacity: 40 },
    { id: 'b3', plate: 'س د ر 1957', capacity: 30 },
    { id: 'b4', plate: 'ب ج ك 6642', capacity: 40 },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  function todayAt(h, m) { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); }

  function polyOf(trip) {
    const r = R[trip.routeId];
    return trip.direction === 'go' ? r.polyline : r.polyline.slice().reverse();
  }
  function lerpAlong(poly, p) {
    const f = p * (poly.length - 1);
    const i = Math.min(poly.length - 2, Math.floor(f));
    const t = f - i;
    return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t];
  }
  // nearest point of the trip's path to (lat,lng): {progress 0..1, lat, lng, distM}
  function snap(trip, lat, lng) {
    const poly = polyOf(trip);
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = 0; i < poly.length - 1; i++) {
      const ax = poly[i][1], ay = poly[i][0], bx = poly[i + 1][1], by = poly[i + 1][0];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / len2));
      const px = ax + dx * t, py = ay + dy * t;
      const d = (px - lng) * (px - lng) + (py - lat) * (py - lat);
      if (d < best.d) best = { d, i, t, px, py };
    }
    const progress = (best.i + best.t) / (poly.length - 1);
    const mLat = 111000, mLng = 96000;
    const distM = Math.sqrt(Math.pow((best.py - lat) * mLat, 2) + Math.pow((best.px - lng) * mLng, 2));
    return { progress, lat: best.py, lng: best.px, distM };
  }

  function seedTrips() {
    const slots = [[7, 0], [8, 30], [13, 0], [15, 30], [17, 0]];
    const trips = [];
    let n = 1;
    routes.forEach((r, ri) => {
      slots.forEach(([h, m], si) => {
        ['go', 'back'].forEach((dir) => {
          if (si > 2 && dir === 'go') return;
          const id = 't' + n++;
          const driver = drivers[(ri + si) % drivers.length];
          const bus = buses[(ri + si) % buses.length];
          const booked = Math.min(bus.capacity + (si === 1 ? 4 : 0), 8 + ((ri * 7 + si * 11 + (dir === 'go' ? 3 : 9)) % 30));
          trips.push({
            id, routeId: r.id, direction: dir, time: pad(h) + ':' + pad(m),
            scheduledAt: todayAt(h, m), driverId: driver.id, busId: bus.id, capacity: bus.capacity,
            booked: Math.min(booked, bus.capacity), waitlist: booked > bus.capacity ? booked - bus.capacity : 0,
            status: 'scheduled', startedAt: null, pauseStart: null, pausedTotal: 0, published: true,
          });
        });
      });
    });
    const live = trips.filter((t) => t.routeId === 'r1' && t.direction === 'go').slice(0, 1)
      .concat(trips.filter((t) => t.routeId === 'r2' && t.direction === 'go').slice(0, 1))
      .concat(trips.filter((t) => t.routeId === 'r3' && t.direction === 'back').slice(0, 1));
    live.forEach((t, i) => { t.status = 'en_route'; t.startedAt = Date.now() - (1.2 + i * 1.8) * 60 * 1000; });
    const atStartTrip = trips.find((t) => t.routeId === 'r1' && t.status === 'scheduled');
    if (atStartTrip) atStartTrip.status = 'at_start';
    trips.filter((t) => t.status === 'scheduled' && t.scheduledAt < Date.now() - 60 * 60 * 1000)
      .slice(0, 3).forEach((t) => { t.status = 'arrived'; t.startedAt = t.scheduledAt; });
    return trips;
  }

  function seedPickups(trips) {
    // a few anonymous students already waiting ahead of each live bus, so the driver screen is never empty
    const out = [];
    let n = 1;
    trips.filter((t) => t.status === 'en_route').forEach((t) => {
      const p0 = Math.min(0.9, (Date.now() - t.startedAt) / TRIP_MS);
      [0.12, 0.3, 0.5].forEach((d, k) => {
        const p = p0 + d; if (p >= 0.97) return;
        const [lat, lng] = lerpAlong(polyOf(t), p);
        out.push({ id: 'pk' + n++, tripId: t.id, lat: lat + 0.0004, lng: lng + 0.0004, progress: p,
          ts: Date.now() - (k + 1) * 40000, status: 'waiting', mine: false });
      });
    });
    return out;
  }

  function seed() {
    const trips = seedTrips();
    return {
      v: 3,
      trips,
      pickups: seedPickups(trips),
      me: { name: 'أحمد محمد', studentId: '20231547', plan: 'اشتراك شهري', balance: 350 },
      myBookings: [
        { id: 'k1', tripId: trips.find((t) => t.routeId === 'r1' && t.direction === 'go' && t.time === '07:00').id, seat: 12, status: 'confirmed' },
        { id: 'k2', tripId: trips.find((t) => t.routeId === 'r1' && t.direction === 'back' && t.time === '15:30').id, seat: 9, status: 'confirmed' },
      ],
      waitlistMine: [],
      sharedLinks: [],
      notifications: [
        { id: 'n1', ts: Date.now() - 600000, text: 'الحافلة اقتربت منك', read: false, kind: 'bus' },
        { id: 'n2', ts: Date.now() - 3600000, text: 'تم تأكيد حجز رحلة خط الجيزة 07:00', read: true, kind: 'booking' },
      ],
      reports: [
        { id: 'p1', ts: Date.now() - 86400000, studentName: 'سارة علي',   category: 'تأخير',      text: 'الحافلة تأخرت 20 دقيقة عن الموعد.', status: 'open', assignee: '' },
        { id: 'p2', ts: Date.now() - 172800000, studentName: 'كريم حسن', category: 'نظافة',      text: 'الحافلة تحتاج تنظيف.',            status: 'closed', assignee: 'م. هالة' },
        { id: 'p3', ts: Date.now() - 7200000, studentName: 'منى إبراهيم', category: 'سلوك السائق', text: 'السائق عدّى من غير ما يقف.',    status: 'open', assignee: '' },
      ],
      ratings: [ { tripId: 't1', driverId: 'd1', stars: 5 }, { tripId: 't2', driverId: 'd2', stars: 4 } ],
      chat: [],
      subscribers: [
        { id: 'u1', name: 'أحمد محمد',   studentId: '20231547', plan: 'شهري',  balance: 350, status: 'active', expires: '2026-11-20', scanned: true },
        { id: 'u2', name: 'سارة علي',    studentId: '20231622', plan: 'ترم',   balance: 0,   status: 'active', expires: '2027-01-30', scanned: true },
        { id: 'u3', name: 'كريم حسن',    studentId: '20230988', plan: 'شهري',  balance: 80,  status: 'expired', expires: '2026-10-01', scanned: false },
        { id: 'u4', name: 'منى إبراهيم', studentId: '20241205', plan: 'أسبوعي', balance: 40,  status: 'active', expires: '2026-10-28', scanned: true },
        { id: 'u5', name: 'عمر خالد',    studentId: '20232390', plan: 'ترم',   balance: 600, status: 'active', expires: '2027-01-30', scanned: false },
        { id: 'u6', name: 'ياسمين طارق', studentId: '20241777', plan: 'شهري',  balance: 15,  status: 'active', expires: '2026-11-12', scanned: true },
      ],
      payments: [
        { id: 'pay1', ts: Date.now() - 3600000, student: 'أحمد محمد', amount: 450, method: 'بطاقة', plan: 'شهري' },
        { id: 'pay2', ts: Date.now() - 7200000, student: 'سارة علي', amount: 1200, method: 'محفظة', plan: 'ترم' },
        { id: 'pay3', ts: Date.now() - 1800000, student: 'منى إبراهيم', amount: 150, method: 'بطاقة', plan: 'أسبوعي' },
      ],
      policies: {
        lastReturn: '19:30',
        rules: [
          'الباص بيمشي في مساره من غير محطات ثابتة.',
          'يُسمح بإلغاء الحجز قبل موعد الرحلة بساعة على الأقل.',
          'اضغط Ready وحدد مكانك على المسار، والسائق هيشوفك ويقف لك.',
        ],
      },
    };
  }

  let state = null;
  const subs = new Set();
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 3) return s; } catch (e) {}
    return null;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function emit() { subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } }); }
  state = load() || seed(); save();
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load() || state; emit(); } });

  // progress = elapsed driving time (minus time spent paused for boarding) / full trip time
  function progressOf(trip) {
    if (trip.status === 'arrived') return 1;
    if (trip.status !== 'en_route' || !trip.startedAt) return 0;
    const upTo = trip.pauseStart || Date.now();
    return Math.max(0, Math.min(1, (upTo - trip.startedAt - (trip.pausedTotal || 0)) / TRIP_MS));
  }

  const MB = {
    routes, drivers, buses, R, TRIP_MS, BOARD_MS,
    drv: byId(drivers), bus: byId(buses),
    get state() { return state; },
    /** mutate state: MB.update(s => {...}) — saves + notifies every page/tab */
    update(fn) { fn(state); save(); emit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    reset() { state = seed(); save(); emit(); },
    polyOf, progressOf, snap,
    trip: (id) => state.trips.find((t) => t.id === id),
    /** live bus position for an en_route trip: {lat,lng,progress,paused} or null */
    position(trip) {
      if (trip.status !== 'en_route') return null;
      const p = progressOf(trip), [lat, lng] = lerpAlong(polyOf(trip), p);
      return { lat, lng, progress: p, paused: !!trip.pauseStart };
    },
    /** minutes until the bus reaches progress `p` on this trip (demo-scaled x3), null if passed / not running */
    etaToProgress(trip, p) {
      if (trip.status !== 'en_route') return null;
      const rem = p - progressOf(trip);
      if (rem < -0.005) return null;
      return Math.max(1, Math.round(Math.max(0, rem) * (TRIP_MS / 60000) * 3));
    },
    etaToPickup(trip, pk) { return this.etaToProgress(trip, pk.progress); },
    /** pickups of a trip, optionally only active ones (waiting/accepted/boarding) */
    pickupsOf(tripId, activeOnly) {
      return state.pickups.filter((k) => k.tripId === tripId && (!activeOnly || ['waiting', 'accepted', 'boarding'].indexOf(k.status) >= 0));
    },
    myPickup(tripId) { return state.pickups.find((k) => k.tripId === tripId && k.mine && ['waiting', 'accepted', 'boarding'].indexOf(k.status) >= 0) || null; },
    /** STUDENT "Ready": share my location (snapped onto the trip's path). Replaces my previous request on that trip. */
    requestPickup(tripId, lat, lng) {
      const t = this.trip(tripId); if (!t) return null;
      const sn = snap(t, lat, lng);
      const id = 'pk' + Date.now().toString(36);
      this.update((s) => {
        s.pickups = s.pickups.filter((k) => !(k.tripId === tripId && k.mine));
        s.pickups.push({ id, tripId, lat: sn.lat, lng: sn.lng, rawLat: lat, rawLng: lng, progress: sn.progress, ts: Date.now(), status: 'waiting', mine: true });
      });
      return id;
    },
    cancelPickup(id) { this.update((s) => { s.pickups = s.pickups.filter((k) => k.id !== id); }); },
    /** DRIVER: agree to stop at this pickup (bus pauses there for BOARD_MS when it arrives) */
    acceptPickup(id) {
      this.update((s) => { const k = s.pickups.find((x) => x.id === id); if (k && k.status === 'waiting') k.status = 'accepted'; });
      const k = state.pickups.find((x) => x.id === id);
      if (k && k.mine) this.notify('السواق هيقف لك — جهّز نفسك', 'bus');
    },
    tripLabel(t) { const r = R[t.routeId]; return r.name + ' · ' + (t.direction === 'go' ? 'ذهاب' : 'عودة') + ' · ' + t.time; },
    statusLabel: { scheduled: 'مجدولة', at_start: 'جاهزة للانطلاق', en_route: 'في الطريق', arrived: 'انتهت', cancelled: 'ملغاة' },
    newTripId() { return 't' + (Date.now().toString(36)); },
    notify(text, kind) { this.update((s) => s.notifications.unshift({ id: 'n' + Date.now() + Math.floor(Math.random() * 99), ts: Date.now(), text, read: false, kind: kind || 'info' })); },
    fmtTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); },
  };

  // engine: arrive at the end, bus reaches accepted pickups -> pause to board, passing waiting ones -> missed
  setInterval(() => {
    let changed = false;
    const now = Date.now();
    state.trips.forEach((t) => {
      if (t.status !== 'en_route') return;
      if (t.pauseStart) {
        const k = state.pickups.find((x) => x.tripId === t.id && x.status === 'boarding');
        if (!k || now >= (k.boardingUntil || 0)) {
          t.pausedTotal = (t.pausedTotal || 0) + (now - t.pauseStart); t.pauseStart = null;
          if (k) k.status = 'boarded';
          changed = true;
        }
        return;
      }
      const p = progressOf(t);
      state.pickups.forEach((k) => {
        if (k.tripId !== t.id || p < k.progress) return;
        // the driver must stop for every request: acknowledged ("accepted") or not, the bus boards the student
        if (k.status === 'accepted' || k.status === 'waiting') { k.status = 'boarding'; k.boardingUntil = now + BOARD_MS; t.pauseStart = now; changed = true; }
      });
      if (p >= 1) { t.status = 'arrived'; t.pauseStart = null; changed = true; }
    });
    if (changed) { save(); emit(); }
  }, 1000);

  window.MB = MB;
})();
