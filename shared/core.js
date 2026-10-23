/* Lotus Bus — shared core: mock data + live simulation + synced state.
   Include with <script src="../shared/core.js"></script>. Exposes window.MB.

   Model (no stations): each route is a fixed path (polyline). The bus drives continuously along it.
   A student taps "Ready" -> shares a pickup location on/near the path (state.pickups). The driver sees
   those anonymous pins live as mandatory stops (status 'accepted' from the start). The driver can't skip: the bus
   always pauses at each pickup for a few seconds (boarding) and then continues. */
(function () {
  const KEY = 'lotus_state_v2';
  const TRIP_MS = 8 * 60 * 1000;   // a full trip takes 8 real minutes in the demo
  const BOARD_MS = 8 * 1000;       // how long the bus waits at an accepted pickup

  // Real street paths (Lotus University lines), generated once from the route waypoints via OSRM.
  // The first point is where the line starts; the last point is the university. There are no stations.
  const UNIVERSITY = 'جامعة اللوتس';
  const routes = [
    { id: 'r1', name: 'خط وسط المدينة والكورنيش', color: '#165b40', minutes: 35,
      fromName: 'طريق تله', toName: UNIVERSITY, polyline: [[28.0885,30.7537],[28.0887,30.7551],[28.0889,30.7559],[28.0883,30.7561],[28.0906,30.7557],[28.0923,30.7553],[28.0932,30.7548],[28.0955,30.7532],[28.0957,30.7534],[28.0934,30.7548],[28.094,30.7561],[28.0926,30.7569],[28.0923,30.7571],[28.0928,30.7572],[28.0933,30.7572],[28.094,30.758],[28.0947,30.7591],[28.0951,30.7598],[28.0953,30.7603],[28.0955,30.7607],[28.096,30.7615],[28.0948,30.7631],[28.0934,30.764],[28.0919,30.7647],[28.0912,30.7647],[28.0908,30.7648],[28.0907,30.7653],[28.091,30.7655],[28.092,30.7678],[28.0928,30.77],[28.0961,30.7785],[28.0967,30.78],[28.0969,30.7801],[28.0972,30.7798],[28.1023,30.7765],[28.1056,30.7744],[28.1095,30.772],[28.1109,30.7714],[28.1133,30.7704],[28.1149,30.7699],[28.1161,30.7695],[28.1166,30.7696],[28.117,30.77],[28.1173,30.7705],[28.1173,30.771],[28.1168,30.7718],[28.1154,30.773],[28.1148,30.7736],[28.1136,30.7747],[28.1101,30.7776],[28.1082,30.779],[28.1059,30.7805],[28.1031,30.7826],[28.1015,30.7852],[28.1012,30.787],[28.1002,30.7927],[28.0993,30.7991],[28.098,30.8086],[28.0973,30.8118],[28.0966,30.8136],[28.0961,30.8143],[28.0903,30.821],[28.0879,30.8237],[28.0846,30.8274],[28.0834,30.829],[28.0835,30.8307],[28.0872,30.8334],[28.0905,30.8355],[28.0941,30.8373],[28.0978,30.8387],[28.1002,30.8395],[28.1012,30.8402],[28.1056,30.8448],[28.1074,30.8465],[28.1088,30.847],[28.1135,30.8471],[28.117,30.8471],[28.1278,30.8474],[28.126,30.8469]] },
    { id: 'r4', name: 'خط شلبي', color: '#1e40af', minutes: 38,
      fromName: 'شلبي', toName: UNIVERSITY, polyline: [[28.118,30.7435],[28.1151,30.7447],[28.1145,30.745],[28.1149,30.7449],[28.1171,30.7442],[28.1176,30.7444],[28.1176,30.7448],[28.1161,30.7455],[28.1147,30.7461],[28.1146,30.7465],[28.1145,30.7477],[28.1141,30.7499],[28.1111,30.7515],[28.1078,30.7531],[28.1046,30.7547],[28.1033,30.7556],[28.1026,30.7561],[28.1023,30.7565],[28.1017,30.7572],[28.0998,30.7586],[28.0995,30.7588],[28.0968,30.7614],[28.0949,30.7632],[28.0933,30.7641],[28.0916,30.7647],[28.0911,30.7648],[28.0908,30.7648],[28.0908,30.7653],[28.0911,30.7656],[28.0923,30.7685],[28.0939,30.7728],[28.0964,30.7792],[28.0967,30.78],[28.0969,30.7801],[28.0976,30.7795],[28.1027,30.7762],[28.1067,30.7737],[28.1099,30.7719],[28.1113,30.7713],[28.1134,30.7704],[28.115,30.7698],[28.1163,30.7695],[28.1166,30.7696],[28.1171,30.7701],[28.1173,30.7706],[28.1173,30.7711],[28.1167,30.772],[28.1154,30.7731],[28.1148,30.7736],[28.1132,30.775],[28.1097,30.7779],[28.1078,30.7793],[28.1049,30.7813],[28.1026,30.7831],[28.1014,30.7856],[28.101,30.7877],[28.1,30.7939],[28.0991,30.8001],[28.0978,30.8099],[28.0973,30.8121],[28.0965,30.8137],[28.0954,30.8151],[28.0902,30.8211],[28.0875,30.8242],[28.0845,30.8275],[28.0833,30.8292],[28.0837,30.831],[28.0887,30.8344],[28.0912,30.8358],[28.0945,30.8375],[28.0989,30.839],[28.1005,30.8396],[28.1013,30.8404],[28.1062,30.8454],[28.1076,30.8466],[28.1091,30.8471],[28.1139,30.8471],[28.1178,30.8471],[28.1281,30.8473],[28.126,30.8469]] },
  ];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const R = byId(routes);

  const drivers = [
    { id: 'd1', name: 'أ. محمود السيد',   phone: '01001234567' },
    { id: 'd2', name: 'أ. عصام فتحي',     phone: '01112345678' },
    { id: 'd3', name: 'أ. سعيد عبدالله',  phone: '01223456789' },
    { id: 'd4', name: 'أ. ياسر منصور',    phone: '01554321098' },
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
    const mLat = 111000, mLng = 98000;
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
          const isCrowdedDemo = (ri === 1 && si === 1 && dir === 'go');
          const booked = isCrowdedDemo
            ? bus.capacity + 4
            : Math.min(bus.capacity - 6, 12 + ((ri * 7 + si * 11 + (dir === 'go' ? 3 : 9)) % 22));
          trips.push({
            id, routeId: r.id, direction: dir, time: pad(h) + ':' + pad(m),
            scheduledAt: todayAt(h, m), driverId: driver.id, busId: bus.id, capacity: bus.capacity,
            booked,
            status: 'scheduled', startedAt: null, pauseStart: null, pausedTotal: 0, published: true,
          });
        });
      });
    });
    const live = trips.filter((t) => t.routeId === 'r1' && t.direction === 'go').slice(0, 1)
      .concat(trips.filter((t) => t.routeId === 'r4' && t.direction === 'go').slice(0, 1))
      .concat(trips.filter((t) => t.routeId === 'r1' && t.direction === 'back').slice(1, 2));
    live.forEach((t, i) => { t.status = 'en_route'; t.startedAt = Date.now() - (1.2 + i * 1.8) * 60 * 1000; });
    const atStartTrip = trips.find((t) => t.routeId === 'r1' && t.direction === 'go' && t.status === 'scheduled');
    if (atStartTrip) atStartTrip.status = 'at_start';
    trips.filter((t) => t.direction === 'back' && t.status === 'scheduled' && t.scheduledAt < Date.now() - 60 * 60 * 1000)
      .slice(0, 2).forEach((t) => { t.status = 'arrived'; t.startedAt = t.scheduledAt; });
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
          ts: Date.now() - (k + 1) * 40000, status: 'accepted', mine: false });
      });
    });
    return out;
  }

  function seed() {
    const trips = seedTrips();
    return {
      v: 2,
      trips,
      pickups: seedPickups(trips),
      me: { name: 'أحمد محمد', studentId: '20231547' },
      myBookings: [
        { id: 'k1', tripId: trips.find((t) => t.routeId === 'r1' && t.direction === 'go' && t.time === '07:00').id, seat: 12, status: 'confirmed' },
      ],
      sharedLinks: [],
      notifications: [
        { id: 'n1', ts: Date.now() - 600000, text: 'الحافلة اقتربت منك', read: false, kind: 'bus' },
        { id: 'n2', ts: Date.now() - 3600000, text: 'تم تأكيد حجز رحلة خط وسط المدينة والكورنيش 07:00', read: true, kind: 'booking' },
      ],
      reports: [
        { id: 'p1', ts: Date.now() - 86400000, studentName: 'سارة علي',   category: 'تأخير',      text: 'الحافلة تأخرت 20 دقيقة عن الموعد.', status: 'open', assignee: '' },
        { id: 'p2', ts: Date.now() - 172800000, studentName: 'كريم حسن', category: 'نظافة',      text: 'الحافلة تحتاج تنظيف.',            status: 'closed', assignee: 'م. هالة' },
        { id: 'p3', ts: Date.now() - 7200000, studentName: 'منى إبراهيم', category: 'سلوك السائق', text: 'السائق عدّى من غير ما يقف.',    status: 'open', assignee: '' },
      ],
      chat: [],
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
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.v === 2 && Array.isArray(s.trips)) {
        const hasOpenGo = s.trips.some((t) => t.direction === 'go' && (t.status === 'scheduled' || t.status === 'at_start'));
        if (hasOpenGo) return s;
      }
    } catch (e) {}
    return null;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function emit() { subs.forEach((f) => { try { f(state); } catch (e) { console.error(e); } }); }
  state = load() || seed(); save();

  // ---------- cloud sync: every device shares one state through /api/sync (Cloudflare Pages Function + D1) ----------
  // The state is split into small documents (one per item of each collection, id = item.id). Local changes are
  // diffed against `shadow` and pushed; the server's changes are polled and merged (last write wins per document).
  // `me` (this device's own student profile / UI flags) and `v` stay local. If the API is unreachable the app
  // simply keeps working on its local copy and reconnects by itself.
  const API = '/api/sync';
  const LOCAL_ONLY = { v: 1, me: 1 };
  const SORT = { notifications: -1, reports: -1, chat: 1, sharedLinks: 1 };   // by ts (1 = oldest first)
  const sync = { ready: false, since: 0, shadow: {}, pending: {}, busy: false, offset: 0, fails: 0 };

  // one shared clock for all devices: Date.now() is shifted by the server's offset once we know it
  const rawNow = Date.now.bind(Date);
  Date.now = () => rawNow() + sync.offset;

  function docsOf(s) {
    const m = {};
    m['_meta|v'] = JSON.stringify(s.v);
    Object.keys(s).forEach((k) => {
      if (LOCAL_ONLY[k]) return;
      const v = s[k];
      if (Array.isArray(v)) v.forEach((it) => { if (it && it.id != null) m[k + '|' + it.id] = JSON.stringify(it); });
      else if (v && typeof v === 'object') m[k + '|_'] = JSON.stringify(v);
    });
    return m;
  }
  const splitKey = (key) => { const i = key.indexOf('|'); return [key.slice(0, i), key.slice(i + 1)]; };
  const allOps = () => Object.keys(sync.shadow).map((key) => { const [k, id] = splitKey(key); return { k, id, j: sync.shadow[key] }; });

  async function api(method, qs, body) {
    const r = await fetch(API + (qs || ''), {
      method, cache: 'no-store', keepalive: !!body,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error('sync ' + r.status);
    return r.json();
  }

  async function send(ops, reset) {
    if (!ops.length && !reset) return;
    const keys = ops.map((o) => o.k + '|' + o.id);
    keys.forEach((k) => { sync.pending[k] = (sync.pending[k] || 0) + 1; });
    try {
      for (let i = 0; i < Math.max(1, ops.length); i += 300) {
        await api('POST', '', { ops: ops.slice(i, i + 300), reset: !!reset && i === 0 });
      }
    } catch (e) {
      // not delivered: forget what we believed was synced so the next push sends it again
      ops.forEach((o) => { delete sync.shadow[o.k + '|' + o.id]; });
      sync.fails++;
      setTimeout(pushDiff, 3000);
    } finally {
      keys.forEach((k) => { if (--sync.pending[k] <= 0) delete sync.pending[k]; });
    }
  }

  function pushDiff() {
    if (!sync.ready) return;
    const cur = docsOf(state), ops = [];
    Object.keys(cur).forEach((key) => {
      if (sync.shadow[key] !== cur[key]) { const [k, id] = splitKey(key); ops.push({ k, id, j: cur[key] }); }
    });
    Object.keys(sync.shadow).forEach((key) => {
      if (!(key in cur)) { const [k, id] = splitKey(key); ops.push({ k, id, del: 1 }); }
    });
    if (!ops.length) return;
    sync.shadow = cur;
    send(ops);
  }

  function applyRemote(docs) {
    let changed = false;
    const sortKeys = {};
    docs.forEach((d) => {
      sync.since = Math.max(sync.since, d.t);
      const key = d.k + '|' + d.id;
      if (sync.pending[key] || d.k === '_meta') return;
      if (d.d) {
        if (!(key in sync.shadow)) return;
        delete sync.shadow[key];
        if (d.id !== '_' && Array.isArray(state[d.k])) state[d.k] = state[d.k].filter((it) => String(it.id) !== d.id);
        changed = true;
        return;
      }
      if (sync.shadow[key] === d.j) return;
      let obj; try { obj = JSON.parse(d.j); } catch (e) { return; }
      sync.shadow[key] = d.j;
      if (d.id === '_') state[d.k] = obj;
      else {
        if (!Array.isArray(state[d.k])) state[d.k] = [];
        const i = state[d.k].findIndex((it) => String(it.id) === d.id);
        if (i >= 0) state[d.k][i] = obj; else state[d.k].push(obj);
        if (SORT[d.k]) sortKeys[d.k] = true;
      }
      changed = true;
    });
    Object.keys(sortKeys).forEach((k) => state[k].sort((a, b) => SORT[k] * ((a.ts || 0) - (b.ts || 0))));
    return changed;
  }

  async function pull() {
    if (sync.busy) return;
    sync.busy = true;
    try {
      const d = await api('GET', '?since=' + sync.since);
      sync.fails = 0;
      if (d.now) { const off = d.now - rawNow(); sync.offset = sync.ready ? Math.round(sync.offset * 0.7 + off * 0.3) : off; }
      if (!sync.ready) {
        const mv = (d.docs.find((x) => x.k === '_meta' && x.id === 'v') || {}).j;
        if (!d.docs.length || mv !== JSON.stringify(state.v)) {
          // server empty (or an older data version): this device's data becomes the shared seed
          sync.shadow = docsOf(state); sync.ready = true;
          await send(allOps(), true);
        } else {
          // adopt the shared state
          Object.keys(state).forEach((k) => { if (Array.isArray(state[k]) && !LOCAL_ONLY[k]) state[k] = []; });
          sync.shadow = {}; sync.ready = true;
          if (applyRemote(d.docs)) { save(); emit(); }
        }
        return;
      }
      if (d.docs.length && applyRemote(d.docs)) { save(); emit(); }
    } catch (e) {
      sync.fails++;
    } finally {
      sync.busy = false;
    }
  }
  (function startSync() {
    if (!/^https?:$/.test(location.protocol)) return;
    pull();
    setInterval(() => { if (!document.hidden || sync.fails === 0) pull(); }, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  })();

  // another tab on this device saved a newer copy: take it, that tab pushes its own changes
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { state = load() || state; if (sync.ready) sync.shadow = docsOf(state); emit(); }
  });

  /** called after every local mutation */
  function commit() { save(); pushDiff(); emit(); }

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
    update(fn) { fn(state); commit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    reset() {
      state = seed(); save();
      if (sync.ready) { sync.shadow = docsOf(state); send(allOps(), true); }
      emit();
    },
    /** true once this device is connected to the shared (cloud) state */
    get online() { return sync.ready && sync.fails < 3; },
    polyOf, progressOf, snap,
    trip: (id) => state.trips.find((t) => t.id === id),
    /** live bus position for an en_route trip: {lat,lng,progress,paused} or null */
    position(trip) {
      if (trip.status !== 'en_route') return null;
      const p = progressOf(trip), [lat, lng] = lerpAlong(polyOf(trip), p);
      return { lat, lng, progress: p, paused: !!trip.pauseStart };
    },
    /** minutes until the bus reaches progress `p` on this trip (route minutes x remaining fraction), null if passed / not running */
    etaToProgress(trip, p) {
      if (trip.status !== 'en_route') return null;
      const rem = p - progressOf(trip);
      if (rem < -0.005) return null;
      return Math.max(1, Math.round(Math.max(0, rem) * (R[trip.routeId].minutes || 30)));
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
        s.pickups.push({ id, tripId, lat: sn.lat, lng: sn.lng, rawLat: lat, rawLng: lng, progress: sn.progress, ts: Date.now(), status: 'accepted', mine: true });
      });
      this.notify('السواق هيقف لك — جهّز نفسك', 'bus');
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
      if (p >= 1) { t.startedAt = now; t.pausedTotal = 0; t.pauseStart = null; changed = true; }
    });
    if (changed) commit();
  }, 1000);

  window.MB = MB;
})();
