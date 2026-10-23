/* Movia Bus - student interface. Depends on window.MB from ../shared/core.js and optionally Leaflet (window.L). */
(function () {
  'use strict';
  const MB = window.MB;
  if (!MB) return;
  const app = document.getElementById('app');
  const TOTAL_MIN = Math.round(MB.TRIP_MS / 60000 * 3); // same demo scale as MB.etaMinutes
  const REPORT_CATS = ['تأخير', 'نظافة', 'سلوك السائق', 'عطل في الحافلة', 'أمان أو مضايقة', 'أخرى'];
  const KIND_LABEL = { bus: 'اقتراب', driver: 'السائق', cancel: 'إلغاء', booking: 'حجز', waitlist: 'انتظار', info: 'عام' };
  const KIND_CLS = { bus: 'info', driver: 'ok', cancel: 'bad', booking: 'ok', waitlist: 'warn', info: '' };
  const BOOK_STATUS = { confirmed: 'مؤكد', cancelled: 'ملغي', missed: 'فاتتك الرحلة', trip_cancelled: 'الرحلة اتلغت' };
  const VIEWS = ['home', 'book', 'map', 'alerts', 'support'];

  // UI drafts live outside state so re-renders do not wipe what the user is typing
  const draft = { route: 'r1', ready: {}, chat: {}, rate: {}, report: { cat: REPORT_CATS[0], trip: '', text: '' }, mapTrip: null };
  let mapCtl = null; // { key, tripId, map, bus }
  let pending = false;

  // ---------- helpers ----------
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function now() { return Date.now(); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function trip(id) { return id ? MB.trip(id) : undefined; }
  function label(t) { return MB.tripLabel(t); }
  function stName(id) { return MB.S[id] ? MB.S[id].name : '—'; }
  function seatsLeft(t) { return Math.max(0, t.capacity - t.booked); }
  function minsUntil(t) { return (t.scheduledAt - now()) / 60000; }
  function canCancel(t) { return t.status === 'scheduled' && minsUntil(t) >= 60; }
  function statusBadge(t) {
    const cls = { scheduled: 'info', at_start: 'warn', en_route: 'ok', arrived: '', cancelled: 'bad' }[t.status] || '';
    return '<span class="badge ' + cls + '">' + esc(MB.statusLabel[t.status] || t.status) + '</span>';
  }
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }
  function busy() {
    const a = document.activeElement;
    return !!a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  }
  function bookingFor(s, tid) { return s.myBookings.find((b) => b.tripId === tid && b.status === 'confirmed'); }
  function myTrips(s) {
    return s.myBookings.filter((b) => b.status === 'confirmed').map((b) => trip(b.tripId)).filter(Boolean)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }
  function pickActive(s) {
    const ts = myTrips(s);
    return ts.find((t) => t.status === 'en_route') || ts.find((t) => t.status === 'at_start') ||
      ts.find((t) => t.status === 'scheduled') || ts.find((t) => t.status === 'arrived') || null;
  }
  function trackUrl(tid) {
    const base = (location.origin && location.origin !== 'null') ? location.origin + '/student/' : location.href.split('#')[0];
    return base + '#track=' + tid;
  }
  function etaText(t, sid) {
    if (!t) return '—';
    if (t.status === 'scheduled') return 'لم تنطلق بعد';
    if (t.status === 'at_start') return 'في محطة البداية';
    if (t.status === 'arrived') return 'وصلت للنهاية';
    if (t.status === 'cancelled') return 'ملغاة';
    if (MB.stopsOf(t).indexOf(sid) < 0) return '—';
    const m = MB.etaMinutes(t, sid);
    if (m === null) return 'عدّت المحطة';
    return m <= 1 ? 'أقل من دقيقة' : m + ' دقيقة';
  }
  function note(text, kind, tripId, altTripId) {
    return { id: uid('n'), ts: now(), text, read: false, kind: kind || 'info', tripId: tripId || null, altTripId: altTripId || null };
  }
  function copyText(txt) {
    const done = () => toast('تم نسخ الرابط');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { toast('انسخ الرابط يدوياً من الخانة'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else {
      fallback();
    }
  }

  // ---------- state setup ----------
  function ensure(s) {
    s.me = s.me || {};
    s.me.seen = s.me.seen || {};
    s.me.ready = s.me.ready || {};
    s.me.approachDone = s.me.approachDone || {};
    s.me.virtualStops = s.me.virtualStops || {};
    if (s.me.chatSeenTs == null) s.me.chatSeenTs = now();
    s.waiting = s.waiting || {};
    ['myBookings', 'waitlistMine', 'sharedLinks', 'notifications', 'reports', 'ratings', 'sos', 'chat'].forEach((k) => {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    s.trips.forEach((t) => { s.waiting[t.id] = s.waiting[t.id] || {}; });
  }

  // Books one seat in trip t for the student (t must belong to state s).
  function book(s, t, msg) {
    t.booked += 1;
    const b = { id: uid('k'), tripId: t.id, seat: t.booked, status: 'confirmed' };
    s.myBookings.push(b);
    s.notifications.unshift(note(msg || ('تم تأكيد حجزك: ' + label(t) + ' · مقعد ' + b.seat), 'booking', t.id));
    return b;
  }

  // A seat in t was freed. Promote the student's waitlist entry first; otherwise simulate another waiting passenger.
  function freeSeat(s, t) {
    t.booked = Math.max(0, t.booked - 1);
    const w = s.waitlistMine.find((x) => x.tripId === t.id && x.status === 'waiting');
    if (w && t.booked < t.capacity) {
      w.status = 'promoted';
      t.waitlist = Math.max(0, t.waitlist - 1);
      const seat = t.booked + 1;
      book(s, t, 'تمت ترقيتك من قائمة الانتظار! تم تأكيد مقعد ' + seat + ' في ' + label(t));
      return true;
    }
    if (t.waitlist > 0 && t.booked < t.capacity) { t.waitlist -= 1; t.booked += 1; }
    return false;
  }

  function altFor(s, t) {
    const open = s.trips.filter((x) => x.id !== t.id && x.status === 'scheduled' && seatsLeft(x) > 0);
    const same = open.filter((x) => x.routeId === t.routeId && x.direction === t.direction);
    const pool = same.length ? same : open;
    pool.sort((a, b) => Math.abs(a.scheduledAt - t.scheduledAt) - Math.abs(b.scheduledAt - t.scheduledAt));
    return pool[0] || null;
  }

  function nextTripFor(s, t) {
    const free = s.trips
      .filter((x) => x.id !== t.id && x.status === 'scheduled' && seatsLeft(x) > 0 && !bookingFor(s, x.id) && x.scheduledAt > t.scheduledAt)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    const same = free.filter((x) => x.routeId === t.routeId && x.direction === t.direction);
    return same[0] || free[0] || null;
  }

  // The bus already went past the student's favourite station on a booked trip.
  function missedInfo(s) {
    const fav = s.me.favStation;
    for (const t of myTrips(s)) {
      const b = bookingFor(s, t.id);
      if (!b) continue;
      const stops = MB.stopsOf(t);
      const k = stops.indexOf(fav);
      if (k < 0) continue;
      if (t.status === 'en_route' && MB.etaMinutes(t, fav) === null) return { b, t };
      if (t.status === 'arrived' && k < stops.length - 1) return { b, t };
    }
    return null;
  }

  // ---------- actions ----------
  function bookAction(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t || t.status !== 'scheduled') return toast('الحجز مش متاح للرحلة دي');
    if (bookingFor(s, tid)) return toast('أنت محجوز في الرحلة دي بالفعل');
    if (seatsLeft(t) <= 0) return toast('الرحلة اكتملت، انضم لقائمة الانتظار');
    MB.update((st) => { book(st, st.trips.find((x) => x.id === tid)); });
    toast('تم تأكيد الحجز');
  }

  function joinWaitlist(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t) return;
    if (s.waitlistMine.some((w) => w.tripId === tid && w.status === 'waiting')) return toast('أنت في قائمة الانتظار بالفعل');
    if (seatsLeft(t) > 0) return toast('فيه مقاعد فاضية، احجز مباشرة');
    MB.update((st) => {
      const tr = st.trips.find((x) => x.id === tid);
      tr.waitlist += 1;
      st.waitlistMine.push({ id: uid('w'), tripId: tid, ts: now(), status: 'waiting' });
      st.notifications.unshift(note('انضممت لقائمة الانتظار في ' + label(tr) + '. هنبلغك أول ما يتحرر مقعد', 'waitlist', tid));
    });
    toast('تم إضافتك لقائمة الانتظار');
  }

  function leaveWaitlist(id) {
    MB.update((st) => {
      const i = st.waitlistMine.findIndex((w) => w.id === id);
      if (i < 0) return;
      const w = st.waitlistMine[i];
      const t = st.trips.find((x) => x.id === w.tripId);
      if (t) t.waitlist = Math.max(0, t.waitlist - 1);
      st.waitlistMine.splice(i, 1);
    });
    toast('خرجت من قائمة الانتظار');
  }

  function simulateFreedSeat(tid) {
    let promoted = false;
    const t0 = trip(tid);
    if (!t0 || t0.booked <= 0) return toast('مفيش مقاعد محجوزة تتحرر في الرحلة دي');
    MB.update((st) => { promoted = freeSeat(st, st.trips.find((x) => x.id === tid)); });
    toast(promoted ? 'اتحرر مقعد وتمت ترقيتك من الانتظار' : 'اتحرر مقعد (محاكاة)');
  }

  function cancelBooking(id) {
    const s = MB.state;
    const b = s.myBookings.find((x) => x.id === id);
    const t = b && trip(b.tripId);
    if (!t) return;
    if (!canCancel(t)) return toast('الإلغاء متاح قبل الرحلة بساعة على الأقل');
    MB.update((st) => {
      const bb = st.myBookings.find((x) => x.id === id);
      const tt = st.trips.find((x) => x.id === bb.tripId);
      bb.status = 'cancelled';
      freeSeat(st, tt);
      st.notifications.unshift(note('تم إلغاء حجزك في ' + label(tt), 'booking', tt.id));
    });
    toast('تم إلغاء الحجز');
  }

  function bookNext(tid, oldId) {
    const s = MB.state;
    const t = trip(tid);
    if (!t || seatsLeft(t) <= 0 || bookingFor(s, tid)) return toast('الرحلة دي مش متاحة دلوقتي');
    MB.update((st) => {
      const old = st.myBookings.find((x) => x.id === oldId);
      if (old) old.status = 'missed';
      book(st, st.trips.find((x) => x.id === tid));
    });
    toast('تم حجز الرحلة التالية');
  }

  function dismissMissed(id) {
    MB.update((st) => {
      const b = st.myBookings.find((x) => x.id === id);
      if (b) b.status = 'missed';
    });
  }

  function shareTrip(tid) {
    const link = trackUrl(tid);
    MB.update((st) => st.sharedLinks.push({ id: uid('L'), tripId: tid, url: link, ts: now(), by: st.me.name }));
    copyText(link);
  }

  function readyGo(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t || t.status !== 'at_start') return toast('الحافلة مش في محطة البداية دلوقتي');
    if (s.me.ready[tid]) return toast('أنت مسجل جاهز بالفعل');
    const stops = MB.stopsOf(t).slice(1);
    const d = draft.ready[tid] || {};
    const station = stops.indexOf(d.station) >= 0 ? d.station : stops[0];
    MB.update((st) => {
      st.waiting[tid] = st.waiting[tid] || {};
      st.waiting[tid][station] = (st.waiting[tid][station] || 0) + 1;
      st.me.ready[tid] = station;
      if (d.virtual) st.me.virtualStops[tid] = station;
      else delete st.me.virtualStops[tid];
    });
    toast('تم تسجيل جاهزيتك في ' + stName(station));
  }

  function readyUndo(tid) {
    const s = MB.state;
    const station = s.me.ready[tid];
    if (!station) return;
    MB.update((st) => {
      st.waiting[tid] = st.waiting[tid] || {};
      st.waiting[tid][station] = Math.max(0, (st.waiting[tid][station] || 0) - 1);
      delete st.me.ready[tid];
      delete st.me.virtualStops[tid];
    });
    toast('تم إلغاء الجاهزية');
  }

  function sendChat(tid) {
    const txt = (draft.chat[tid] || '').trim();
    if (!txt) return;
    MB.update((st) => st.chat.push({ id: uid('c'), tripId: tid, from: 'student', text: txt.slice(0, 300), ts: now() }));
    draft.chat[tid] = '';
  }

  function sendRating(tid) {
    const stars = draft.rate[tid];
    if (!stars) return toast('اختار عدد النجوم الأول');
    const t = trip(tid);
    MB.update((st) => st.ratings.push({ tripId: tid, driverId: t.driverId, stars, by: st.me.name, ts: now() }));
    delete draft.rate[tid];
    toast('شكراً! اتسجل تقييمك للرحلة والسائق');
  }

  function sendReport() {
    const d = draft.report;
    const txt = (d.text || '').trim();
    if (txt.length < 5) return toast('اكتب وصف أوضح للمشكلة (5 حروف على الأقل)');
    MB.update((st) => st.reports.unshift({
      id: uid('p'), ts: now(), studentName: st.me.name, category: d.cat,
      text: txt.slice(0, 500), status: 'open', assignee: '', tripId: d.trip || null,
    }));
    d.text = '';
    toast('تم إرسال البلاغ للإدارة');
  }

  function openSos() {
    closeModal();
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'sosModal';
    m.innerHTML = '<div class="card" role="dialog" aria-modal="true">' +
      '<h2>تأكيد نداء الطوارئ</h2>' +
      '<p class="mute">هيتبعت نداء فوري للإدارة باسمك ورقم رحلتك الحالية. اضغط تأكيد بس لو الموقف حقيقي.</p>' +
      '<div class="row"><button class="btn bad grow" data-act="sos-confirm">تأكيد الإرسال</button>' +
      '<button class="btn sec grow" data-act="modal-close">إلغاء</button></div></div>';
    document.body.appendChild(m);
  }
  function closeModal() { document.querySelectorAll('.modal').forEach((m) => m.remove()); }
  function sendSos() {
    const t = pickActive(MB.state);
    MB.update((st) => st.sos.push({ id: uid('sos'), ts: now(), student: st.me.name, tripId: t ? t.id : null }));
    closeModal();
    toast('تم إرسال نداء الطوارئ للإدارة');
  }

  // ---------- background watcher: targeted notifications (runs every second, writes only on events) ----------
  function watch() {
    const s = MB.state;
    if (!s || !s.me || !s.me.seen) return;
    const mine = new Set(s.myBookings.filter((b) => b.status === 'confirmed').map((b) => b.tripId));
    const fav = s.me.favStation;
    const seen = {}, notes = [], approach = [], cancelled = [];

    s.trips.forEach((t) => {
      if (mine.has(t.id)) {
        const prev = s.me.seen[t.id];
        if (prev === undefined) {
          seen[t.id] = t.status; // baseline on first visit, no notification
        } else if (prev !== t.status) {
          seen[t.id] = t.status;
          const lab = label(t);
          if (t.status === 'at_start') notes.push(note('السائق في محطة البداية لرحلة ' + lab + '. جهّز نفسك للصعود', 'driver', t.id));
          else if (t.status === 'en_route') notes.push(note('انطلقت الحافلة في رحلة ' + lab, 'driver', t.id));
          else if (t.status === 'arrived') notes.push(note('وصلت الحافلة لنهاية رحلة ' + lab + '. قيّم رحلتك', 'driver', t.id));
          else if (t.status === 'cancelled') {
            cancelled.push(t.id);
            const alt = altFor(s, t);
            notes.push(note('تم إلغاء رحلة ' + lab + '.' + (alt ? ' أقرب بديل: ' + label(alt) + ' الساعة ' + alt.time : ' مفيش بديل متاح دلوقتي'), 'cancel', t.id, alt ? alt.id : null));
          }
        }
      }
      if (t.status === 'en_route' && fav && !s.me.approachDone[t.id] && MB.stopsOf(t).indexOf(fav) >= 0) {
        const eta = MB.etaMinutes(t, fav);
        if (eta !== null && eta <= 2) approach.push({ t, eta });
      }
    });

    let chatTs = 0;
    const since = s.me.chatSeenTs || 0;
    s.chat.forEach((c) => {
      if (c.from === 'driver' && c.ts > since) {
        chatTs = Math.max(chatTs, c.ts);
        if (mine.has(c.tripId)) notes.push(note('رسالة جديدة من السائق: ' + c.text, 'driver', c.tripId));
      }
    });

    approach.forEach(({ t, eta }) => {
      notes.push(note('الحافلة اقتربت من محطتك (' + stName(fav) + ') · ' + label(t) + ' · الوصول خلال ' + eta + ' دقيقة', 'bus', t.id));
    });

    const changed = Object.keys(seen).length || notes.length || cancelled.length || approach.length || chatTs;
    if (!changed) return;
    MB.update((st) => {
      ensure(st);
      Object.assign(st.me.seen, seen);
      approach.forEach(({ t }) => { st.me.approachDone[t.id] = true; });
      cancelled.forEach((id) => {
        st.myBookings.forEach((b) => { if (b.tripId === id && b.status === 'confirmed') b.status = 'trip_cancelled'; });
      });
      notes.forEach((n) => st.notifications.unshift(n));
      if (chatTs) st.me.chatSeenTs = Math.max(st.me.chatSeenTs || 0, chatTs);
    });
  }

  // ---------- views ----------
  function readyCard(s) {
    const mine = new Set(s.myBookings.filter((b) => b.status === 'confirmed').map((b) => b.tripId));
    const list = s.trips.filter((t) => t.status === 'at_start')
      .sort((a, b) => (mine.has(b.id) ? 1 : 0) - (mine.has(a.id) ? 1 : 0))
      .slice(0, 2);
    if (!list.length) {
      const nx = s.trips.filter((t) => t.status === 'scheduled').sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
      return '<section class="card"><h3>محطة البداية</h3><p class="mute" style="margin:0">مفيش حافلة في محطة البداية دلوقتي.' +
        (nx ? ' أول رحلة جاية: ' + esc(label(nx)) + ' الساعة ' + esc(nx.time) + '.' : '') + '</p></section>';
    }
    return list.map((t) => {
      const head = '<div class="row"><div class="grow"><h3 style="margin:0">' + esc(label(t)) + '</h3>' +
        '<div class="mute">' + (mine.has(t.id) ? 'حجزك في الرحلة دي' : 'رحلة في محطة البداية') + ' · ' + esc(MB.bus[t.busId].plate) + '</div></div>' +
        statusBadge(t) + '</div>';
      const readyAt = s.me.ready[t.id];
      if (readyAt) {
        return '<section class="card">' + head +
          '<p style="margin:10px 0 0">تم تسجيل جاهزيتك في <b>' + esc(stName(readyAt)) + '</b>' +
          (s.me.virtualStops[t.id] ? ' (محطة افتراضية)' : '') + '.</p>' +
          '<button class="btn sec sm" style="margin-top:8px" data-act="ready-undo" data-trip="' + t.id + '">إلغاء الجاهزية</button></section>';
      }
      const stops = MB.stopsOf(t).slice(1);
      const d = draft.ready[t.id] || {};
      const cur = stops.indexOf(d.station) >= 0 ? d.station : stops[0];
      return '<section class="card">' + head +
        '<div class="mute" style="margin-top:10px">اختار محطة صعودك:</div>' +
        stops.map((sid) => '<label class="opt"><input type="radio" name="rs-' + t.id + '" value="' + sid + '" data-field="ready-station" data-trip="' + t.id + '"' +
          (sid === cur ? ' checked' : '') + '> ' + esc(stName(sid)) + '</label>').join('') +
        '<label class="opt"><input type="checkbox" data-field="ready-virtual" data-trip="' + t.id + '"' + (d.virtual ? ' checked' : '') +
        '> سجّلها كمحطة افتراضية (نقطة صعود إضافية للسائق)</label>' +
        '<button class="btn" style="margin-top:8px" data-act="ready-go" data-trip="' + t.id + '">أنا جاهز للصعود</button></section>';
    }).join('');
  }

  function missedCard(s, m) {
    const next = nextTripFor(s, m.t);
    return '<section class="card" style="border-color:var(--bad)"><h3>فاتتك الرحلة</h3>' +
      '<div class="mute">الحافلة عدّت محطتك (' + esc(stName(s.me.favStation)) + ') في ' + esc(label(m.t)) + '.</div>' +
      (next
        ? '<div class="row" style="margin-top:10px"><div class="grow"><b>الرحلة الجاية: ' + esc(label(next)) + '</b>' +
          '<div class="mute">متبقي ' + seatsLeft(next) + ' مقعد</div></div>' +
          '<button class="btn sm" data-act="book-next" data-trip="' + next.id + '" data-old="' + m.b.id + '">احجز الرحلة دي</button></div>'
        : '<div class="mute" style="margin-top:8px">مفيش رحلة جاية بمقاعد فاضية. تقدر تنضم لقائمة الانتظار من تبويب الحجز.</div>') +
      '<div class="row" style="margin-top:8px"><button class="btn sec sm" data-act="missed-dismiss" data-id="' + m.b.id + '">تجاهل الحجز القديم</button></div></section>';
  }

  function activeCard(s, t) {
    const fav = s.me.favStation;
    const drv = MB.drv[t.driverId] || { name: '—', rating: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const stops = MB.stopsOf(t);
    const last = stops[stops.length - 1];
    const lastLink = s.sharedLinks.filter((l) => l.tripId === t.id).pop();
    const msgs = s.chat.filter((c) => c.tripId === t.id).slice(-25);
    const moving = t.status === 'en_route';
    let skipNote = '';
    if (moving) {
      const skip = MB.emptyAhead(t).filter((id) => id !== fav);
      skipNote = skip.length
        ? 'الحافلة هتعدّي ' + skip.length + ' محطة فاضية من غير ما تقف: ' + skip.map(stName).join('، ') + '. محطتك مستثناة من التخطي.'
        : 'مفيش محطات فاضية قدامها، الحافلة هتوقف في كل المحطات.';
    }
    const prog = Math.round(MB.progressOf(t) * 100);
    let statusLine;
    if (t.status === 'scheduled') statusLine = 'الرحلة الساعة ' + esc(t.time) + '. الوقت المتوقع للرحلة كاملة ' + TOTAL_MIN + ' دقيقة.';
    else if (t.status === 'at_start') statusLine = 'الحافلة في محطة البداية. سجّل جاهزيتك من فوق لو هتركب.';
    else if (t.status === 'arrived') statusLine = 'الرحلة خلصت. شكراً ليك.';
    else statusLine = '';

    return '<section class="card">' +
      '<div class="row"><div class="grow"><div class="mute">رحلتك</div><h2 style="margin:0;font-size:18px">' + esc(label(t)) + '</h2></div>' + statusBadge(t) + '</div>' +
      '<div class="grid g2" style="margin-top:10px">' +
        '<div><div class="mute">السائق</div><b>' + esc(drv.name) + '</b> <span class="mute">' + esc(drv.rating) + ' ★</span></div>' +
        '<div><div class="mute">رقم الحافلة</div><b>' + esc(bus.plate) + '</b></div>' +
      '</div>' +
      (moving
        ? '<div class="grid g2" style="margin-top:12px">' +
            '<div><div class="mute">الوصول لمحطتك (' + esc(stName(fav)) + ')</div>' +
              '<div class="kpi" data-live="eta" data-trip="' + t.id + '" data-station="' + fav + '">' + esc(etaText(t, fav)) + '</div></div>' +
            '<div><div class="mute">الوقت المتوقع للرحلة كاملة: ' + TOTAL_MIN + ' دقيقة</div>' +
              '<div class="mute">متبقي للنهاية: <b data-live="eta" data-trip="' + t.id + '" data-station="' + last + '">' + esc(etaText(t, last)) + '</b></div></div>' +
          '</div>' +
          '<div class="bar"><i data-live="bar" data-trip="' + t.id + '" style="width:' + prog + '%"></i></div>' +
          '<div class="note">' + esc(skipNote) + '</div>'
        : '<p class="mute" style="margin:10px 0 0">' + statusLine + '</p>') +
      '<div class="row" style="margin-top:12px"><button class="btn sec sm" data-act="share" data-trip="' + t.id + '">شارك رابط التتبع المباشر</button></div>' +
      (lastLink ? '<div class="row" style="margin-top:8px"><input readonly value="' + esc(lastLink.url) + '" style="flex:1;direction:ltr">' +
        '<button class="btn sec sm" data-act="copy" data-link="' + esc(lastLink.url) + '">نسخ</button></div>' : '') +
      '<h3 style="margin:16px 0 6px;font-size:15px">محادثة مع السائق</h3>' +
      '<div class="chat">' + (msgs.length
        ? msgs.map((c) => '<div class="msg ' + (c.from === 'student' ? 'me' : '') + '">' + esc(c.text) + '</div>').join('')
        : '<div class="mute">ابدأ المحادثة مع السائق لو محتاج حاجة</div>') + '</div>' +
      '<div class="row"><input data-field="chat-text" data-trip="' + t.id + '" value="' + esc(draft.chat[t.id] || '') +
        '" placeholder="اكتب رسالة للسائق" style="flex:1"><button class="btn sm" data-act="chat-send" data-trip="' + t.id + '">إرسال</button></div>' +
      '</section>';
  }

  function nextCard(s) {
    const up = s.trips.filter((t) => t.status === 'scheduled').sort((a, b) => a.scheduledAt - b.scheduledAt);
    const future = up.filter((t) => t.scheduledAt >= now() - 60000);
    const list = (future.length ? future : up).slice(0, 3);
    return '<section class="card"><h3>الرحلات الجاية</h3>' + (list.length
      ? list.map((t) => '<div class="trip-row row"><div class="grow"><b>' + esc(label(t)) + '</b>' +
          '<div class="mute">متبقي ' + seatsLeft(t) + ' من ' + t.capacity + ' مقعد</div></div>' +
          (bookingFor(s, t.id) ? '<span class="badge ok">محجوزة</span>' : '<a class="btn sm" href="#book">احجز</a>') + '</div>').join('')
      : '<p class="mute" style="margin:0">مفيش رحلات جاية حالياً.</p>') + '</section>';
  }

  function ratingCard(s) {
    const t = myTrips(s).find((x) => x.status === 'arrived' && !s.ratings.some((r) => r.tripId === x.id && r.by === s.me.name));
    if (!t) return '';
    const drv = MB.drv[t.driverId] || { name: '—' };
    const cur = draft.rate[t.id] || 0;
    const stars = [1, 2, 3, 4, 5].map((n) => '<button class="btn sec sm" data-act="star" data-trip="' + t.id + '" data-stars="' + n +
      '" style="font-size:20px;color:' + (n <= cur ? '#f59f00' : 'var(--mute)') + '">' + (n <= cur ? '★' : '☆') + '</button>').join('');
    return '<section class="card"><h3>قيّم رحلتك</h3><div class="mute">' + esc(label(t)) + ' · السائق ' + esc(drv.name) + '</div>' +
      '<div class="stars-row" style="margin:8px 0">' + stars + '</div>' +
      '<div class="row"><button class="btn sm" data-act="rate-send" data-trip="' + t.id + '">إرسال التقييم</button>' +
      '<a class="btn sec sm" href="#support">أبلغ عن مشكلة</a></div></section>';
  }

  function favCard(s) {
    return '<section class="card"><h3>محطتي المفضلة</h3><select data-field="fav">' +
      MB.stations.map((st) => '<option value="' + st.id + '"' + (st.id === s.me.favStation ? ' selected' : '') + '>' + esc(st.name) + '</option>').join('') +
      '</select><p class="mute" style="margin:8px 0 0">بنستخدمها في إشعار اقتراب الحافلة وحساب وقت وصولك.</p></section>';
  }

  function homeView(s) {
    const active = pickActive(s);
    const missed = missedInfo(s);
    const firstName = String(s.me.name || '').split(' ')[0];
    return '<section class="row" style="margin:4px 0 12px">' +
      '<div class="grow"><div class="mute">أهلاً يا ' + esc(firstName) + '</div><h2 style="margin:0;font-size:20px">رحلتك النهاردة</h2></div>' +
      '<span class="badge info">' + esc(s.me.plan) + '</span></section>' +
      readyCard(s) +
      (missed ? missedCard(s, missed) : '') +
      (active ? activeCard(s, active) : nextCard(s)) +
      ratingCard(s) +
      '<section class="card row"><div class="grow"><b>حالة طارئة؟</b><div class="mute">ابعت نداء فوري للإدارة</div></div>' +
      '<button class="btn bad" data-act="sos-open">نداء طوارئ</button></section>' +
      favCard(s);
  }

  function tripRow(s, t) {
    const mine = bookingFor(s, t.id);
    const waiting = s.waitlistMine.some((w) => w.tripId === t.id && w.status === 'waiting');
    let action;
    if (mine) action = '<span class="badge ok">محجوزة · مقعد ' + mine.seat + '</span>';
    else if (t.status !== 'scheduled') action = '<span class="badge">' + esc(MB.statusLabel[t.status] || '') + '</span>';
    else if (seatsLeft(t) > 0) action = '<button class="btn sm" data-act="book" data-trip="' + t.id + '">احجز</button>';
    else if (waiting) action = '<span class="badge warn">في الانتظار</span>';
    else action = '<button class="btn sec sm" data-act="waitlist" data-trip="' + t.id + '">انضم للانتظار</button>';
    const seatTxt = seatsLeft(t) > 0 ? 'متبقي ' + seatsLeft(t) + ' من ' + t.capacity + ' مقعد' : 'مكتملة · في الانتظار: ' + t.waitlist;
    return '<div class="trip-row row"><div class="grow"><b>' + esc(t.time) + '</b> ' + statusBadge(t) +
      '<div class="mute">' + seatTxt + '</div></div>' + action + '</div>';
  }

  function myBookingsCard(s) {
    const all = s.myBookings.slice().reverse();
    let rows = '';
    all.forEach((b) => {
      const t = trip(b.tripId);
      if (!t) return;
      const can = b.status === 'confirmed' && canCancel(t);
      rows += '<div class="trip-row row"><div class="grow"><b>' + esc(label(t)) + '</b>' +
        '<div class="mute">مقعد ' + b.seat + ' · ' + esc(BOOK_STATUS[b.status] || b.status) + '</div></div>' +
        (b.status === 'confirmed' ? '<button class="btn bad sm" ' + (can ? '' : 'disabled') + ' data-act="cancel-booking" data-id="' + b.id + '">إلغاء</button>' : '') +
        '</div>';
    });
    return '<section class="card"><h3>حجوزاتي</h3>' +
      (rows || '<p class="mute">لسه معندكش حجوزات.</p>') +
      '<p class="mute" style="margin:8px 0 0">الإلغاء متاح قبل الرحلة بساعة على الأقل.</p></section>';
  }

  function waitlistCard(s) {
    const waiting = s.waitlistMine.filter((x) => x.status === 'waiting');
    let rows = '';
    waiting.forEach((x) => {
      const t = trip(x.tripId);
      if (!t) return;
      const pos = waiting.filter((y) => y.tripId === x.tripId && y.ts <= x.ts).length;
      rows += '<div class="trip-row row"><div class="grow"><b>' + esc(label(t)) + '</b><div class="mute">ترتيبك: ' + pos + '</div></div>' +
        '<button class="btn sec sm" data-act="sim-free" data-trip="' + t.id + '">محاكاة: حد لغى حجزه</button>' +
        '<button class="btn sec sm" data-act="leave-wait" data-id="' + x.id + '">خروج</button></div>';
    });
    return '<section class="card"><h3>قائمة الانتظار</h3>' + (rows ||
      '<p class="mute" style="margin:0">مفيش انتظار حالياً. لو الرحلة اكتملت انضم للانتظار وهنبلغك أول ما يتحرر مقعد.</p>') + '</section>';
  }

  function bookView(s) {
    const rid = draft.route;
    const route = MB.R[rid];
    const trips = s.trips.filter((t) => t.routeId === rid).sort((a, b) => a.scheduledAt - b.scheduledAt);
    const tabs = MB.routes.map((x) => '<button class="btn sm ' + (x.id === rid ? '' : 'sec') + '" data-act="route" data-route="' + x.id + '">' + esc(x.name) + '</button>').join(' ');
    const dirSection = (dir, title) => {
      const list = trips.filter((t) => t.direction === dir);
      return '<section class="card"><h3>' + title + '</h3>' + (list.length
        ? list.map((t) => tripRow(s, t)).join('')
        : '<p class="mute" style="margin:0">مفيش رحلات في الاتجاه ده</p>') + '</section>';
    };
    return '<h2 style="margin:0 0 6px;font-size:18px">احجز مقعدك</h2>' +
      '<div class="row" style="margin-bottom:6px">' + tabs + '</div>' +
      '<p class="mute" style="margin:0 0 12px">المحطات: ' + route.stops.map(stName).join(' ← ') + '</p>' +
      '<div class="grid g2">' + dirSection('go', 'ذهاب') + dirSection('back', 'عودة') + '</div>' +
      myBookingsCard(s) + waitlistCard(s);
  }

  function alertsView(s) {
    const list = s.notifications.slice(0, 60);
    const unread = s.notifications.filter((n) => !n.read).length;
    const cards = list.map((n) => {
      const alt = n.altTripId ? trip(n.altTripId) : null;
      const altBtn = alt && alt.status === 'scheduled' && seatsLeft(alt) > 0 && !bookingFor(s, alt.id)
        ? '<div class="row" style="margin-top:8px"><button class="btn sm" data-act="book" data-trip="' + alt.id + '">احجز البديل: ' + esc(alt.time) + '</button></div>' : '';
      return '<div class="card" style="' + (n.read ? '' : 'border-inline-start:4px solid var(--brand)') + '">' +
        '<div class="row"><span class="badge ' + (KIND_CLS[n.kind] || '') + '">' + esc(KIND_LABEL[n.kind] || 'عام') + '</span>' +
        '<span class="mute grow" style="text-align:start">' + MB.fmtTime(n.ts) + '</span></div>' +
        '<div style="margin-top:6px">' + esc(n.text) + '</div>' + altBtn + '</div>';
    }).join('');
    return '<section class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0;font-size:18px">الإشعارات' +
      (unread ? ' <span class="badge bad">' + unread + ' جديد</span>' : '') + '</h2>' +
      '<button class="btn sec sm" data-act="notif-read">علّم الكل كمقروء</button></section>' + cards;
  }

  function supportView(s) {
    const d = draft.report;
    const opts = '<option value="">عام (بدون رحلة)</option>' + myTrips(s).map((t) =>
      '<option value="' + t.id + '"' + (d.trip === t.id ? ' selected' : '') + '>' + esc(label(t)) + '</option>').join('');
    const mine = s.reports.filter((r) => r.studentName === s.me.name);
    const recent = s.reports.slice(0, 5);
    const rep = (r) => '<div class="trip-row"><div class="row"><b class="grow">' + esc(r.category) + '</b>' +
      (r.status === 'open' ? '<span class="badge warn">مفتوح</span>' : '<span class="badge ok">مغلق</span>') + '</div>' +
      '<div class="mute">' + MB.fmtTime(r.ts) + '</div><div style="margin-top:4px">' + esc(r.text) + '</div></div>';
    return '<section class="card"><h2>نداء طوارئ</h2><p class="mute">للمواقف العاجلة بس. النداء بيوصل للإدارة فوراً.</p>' +
      '<button class="btn bad big" data-act="sos-open">إرسال نداء طوارئ</button></section>' +
      '<section class="card"><h2>أبلغ عن مشكلة</h2>' +
      '<label>نوع المشكلة</label><select data-field="report-cat">' +
        REPORT_CATS.map((c) => '<option' + (c === d.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
      '<label>الرحلة</label><select data-field="report-trip">' + opts + '</select>' +
      '<label>وصف المشكلة</label><textarea rows="4" data-field="report-text" placeholder="اكتب التفاصيل بإيجاز">' + esc(d.text) + '</textarea>' +
      '<button class="btn" style="margin-top:10px" data-act="report-send">إرسال البلاغ</button></section>' +
      '<section class="card"><h2>بلاغاتي</h2>' + (mine.length ? mine.slice(0, 10).map(rep).join('') :
        '<p class="mute" style="margin:0">لسه معندكش بلاغات. ابعت بلاغ من فوق ومتابعة حالته هتظهر هنا.</p>') + '</section>' +
      '<section class="card"><h2>آخر البلاغات في الخطوط</h2><div class="mute" style="margin-bottom:6px">من غير أسماء الطلبة</div>' +
        recent.map(rep).join('') + '</section>';
  }

  // ---------- maps (Leaflet, optional) ----------
  function destroyMap() {
    if (mapCtl && mapCtl.map) mapCtl.map.remove();
    mapCtl = null;
  }

  function mountMap(key, tid) {
    const el = document.getElementById('mapBox');
    const t = trip(tid);
    mapCtl = { key, tripId: tid, map: null, bus: null };
    if (!el || !t) return;
    if (!window.L) {
      el.style.height = 'auto';
      el.innerHTML = '<div class="card mute" style="margin:0">الخريطة بتحتاج اتصال بالإنترنت عشان تتحمّل. التفاصيل والمحطات تحت.</div>';
      return;
    }
    const L = window.L;
    const route = MB.R[t.routeId];
    const map = L.map(el, { scrollWheelZoom: false }).setView([30.04, 31.25], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    const line = L.polyline(MB.polyOf(t), { color: route.color, weight: 5, opacity: 0.85 }).addTo(map);
    MB.stopsOf(t).forEach((sid, i) => {
      const st = MB.S[sid];
      L.marker([st.lat, st.lng], {
        icon: L.divIcon({ className: '', html: '<div class="pin">' + (i + 1) + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).bindPopup(esc((i + 1) + '. ' + st.name)).addTo(map);
    });
    map.fitBounds(line.getBounds(), { padding: [30, 30] });
    mapCtl.map = map;
    tickMap();
  }

  function tickMap() {
    if (!mapCtl || !mapCtl.map || !window.L) return;
    const t = trip(mapCtl.tripId);
    if (!t) return;
    const pos = MB.position(t);
    if (pos) {
      if (!mapCtl.bus) {
        mapCtl.bus = window.L.marker([pos.lat, pos.lng], {
          icon: window.L.divIcon({
            className: '',
            html: '<div class="pin bus" style="width:auto;height:28px;padding:0 8px;font-size:11px">حافلة</div>',
            iconSize: [64, 28], iconAnchor: [32, 14],
          }),
          zIndexOffset: 1000,
        }).addTo(mapCtl.map);
      }
      mapCtl.bus.setLatLng([pos.lat, pos.lng]);
    } else if (mapCtl.bus) {
      mapCtl.map.removeLayer(mapCtl.bus);
      mapCtl.bus = null;
    }
  }

  function mapInfoHtml(s, t, track) {
    const drv = MB.drv[t.driverId] || { name: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const stops = MB.stopsOf(t);
    const last = stops[stops.length - 1];
    const fav = s.me.favStation;
    const pos = MB.position(t);
    const list = stops.map((sid, i) => {
      const isFav = sid === fav && !track;
      return '<li class="opt" style="justify-content:space-between;' + (isFav ? 'font-weight:700;color:var(--brand)' : '') + '">' +
        '<span>' + (i + 1) + '. ' + esc(stName(sid)) + (isFav ? ' (محطتك)' : '') + '</span>' +
        '<span class="mute" data-live="eta" data-trip="' + t.id + '" data-station="' + sid + '">' + esc(etaText(t, sid)) + '</span></li>';
    }).join('');
    const head = pos
      ? '<div class="grid g2" style="margin-top:10px"><div><div class="mute">المحطة الجاية</div><b>' + esc(stName(pos.nextStopId)) + '</b></div>' +
        '<div><div class="mute">الوقت المتبقي للنهاية</div><b data-live="eta" data-trip="' + t.id + '" data-station="' + last + '">' + esc(etaText(t, last)) + '</b></div></div>'
      : '<p class="mute" style="margin:8px 0 0">' + (t.status === 'scheduled' ? 'الحافلة لم تنطلق بعد. موعد الانطلاق ' + esc(t.time)
        : t.status === 'arrived' ? 'الحافلة وصلت لنهاية الخط' : 'الحافلة مش على الطريق دلوقتي') + '</p>';
    const mine = track ? '' : '<p class="mute" style="margin:8px 0 0">وقت وصولك لمحطتك (' + esc(stName(fav)) + '): ' +
      '<b data-live="eta" data-trip="' + t.id + '" data-station="' + fav + '">' + esc(etaText(t, fav)) + '</b></p>';
    return '<section class="card"><div class="row"><div class="grow"><b>' + esc(label(t)) + '</b>' +
      '<div class="mute">' + esc(bus.plate) + ' · ' + esc(drv.name) + '</div></div>' + statusBadge(t) + '</div>' + head + mine + '</section>' +
      '<section class="card"><h3>المحطات</h3><ol style="margin:0;padding-inline-start:0;list-style:none">' + list + '</ol></section>';
  }

  function mapShell(s, tid) {
    const opts = s.trips.map((t) => '<option value="' + t.id + '"' + (t.id === tid ? ' selected' : '') + '>' +
      esc(label(t)) + ' · ' + esc(MB.statusLabel[t.status] || '') + '</option>').join('');
    return '<h2 style="margin:0 0 8px;font-size:18px">الخريطة المباشرة</h2>' +
      '<select data-field="map-trip" aria-label="اختار الرحلة" style="margin-bottom:12px">' + opts + '</select>' +
      '<div id="mapBox" class="map tall"></div><div id="mapInfo"></div>';
  }

  function trackShell() {
    return '<section class="card"><h2 style="margin:0 0 4px;font-size:18px">تتبع مباشر للرحلة</h2>' +
      '<div class="mute">رابط للقراءة فقط. مفيش تسجيل دخول ولا بيانات شخصية.</div></section>' +
      '<div id="mapBox" class="map tall"></div><div id="mapInfo"></div>';
  }

  function notFoundView() {
    return '<section class="card"><h2>الرابط مش صالح</h2><p class="mute">الرحلة دي مش موجودة أو الرابط اتقص. اطلب الرابط الجديد من الطالب اللي شاركه.</p>' +
      '<a class="btn" href="#home">للصفحة الرئيسية</a></section>';
  }

  function pickMapTrip(s) {
    if (draft.mapTrip && trip(draft.mapTrip)) return draft.mapTrip;
    const t = s.trips.find((x) => x.status === 'en_route') || s.trips.find((x) => x.status === 'at_start') ||
      s.trips.find((x) => x.routeId === 'r1' && x.direction === 'go') || s.trips[0];
    return t.id;
  }

  function refreshInfo(s, t, track) {
    const el = document.getElementById('mapInfo');
    if (el) el.innerHTML = mapInfoHtml(s, t, track);
  }

  function renderMapView(s, r) {
    if (r.view === 'track') {
      const key = 'track:' + r.id;
      const t = trip(r.id);
      if (!t) {
        if (!mapCtl || mapCtl.key !== key) { destroyMap(); app.innerHTML = notFoundView(); mapCtl = { key, map: null, bus: null }; }
        return;
      }
      if (!mapCtl || mapCtl.key !== key) { destroyMap(); app.innerHTML = trackShell(); mountMap(key, r.id); }
      refreshInfo(s, t, true);
      return;
    }
    const tid = pickMapTrip(s);
    const key = 'map:' + tid;
    if (!mapCtl || mapCtl.key !== key) { destroyMap(); app.innerHTML = mapShell(s, tid); mountMap(key, tid); }
    refreshInfo(s, trip(tid), false);
  }

  // ---------- render loop ----------
  function parseRoute() {
    const h = location.hash.replace(/^#/, '');
    if (h.indexOf('track=') === 0) return { view: 'track', id: decodeURIComponent(h.slice(6)) };
    return { view: VIEWS.indexOf(h) >= 0 ? h : 'home', id: '' };
  }

  function render() {
    const s = MB.state;
    if (!s) return;
    const r = parseRoute();
    document.body.classList.toggle('track', r.view === 'track');
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === r.view));
    const unread = s.notifications.filter((n) => !n.read).length;
    const cEl = document.getElementById('unreadCount');
    if (cEl) cEl.textContent = unread ? String(unread) : '';
    if (r.view === 'map' || r.view === 'track') { renderMapView(s, r); return; }
    destroyMap();
    const views = { home: homeView, book: bookView, alerts: alertsView, support: supportView };
    app.innerHTML = views[r.view](s);
  }

  // live values every second: bus marker, ETAs and progress bars (no full re-render, so inputs keep focus)
  function tick() {
    if (mapCtl && mapCtl.map) tickMap();
    document.querySelectorAll('[data-live="eta"]').forEach((el) => {
      el.textContent = etaText(trip(el.dataset.trip), el.dataset.station);
    });
    document.querySelectorAll('[data-live="bar"]').forEach((el) => {
      const t = trip(el.dataset.trip);
      if (t) el.style.width = Math.round(MB.progressOf(t) * 100) + '%';
    });
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case 'route': draft.route = d.route; render(); break;
      case 'star': draft.rate[d.trip] = Number(d.stars); render(); break;
      case 'rate-send': sendRating(d.trip); break;
      case 'ready-go': readyGo(d.trip); break;
      case 'ready-undo': readyUndo(d.trip); break;
      case 'share': shareTrip(d.trip); break;
      case 'copy': copyText(d.link); break;
      case 'chat-send': sendChat(d.trip); break;
      case 'book': bookAction(d.trip); break;
      case 'waitlist': joinWaitlist(d.trip); break;
      case 'leave-wait': leaveWaitlist(d.id); break;
      case 'sim-free': simulateFreedSeat(d.trip); break;
      case 'cancel-booking': cancelBooking(d.id); break;
      case 'book-next': bookNext(d.trip, d.old); break;
      case 'missed-dismiss': dismissMissed(d.id); break;
      case 'report-send': sendReport(); break;
      case 'notif-read': MB.update((st) => st.notifications.forEach((n) => { n.read = true; })); break;
      case 'sos-open': openSos(); break;
      case 'sos-confirm': sendSos(); break;
      case 'modal-close': closeModal(); break;
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    const f = el.dataset && el.dataset.field;
    if (!f) return;
    switch (f) {
      case 'fav':
        MB.update((st) => { st.me.favStation = el.value; });
        toast('تم حفظ المحطة المفضلة');
        break;
      case 'map-trip': draft.mapTrip = el.value; render(); break;
      case 'ready-station':
        draft.ready[el.dataset.trip] = Object.assign({}, draft.ready[el.dataset.trip], { station: el.value });
        break;
      case 'ready-virtual':
        draft.ready[el.dataset.trip] = Object.assign({}, draft.ready[el.dataset.trip], { virtual: el.checked });
        break;
      case 'report-cat': draft.report.cat = el.value; break;
      case 'report-trip': draft.report.trip = el.value; break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    const f = el.dataset && el.dataset.field;
    if (f === 'report-text') draft.report.text = el.value;
    else if (f === 'chat-text') draft.chat[el.dataset.trip] = el.value;
  });

  app.addEventListener('focusout', () => {
    setTimeout(() => { if (pending && !busy()) { pending = false; render(); } }, 200);
  });

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

  // ---------- boot ----------
  MB.subscribe(() => {
    if (busy()) pending = true;
    else render();
  });
  MB.update(ensure);
  render();
  setInterval(tick, 1000);
  setInterval(watch, 1000);
})();
