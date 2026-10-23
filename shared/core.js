/* Movia Bus — shared core: mock data + live simulation + synced state.
   Include with <script src="../shared/core.js"></script>. Exposes window.MB. */
(function () {
  const KEY = 'movia_state_v1';
  const TRIP_MS = 8 * 60 * 1000; // a full trip takes 8 real minutes in the demo

  const stations = [
    { id: 's1', name: 'البوابة الرئيسية للجامعة', lat: 30.0780, lng: 31.2850 },
    { id: 's2', name: 'ميدان الجيزة',            lat: 30.0131, lng: 31.2089 },
    { id: 's3', name: 'محطة المترو',              lat: 30.0444, lng: 31.2357 },
    { id: 's4', name: 'شارع الهرم',               lat: 29.9870, lng: 31.1760 },
    { id: 's5', name: 'مدينة نصر - السيطرة',     lat: 30.0626, lng: 31.3300 },
    { id: 's6', name: 'التجمع - الحي الأول',     lat: 30.0300, lng: 31.4300 },
    { id: 's7', name: 'المعادي - كورنيش',        lat: 29.9602, lng: 31.2569 },
    { id: 's8', name: 'حدائق الأهرام',            lat: 29.9950, lng: 31.1300 },
  ];

  // routes: ordered station ids. polyline is generated from stations with gentle street-like bends.
  const routeDefs = [
    { id: 'r1', name: 'خط الجيزة',  color: '#e8590c', stops: ['s1', 's3', 's2', 's4', 's8'] },
    { id: 'r2', name: 'خط التجمع',  color: '#1c7ed6', stops: ['s1', 's5', 's6'] },
    { id: 'r3', name: 'خط المعادي', color: '#2f9e44', stops: ['s1', 's3', 's7'] },
  ];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const S = byId(stations);

  function buildPolyline(stops) {
    const pts = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = S[stops[i]], b = S[stops[i + 1]];
      const steps = 14;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        // L-shaped "street" bends: move along lat first then lng for a block-like feel
        const bend = Math.sin(t * Math.PI * 3) * 0.0035;
        pts.push([a.lat + (b.lat - a.lat) * t + bend, a.lng + (b.lng - a.lng) * t - bend]);
      }
    }
    const last = S[stops[stops.length - 1]];
    pts.push([last.lat, last.lng]);
    return pts;
  }
  const routes = routeDefs.map((r) => ({ ...r, polyline: buildPolyline(r.stops) }));
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

  function seedTrips() {
    const slots = [[7, 0], [8, 30], [13, 0], [15, 30], [17, 0]];
    const trips = [];
    let n = 1;
    routes.forEach((r, ri) => {
      slots.forEach(([h, m], si) => {
        ['go', 'back'].forEach((dir) => {
          if (si > 2 && dir === 'go') return; // evenings are return trips mostly
          const id = 't' + n++;
          const driver = drivers[(ri + si) % drivers.length];
          const bus = buses[(ri + si) % buses.length];
          const booked = Math.min(bus.capacity + (si === 1 ? 4 : 0), 8 + ((ri * 7 + si * 11 + (dir === 'go' ? 3 : 9)) % 30));
          trips.push({
            id, routeId: r.id, direction: dir, time: pad(h) + ':' + pad(m),
            scheduledAt: todayAt(h, m), driverId: driver.id, busId: bus.id, capacity: bus.capacity,
            booked: Math.min(booked, bus.capacity), waitlist: booked > bus.capacity ? booked - bus.capacity : 0,
            status: 'scheduled', // scheduled | at_start | en_route | arrived | cancelled
            startedAt: null, published: true,
          });
        });
      });
    });
    // make a few trips live so no screen is ever empty
    const live = trips.filter((t) => t.routeId === 'r1' && t.direction === 'go').slice(0, 1)
      .concat(trips.filter((t) => t.routeId === 'r2' && t.direction === 'go').slice(0, 1))
      .concat(trips.filter((t) => t.routeId === 'r3' && t.direction === 'back').slice(0, 1));
    live.forEach((t, i) => { t.status = 'en_route'; t.startedAt = Date.now() - (1.5 + i * 2.2) * 60 * 1000; });
    trips.filter((t) => t.status === 'scheduled' && t.scheduledAt < Date.now() - 60 * 60 * 1000)
      .slice(0, 4).forEach((t) => { t.status = 'arrived'; t.startedAt = t.scheduledAt; });
    return trips;
  }

  function seedWaiting() {
    // waiting[tripId][stationId] = anonymous student count (drivers only ever see counts)
    const w = {};
    return w;
  }

  function seed() {
    const trips = seedTrips();
    const waiting = {};
    trips.forEach((t, i) => {
      const stops = stopsOf(t, R);
      waiting[t.id] = {};
      stops.forEach((sid, k) => { waiting[t.id][sid] = (k === 0 || (i + k) % 3 === 0) ? 0 : (i * 3 + k * 2) % 7; });
    });
    return {
      v: 1,
      trips, waiting,
      me: { name: 'أحمد محمد', studentId: '20231547', plan: 'اشتراك شهري', balance: 350, favStation: 's3', virtualStops: {} }, // virtualStops[tripId]=stationId
      myBookings: [
        { id: 'k1', tripId: trips.find((t) => t.routeId === 'r1' && t.direction === 'go' && t.time === '07:00').id, seat: 12, status: 'confirmed' },
        { id: 'k2', tripId: trips.find((t) => t.routeId === 'r1' && t.direction === 'back' && t.time === '15:30').id, seat: 9, status: 'confirmed' },
      ],
      waitlistMine: [],
      sharedLinks: [],
      notifications: [
        { id: 'n1', ts: Date.now() - 600000, text: 'الحافلة اقتربت من محطتك', read: false, kind: 'bus' },
        { id: 'n2', ts: Date.now() - 3600000, text: 'تم تأكيد حجز رحلة خط الجيزة 07:00', read: true, kind: 'booking' },
      ],
      reports: [
        { id: 'p1', ts: Date.now() - 86400000, studentName: 'سارة علي',   category: 'تأخير',      text: 'الحافلة تأخرت 20 دقيقة عن الموعد.', status: 'open', assignee: '' },
        { id: 'p2', ts: Date.now() - 172800000, studentName: 'كريم حسن', category: 'نظافة',      text: 'الحافلة تحتاج تنظيف.',            status: 'closed', assignee: 'م. هالة' },
        { id: 'p3', ts: Date.now() - 7200000, studentName: 'منى إبراهيم', category: 'سلوك السائق', text: 'السائق تجاوز محطة بدون توقف.',   status: 'open', assignee: '' },
      ],
      ratings: [ { tripId: 't1', driverId: 'd1', stars: 5 }, { tripId: 't2', driverId: 'd2', stars: 4 } ],
      sos: [],
      chat: [], // {id, tripId, from:'student'|'driver', text, ts}
      subscribers: [
        { id: 'u1', name: 'أحمد محمد',   studentId: '20231547', plan: 'شهري',  balance: 350, status: 'active', expires: '2026-11-20', scanned: true },
        { id: 'u2', name: 'سارة علي',    studentId: '20231622', plan: 'ترم',   balance: 0,   status: 'active', expires: '2027-01-30', scanned: true },
        { id: 'u3', name: 'كريم حسن',    studentId: '20230988', plan: 'شهري',  balance: 80,  status: 'expired', expires: '2026-10-01', scanned: false },
        { id: 'u4', name: 'منى إبراهيم', studentId: '20241205', plan: 'أسبوعي', balance: 40,  status: 'active', expires: '2026-10-28', scanned: true },
        { id: 'u5', name: 'عمر خالد',    studentId: '20232390', plan: 'ترم',   balance: 600, status: 'active', expires: '2027-01-30', scanned: false },
        { id: 'u6', name: 'ياسمين طارق', studentId: '20241777', plan: 'شهري',  balance: 15,  status: 'active', expires: '2026-11-12', scanned: true },
      ],
      payments: [
        { id: 'pay1', ts: Date.now() - 3 * 86400000, student: 'أحمد محمد', amount: 450, method: 'بطاقة', plan: 'شهري' },
        { id: 'pay2', ts: Date.now() - 5 * 86400000, student: 'سارة علي', amount: 1200, method: 'محفظة', plan: 'ترم' },
        { id: 'pay3', ts: Date.now() - 86400000, student: 'منى إبراهيم', amount: 150, method: 'بطاقة', plan: 'أسبوعي' },
      ],
      policies: { lastReturn: '19:30', rules: ['يجب مسح بطاقة QR عند الصعود.', 'يُسمح بإلغاء الحجز قبل الرحلة بساعة.', 'الحد الأقصى للحقيبة الواحدة.'] },
    };
  }

  function stopsOf(trip, Rmap) {
    const r = (Rmap || R)[trip.routeId];
    return trip.direction === 'go' ? r.stops.slice() : r.stops.slice().reverse();
  }

  // ---------- state ----------
  let state = null;
  const subs = new Set();
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) {}
    return null;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function emit() { subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } }); }
  state = load() || seed(); save();
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load() || state; emit(); } });

  // ---------- simulation (deterministic from startedAt, no cross-tab messaging needed) ----------
  function progressOf(trip) {
    if (trip.status === 'arrived') return 1;
    if (trip.status !== 'en_route' || !trip.startedAt) return 0;
    return Math.min(1, (Date.now() - trip.startedAt) / TRIP_MS);
  }
  function lerpAlong(poly, p) {
    const f = p * (poly.length - 1);
    const i = Math.min(poly.length - 2, Math.floor(f));
    const t = f - i;
    return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t];
  }
  function polyOf(trip) {
    const r = R[trip.routeId];
    return trip.direction === 'go' ? r.polyline : r.polyline.slice().reverse();
  }
  // progress at which a trip reaches stop index k (stops evenly spaced along the polyline)
  function stopProgress(trip, k) { return k / (stopsOf(trip).length - 1); }

  const MB = {
    stations, routes, drivers, buses, S, R, TRIP_MS,
    drv: byId(drivers), bus: byId(buses),
    get state() { return state; },
    /** mutate state: MB.update(s => { s.trips[0].status = 'x'; }) — saves + notifies all pages/tabs */
    update(fn) { fn(state); save(); emit(); },
    /** subscribe to any state change (own tab + other tabs). Returns unsubscribe. */
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    reset() { state = seed(); save(); emit(); },
    stopsOf: (t) => stopsOf(t),
    polyOf, progressOf,
    trip: (id) => state.trips.find((t) => t.id === id),
    /** live bus position for an en_route trip: {lat,lng,progress,nextStopIdx,nextStopId} or null */
    position(trip) {
      if (trip.status !== 'en_route') return null;
      const p = progressOf(trip), [lat, lng] = lerpAlong(polyOf(trip), p);
      const stops = stopsOf(trip);
      let nextIdx = stops.length - 1;
      for (let k = 0; k < stops.length; k++) if (stopProgress(trip, k) >= p) { nextIdx = k; break; }
      return { lat, lng, progress: p, nextStopIdx: nextIdx, nextStopId: stops[nextIdx] };
    },
    /** ETA in minutes (demo-scaled: 1 real second ≈ 1 minute is NOT used; uses real minutes of the 8-min trip, x3 for realism) */
    etaMinutes(trip, stationId) {
      const stops = stopsOf(trip), k = stops.indexOf(stationId);
      if (k < 0 || trip.status !== 'en_route') return null;
      const rem = stopProgress(trip, k) - progressOf(trip);
      if (rem < 0) return null; // already passed
      return Math.max(1, Math.round(rem * (TRIP_MS / 60000) * 3));
    },
    tripLabel(t) { const r = R[t.routeId]; return r.name + ' · ' + (t.direction === 'go' ? 'ذهاب' : 'عودة') + ' · ' + t.time; },
    statusLabel: { scheduled: 'مجدولة', at_start: 'في محطة البداية', en_route: 'في الطريق', arrived: 'انتهت', cancelled: 'ملغاة' },
    /** driver view: waiting COUNTS only per station for a trip (privacy: never names) */
    waitingCounts(tripId) { return state.waiting[tripId] || {}; },
    /** stations ahead of the bus with zero waiting & zero booked => skippable */
    emptyAhead(trip) {
      const pos = this.position(trip); if (!pos) return [];
      const stops = stopsOf(trip), w = state.waiting[trip.id] || {};
      return stops.slice(pos.nextStopIdx).filter((sid, i, a) => !(w[sid] > 0) && sid !== a[a.length - 1]);
    },
    /** helper to create a trip (admin) */
    newTripId() { return 't' + (Date.now().toString(36)); },
    notify(text, kind) { this.update((s) => s.notifications.unshift({ id: 'n' + Date.now(), ts: Date.now(), text, read: false, kind: kind || 'info' })); },
    fmtTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); },
  };

  // Keep trip states alive: en_route trips auto-arrive when progress hits 1 (driver "arrival at gate" detection)
  setInterval(() => {
    let changed = false;
    state.trips.forEach((t) => { if (t.status === 'en_route' && progressOf(t) >= 1) { t.status = 'arrived'; changed = true; } });
    if (changed) { save(); emit(); }
  }, 1000);

  window.MB = MB;
})();
