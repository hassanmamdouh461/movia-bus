/* Movia Bus — Student Interface (Simplified, clean, responsive) */
(function () {
  'use strict';
  const MB = window.MB;
  if (!MB) return;
  const app = document.getElementById('app');
  const TOTAL_MIN = Math.round((MB.TRIP_MS / 60000) * 3);
  const REPORT_CATS = ['تأخير الحافلة', 'نظافة الحافلة', 'سلوك السائق', 'تجاوز مكان الركوب', 'أخرى'];
  const KIND_LABEL = { bus: 'اقتراب الحافلة', driver: 'تحديث السائق', cancel: 'إلغاء وبديل', booking: 'تأكيد حجز', waitlist: 'قائمة الانتظار', info: 'إشعار' };
  const KIND_CLS = { bus: 'info', driver: 'ok', cancel: 'bad', booking: 'ok', waitlist: 'warn', info: '' };
  const BOOK_STATUS = { confirmed: 'مؤكد', cancelled: 'ملغي', missed: 'فاتتك الرحلة', trip_cancelled: 'ألغيت الرحلة' };
  const VIEWS = ['home', 'book', 'chat', 'alerts'];
  const QUICK_REPLIES = ['أنا منتظر في مكاني', 'كم دقيقة للوصول؟', 'تمام يا كابتن شكراً'];
  // pickup (Ready) status -> chip text / badge class
  const PK_LABEL = {
    waiting: 'في انتظار السواق', accepted: 'السواق هيقف لك', boarding: 'الباص واقف — اركب',
    boarded: 'تم الركوب', skipped: 'السواق مش هيقدر يقف — أقرب رحلة', passed: 'الباص عدّى مكانك',
  };
  const PK_CLS = { waiting: 'warn', accepted: 'ok', boarding: 'ok', boarded: 'ok', skipped: 'bad', passed: 'bad' };

  const draft = {
    route: 'r1',
    pickMode: null,     // trip id while the student is choosing a point on the map
    locating: null,     // trip id while geolocation is being requested
    chat: {},
    rate: {},
    report: { cat: REPORT_CATS[0], trip: '', text: '' },
    mapTrip: null,
  };
  let mapCtl = null;
  let pending = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function now() { return Date.now(); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function trip(id) { return id ? MB.trip(id) : undefined; }
  function label(t) { return MB.tripLabel(t); }
  function firstName(full) { return String(full || '').split(' ')[0]; }
  function drvFirst(t) { const d = MB.drv[t.driverId]; return d ? String(d.name).replace(/^أ\.\s*/, '').split(' ')[0] : 'السائق'; }
  function drvInitial(t) { const d = MB.drv[t.driverId]; const n = d ? String(d.name).replace(/^أ\.\s*/, '') : ''; return n.charAt(0) || 'س'; }
  function seatsLeft(t) { return Math.max(0, t.capacity - t.booked); }
  // start / end names of a trip's direction
  function endNames(t) {
    const r = MB.R[t.routeId];
    return t.direction === 'go' ? { from: r.fromName, to: r.toName } : { from: r.toName, to: r.fromName };
  }
  function routeLine(t) { const e = endNames(t); return 'من ' + e.from + ' → إلى ' + e.to; }
  function statusBadge(t) {
    const cls = { scheduled: 'info', at_start: 'warn', en_route: 'ok', arrived: '', cancelled: 'bad' }[t.status] || '';
    return '<span class="badge ' + cls + '">' + esc(MB.statusLabel[t.status] || t.status) + '</span>';
  }
  function seatPill(t) {
    if (t.status !== 'scheduled' && t.status !== 'at_start') return '<span class="pill">' + esc(MB.statusLabel[t.status] || '') + '</span>';
    const left = seatsLeft(t);
    if (left <= 0) return '<span class="pill bad">مكتملة' + (t.waitlist ? ' · انتظار ' + t.waitlist : '') + '</span>';
    if (left <= 5) return '<span class="pill warn">متبقي ' + left + ' مقعد</span>';
    return '<span class="pill ok">متبقي ' + left + ' مقعد</span>';
  }
  function toast(msg) {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
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
    if (draft.mapTrip && trip(draft.mapTrip)) return trip(draft.mapTrip);
    const ts = myTrips(s);
    return ts.find((t) => t.status === 'en_route')
      || ts.find((t) => t.status === 'at_start')
      || ts.find((t) => t.status === 'scheduled')
      || s.trips.find((t) => t.status === 'en_route')
      || ts[0]
      || s.trips[0]
      || null;
  }
  // my pickup point (Ready) on a trip — the most recent one I created there
  function myPk(s, tid) {
    let found = null;
    (s.pickups || []).forEach((k) => { if (k.tripId === tid && k.mine) found = k; });
    return found;
  }
  function pkChip(pk) {
    return '<span class="badge ' + PK_CLS[pk.status] + '">' + esc(PK_LABEL[pk.status] || pk.status) + '</span>';
  }
  function trackUrl(tid) {
    const base = (location.origin && location.origin !== 'null') ? location.origin + location.pathname : location.href.split('#')[0];
    return base + '#track=' + tid;
  }

  // ETA model: before Ready -> bus's remaining trip time; after Ready -> time until the bus reaches my pickup
  function etaInfo(t) {
    if (!t || t.status !== 'en_route') return null;
    const pk = myPk(MB.state, t.id);
    if (!pk || pk.status === 'boarded') return { kind: 'min', m: MB.etaToProgress(t, 1) };
    if (pk.status === 'waiting' || pk.status === 'accepted') {
      const m = MB.etaToPickup(t, pk);
      return m === null ? { kind: 'passed' } : { kind: 'min', m };
    }
    if (pk.status === 'boarding') return { kind: 'now' };
    return { kind: pk.status === 'skipped' ? 'skipped' : 'passed' };
  }
  function fmtEta(info) {
    if (info.kind === 'min') return info.m <= 1 ? 'أقل من دقيقة' : info.m + ' دقيقة';
    if (info.kind === 'now') return 'الآن';
    if (info.kind === 'skipped') return 'مش هيقف';
    return 'مرت الحافلة';
  }
  function etaText(t) {
    if (!t) return '—';
    if (t.status === 'scheduled') return 'الموعد ' + t.time;
    if (t.status === 'at_start') return 'في بداية الخط';
    if (t.status === 'arrived') return 'وصلت';
    if (t.status === 'cancelled') return 'ملغاة';
    const info = etaInfo(t);
    return info ? fmtEta(info) : '—';
  }
  function endText(t) {
    if (t && t.status === 'en_route') return fmtEta({ kind: 'min', m: MB.etaToProgress(t, 1) });
    return etaText(t);
  }
  function etaBigHtml(t) {
    if (t.status === 'en_route') {
      const info = etaInfo(t);
      if (info.kind === 'min') return (info.m <= 1 ? 1 : info.m) + '<small>دقيقة</small>';
      if (info.kind === 'now') return 'الآن<small>اركب الآن</small>';
      if (info.kind === 'skipped') return 'مش هيقف<small>السواق معتذر</small>';
      return 'مرت<small>الحافلة عدّت مكانك</small>';
    }
    if (t.status === 'scheduled') return esc(t.time) + '<small>موعد الانطلاق</small>';
    if (t.status === 'at_start') return 'الآن<small>في بداية الخط</small>';
    if (t.status === 'arrived') return 'وصلت<small>انتهت الرحلة</small>';
    return '—';
  }
  function stepperHtml(t) {
    const info = etaInfo(t);
    const pk = myPk(MB.state, t.id);
    const pkOpen = pk && (pk.status === 'waiting' || pk.status === 'accepted');
    const near = !!info && info.kind === 'min' && pkOpen && info.m <= 3;
    const idx = t.status === 'arrived' ? 2
      : (info && info.kind === 'now') || near ? 1
        : (t.status === 'en_route' ? 0 : -1);
    return '<ol class="stepper">' + ['في الطريق', 'اقتربت من مكانك', 'وصلت الوجهة'].map((n, i) =>
      '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' + n + '</li>').join('') + '</ol>';
  }
  function etaRowsHtml(t) {
    const pk = myPk(MB.state, t.id);
    const ends = endNames(t);
    let out = '';
    if (pk) {
      out += '<div class="trip-row"><span>مكان ركوبك</span><span class="mute" data-live="eta" data-trip="' + t.id + '">' + esc(etaText(t)) + '</span></div>';
    }
    out += '<div class="trip-row"><span>نهاية الخط · ' + esc(ends.to) + '</span><span class="mute" data-live="endeta" data-trip="' + t.id + '">' + esc(endText(t)) + '</span></div>';
    return out;
  }
  function note(text, kind, tripId, altTripId) {
    return { id: uid('n'), ts: now(), text, read: false, kind: kind || 'info', tripId: tripId || null, altTripId: altTripId || null };
  }
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(() => toast('تم نسخ رابط التتبع المباشر للأهل'));
    } else {
      toast('تم تجهيز رابط التتبع المباشر');
    }
  }

  function chatMsgs(s, tid) { return s.chat.filter((c) => c.tripId === tid).sort((a, b) => a.ts - b.ts); }
  function unreadChat(s) {
    const since = s.me.chatReadTs || 0;
    return s.chat.filter((c) => c.from === 'driver' && c.ts > since).length;
  }

  function seedChat(s) {
    const t = pickActive(s);
    if (!t || s.chat.some((c) => c.tripId === t.id)) return;
    const who = firstName(s.me.name) || 'أحمد';
    const n = now();
    [
      ['driver', 'أهلاً يا ' + who + '، أنا الكابتن ' + drvFirst(t) + '. الحافلة في المسار وموعدنا مضبوط.', n - 14 * 60000],
      ['student', 'تمام يا كابتن، أنا منتظر في مكاني على المسار.', n - 11 * 60000],
      ['driver', 'تمام، لما تضغط Ready وتحدد مكانك هشوفه على الخريطة.', n - 8 * 60000],
    ].forEach(([from, text, ts]) => s.chat.push({ id: uid('c'), tripId: t.id, from, text, ts }));
  }

  function ensure(s) {
    s.me = s.me || {};
    s.me.seen = s.me.seen || {};
    s.me.approachDone = s.me.approachDone || {};
    if (s.me.chatSeenTs == null) s.me.chatSeenTs = now();
    if (s.me.chatReadTs == null) s.me.chatReadTs = now();
    ['myBookings', 'waitlistMine', 'sharedLinks', 'notifications', 'reports', 'ratings', 'chat', 'pickups'].forEach((k) => {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    seedChat(s);
  }

  function book(s, t, msg) {
    t.booked += 1;
    const b = { id: uid('k'), tripId: t.id, seat: t.booked, status: 'confirmed' };
    s.myBookings.push(b);
    s.notifications.unshift(note(msg || ('تم تأكيد حجزك في ' + label(t) + ' · مقعد رقم ' + b.seat), 'booking', t.id));
    return b;
  }

  function freeSeat(s, t) {
    t.booked = Math.max(0, t.booked - 1);
    const w = s.waitlistMine.find((x) => x.tripId === t.id && x.status === 'waiting');
    if (w && t.booked < t.capacity) {
      w.status = 'promoted';
      t.waitlist = Math.max(0, t.waitlist - 1);
      const seat = t.booked + 1;
      book(s, t, 'تمت ترقيتك تلقائياً من قائمة الانتظار! مقعدك رقم ' + seat + ' في ' + label(t));
      return true;
    }
    if (t.waitlist > 0 && t.booked < t.capacity) { t.waitlist -= 1; t.booked += 1; }
    return false;
  }

  function nextTripFor(s, t) {
    const free = s.trips
      .filter((x) => x.id !== t.id && (x.status === 'scheduled' || x.status === 'at_start') && seatsLeft(x) > 0 && !bookingFor(s, x.id))
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    const same = free.filter((x) => x.routeId === t.routeId && x.direction === t.direction);
    return same[0] || free[0] || null;
  }

  // ---------- Actions ----------
  function bookAction(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t || (t.status !== 'scheduled' && t.status !== 'at_start')) return toast('الحجز غير متاح لهذه الرحلة حالياً');
    if (bookingFor(s, tid)) return toast('لديك حجز مؤكد في هذه الرحلة بالفعل');
    if (seatsLeft(t) <= 0) return toast('الرحلة مكتملة، يمكنك الانضمام لقائمة الانتظار');
    MB.update((st) => { book(st, st.trips.find((x) => x.id === tid)); });
    toast('تم تأكيد حجز المقعد بنجاح');
  }

  function joinWaitlist(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t) return;
    if (s.waitlistMine.some((w) => w.tripId === tid && w.status === 'waiting')) return toast('أنت مسجل في قائمة الانتظار بالفعل');
    MB.update((st) => {
      const tr = st.trips.find((x) => x.id === tid);
      tr.waitlist += 1;
      st.waitlistMine.push({ id: uid('w'), tripId: tid, ts: now(), status: 'waiting' });
      st.notifications.unshift(note('تمت إضافتك لقائمة الانتظار في ' + label(tr) + '. ستتم ترقيتك تلقائياً فور توفر مقعد.', 'waitlist', tid));
    });
    toast('تم الانضمام لقائمة الانتظار');
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
    toast('تم الخروج من قائمة الانتظار');
  }

  function simulateFreedSeat(tid) {
    let promoted = false;
    const t0 = trip(tid);
    if (!t0 || t0.booked <= 0) return;
    MB.update((st) => { promoted = freeSeat(st, st.trips.find((x) => x.id === tid)); });
    toast(promoted ? 'شغر مقعد وتمت ترقيتك تلقائياً وتأكيد حجزك!' : 'تمت محاكاة شغور مقعد');
  }

  function cancelBooking(id) {
    MB.update((st) => {
      const bb = st.myBookings.find((x) => x.id === id);
      if (!bb) return;
      const tt = st.trips.find((x) => x.id === bb.tripId);
      bb.status = 'cancelled';
      if (tt) freeSeat(st, tt);
      if (tt) st.notifications.unshift(note('تم إلغاء حجزك في ' + label(tt), 'booking', tt.id));
    });
    toast('تم إلغاء الحجز');
  }

  // Ready: send my pickup point (snapped onto the path by MB.requestPickup). Returns false if the bus already passed it.
  function submitPickup(tid, lat, lng) {
    const t = trip(tid);
    if (!t) return true;
    const pos = MB.position(t);
    const sn = MB.snap(t, lat, lng);
    if (pos && sn.progress < pos.progress - 0.005) {
      toast('الباص عدّى المكان ده — اختار مكان قدّام الباص');
      return false;
    }
    MB.requestPickup(tid, lat, lng);
    draft.pickMode = null;
    draft.locating = null;
    toast('تم إرسال مكانك للسائق');
    return true;
  }

  function readyTap(tid) {
    const s = MB.state;
    const t = trip(tid);
    if (!t || !bookingFor(s, tid) || (t.status !== 'at_start' && t.status !== 'en_route')) {
      return toast('زر الجاهزية متاح لما تكون رحلتك المحجوزة جاهزة أو في الطريق');
    }
    if (!navigator.geolocation) {
      draft.pickMode = tid;
      return render();
    }
    draft.locating = tid;
    render();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        draft.locating = null;
        if (!submitPickup(tid, p.coords.latitude, p.coords.longitude)) draft.pickMode = tid;
        render();
      },
      () => {
        draft.locating = null;
        draft.pickMode = tid;
        toast('تعذر تحديد موقعك — اضغط على الخريطة');
        render();
      },
      { timeout: 4000, maximumAge: 30000, enableHighAccuracy: false }
    );
  }

  function readyDemo(tid) {
    const t = trip(tid);
    if (!t) return;
    const pos = MB.position(t);
    const p0 = pos ? pos.progress : 0;
    const target = Math.min(0.98, p0 + 0.12);
    const poly = MB.polyOf(t);
    const pt = poly[Math.round(target * (poly.length - 1))];
    if (submitPickup(tid, pt[0], pt[1])) render();
    else { draft.pickMode = null; render(); }
  }

  function pickOnMap(tid, lat, lng) {
    if (submitPickup(tid, lat, lng)) render();
  }

  function cancelPickup(id) {
    MB.cancelPickup(id);
    toast('تم إلغاء تسجيل الجاهزية');
  }

  function shareTrip(tid) {
    const link = trackUrl(tid);
    MB.update((st) => st.sharedLinks.push({ id: uid('L'), tripId: tid, url: link, ts: now(), by: st.me.name }));
    copyText(link);
  }

  function sendChat(tid, text) {
    const raw = text == null ? (draft.chat[tid] || '') : text;
    const txt = String(raw).trim();
    if (!txt || !trip(tid)) return;
    MB.update((st) => st.chat.push({ id: uid('c'), tripId: tid, from: 'student', text: txt.slice(0, 300), ts: now() }));
    draft.chat[tid] = '';
    const input = document.getElementById('chatInput');
    if (input) input.value = '';
  }

  function sendRating(tid) {
    const stars = draft.rate[tid] || 5;
    const t = trip(tid);
    if (!t) return;
    MB.update((st) => st.ratings.push({ tripId: tid, driverId: t.driverId, stars, by: st.me.name, ts: now() }));
    delete draft.rate[tid];
    toast('شكراً لك! تم حفظ تقييم الرحلة والسائق');
  }

  function sendReport() {
    const d = draft.report;
    const txt = (d.text || '').trim();
    if (txt.length < 4) return toast('يرجى كتابة تفاصيل المشكلة باختصار');
    MB.update((st) => st.reports.unshift({
      id: uid('p'), ts: now(), studentName: st.me.name, category: d.cat,
      text: txt.slice(0, 500), status: 'open', assignee: '', tripId: d.trip || null,
    }));
    d.text = '';
    toast('تم إرسال البلاغ للإدارة بنجاح');
  }

  // Notify once when the bus is 2 minutes or less from my pickup
  function checkApproach() {
    const s = MB.state;
    if (!s) return;
    let hit = null;
    s.trips.forEach((t) => {
      if (hit || t.status !== 'en_route') return;
      const pk = myPk(s, t.id);
      if (!pk || (pk.status !== 'waiting' && pk.status !== 'accepted')) return;
      if (s.me.approachDone[pk.id]) return;
      const m = MB.etaToPickup(t, pk);
      if (m !== null && m <= 2) hit = { tid: t.id, pid: pk.id };
    });
    if (hit) {
      MB.update((st) => {
        st.me.approachDone[hit.pid] = true;
        st.notifications.unshift(note('الحافلة اقتربت منك', 'bus', hit.tid));
      });
    }
  }

  // ---------- Views ----------
  function readyBoxHtml(s, t) {
    const pk = myPk(s, t.id);
    const eligible = !!bookingFor(s, t.id) && (t.status === 'at_start' || t.status === 'en_route');
    let body;
    if (pk && (pk.status === 'waiting' || pk.status === 'accepted')) {
      body = '<div class="row"><span class="grow">' + pkChip(pk) + '</span>' +
        '<button class="btn sec sm" type="button" data-act="pk-cancel" data-id="' + pk.id + '">إلغاء</button></div>';
    } else if (pk && (pk.status === 'boarding' || pk.status === 'boarded')) {
      body = '<div class="row"><span class="grow">' + pkChip(pk) + '</span></div>';
    } else if (draft.locating === t.id) {
      body = '<p class="mute" style="margin:0">جاري تحديد موقعك…</p>';
    } else if (draft.pickMode === t.id) {
      body = '<p style="margin:0 0 8px;font-weight:700">اضغط على الخريطة لتحديد مكانك</p>' +
        '<div class="row"><button class="btn sec sm" type="button" data-act="ready-demo" data-trip="' + t.id + '">استخدم موقع تجريبي</button>' +
        '<button class="btn sec sm" type="button" data-act="pick-cancel" data-trip="' + t.id + '">إلغاء</button></div>';
    } else {
      body = (pk ? '<div class="row" style="margin-bottom:8px"><span class="grow">' + pkChip(pk) + '</span></div>' : '') +
        (eligible
          ? '<div class="row"><span class="grow mute" style="font-size:13px">اضغط عشان السواق يعرف مكانك ويقف لك.</span>' +
            '<button class="btn" type="button" data-act="ready" data-trip="' + t.id + '">أنا جاهز (Ready)</button></div>'
          : '<p class="mute" style="margin:0">زر Ready بيظهر لما رحلتك المحجوزة تكون جاهزة للانطلاق أو في الطريق.</p>');
    }
    return '<div class="ready-box"><h4>زر الجاهزية (Ready) — إشعار السائق بمكانك</h4>' + body + '</div>';
  }

  function renderHomeView(s) {
    const t = pickActive(s);
    if (!t) {
      return '<div class="card"><h3>لا توجد رحلات حالياً</h3><a class="btn" href="#book">احجز رحلة الآن</a></div>';
    }
    const drv = MB.drv[t.driverId] || { name: '—', rating: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const pk = myPk(s, t.id);
    const pkLive = !!pk && (pk.status === 'waiting' || pk.status === 'accepted' || pk.status === 'boarding');
    const ends = endNames(t);
    const lastLink = s.sharedLinks.filter((l) => l.tripId === t.id).pop();
    const altTrip = nextTripFor(s, t);
    const altTitle = pk && pk.status === 'passed' ? 'الباص عدّى مكانك — بديل فوري متاح'
      : pk && pk.status === 'skipped' ? 'السواق مش هيقدر يقف — أقرب رحلة متاحة'
        : 'فاتك الموعد؟ بديل فوري متاح';

    const tripSelectorOpts = s.trips.filter((x) => x.status !== 'cancelled').slice(0, 12).map((x) =>
      '<option value="' + x.id + '"' + (x.id === t.id ? ' selected' : '') + '>' + esc(label(x)) + ' (' + esc(MB.statusLabel[x.status]) + ')</option>'
    ).join('');

    return '<div class="home-grid">' +
      /* Right Column: Active Trip Details & Actions */
      '<div>' +
        '<section class="card">' +
          '<div class="tc-top">' +
            '<span class="avatar">' + esc(drvInitial(t)) + '</span>' +
            '<div class="grow">' +
              '<div class="mute">' + esc(label(t)) + '</div>' +
              '<div class="mute" style="font-size:12.5px">' + esc(routeLine(t)) + '</div>' +
              '<b class="tc-driver">' + esc(drv.name) + '</b>' +
              '<div class="meta"><span class="plate">حافلة: ' + esc(bus.plate) + '</span><span class="rating">★ ' + esc(drv.rating) + '</span></div>' +
            '</div>' +
            statusBadge(t) +
          '</div>' +

          '<div class="eta-panel">' +
            '<div class="eta-cell">' +
              '<span class="mute">' + (pkLive ? 'الوصول لمكانك للركوب' : 'الوقت المتبقي للرحلة') + '</span>' +
              '<div class="eta-big" data-live="etabig" data-trip="' + t.id + '">' + etaBigHtml(t) + '</div>' +
            '</div>' +
            '<div class="eta-cell">' +
              '<span class="mute">الوصول لنهاية الخط (' + esc(ends.to) + ')</span>' +
              '<div class="eta-big" style="color:var(--ink)" data-live="endeta" data-trip="' + t.id + '">' + esc(endText(t)) + '</div>' +
            '</div>' +
          '</div>' +

          '<div data-live="stepper" data-trip="' + t.id + '">' + stepperHtml(t) + '</div>' +

          readyBoxHtml(s, t) +

          /* Quick Actions Grid */
          '<div class="actions-grid">' +
            '<button class="act-btn" type="button" data-act="share" data-trip="' + t.id + '">مشاركة التتبع مع الأهل</button>' +
            '<a class="act-btn" href="#chat">مراسلة السائق بالشات</a>' +
            '<a class="act-btn" href="#book">حجز أو تعديل موعد</a>' +
          '</div>' +

          (lastLink
            ? '<div class="link-row">' +
                '<input readonly value="' + esc(lastLink.url) + '" aria-label="رابط مشاركة الرحلة">' +
                '<button class="btn sec sm" type="button" data-act="copy" data-link="' + esc(lastLink.url) + '">نسخ الرابط</button>' +
                '<a class="btn sm" href="#track=' + encodeURIComponent(t.id) + '">معاينة صفحة الأهل</a>' +
              '</div>'
            : '') +
        '</section>' +

        /* 1.4 Missed Trip / Instant Alternative Card */
        (altTrip
          ? '<section class="card">' +
              '<div class="row">' +
                '<div class="grow">' +
                  '<h3 style="margin:0 0 2px">' + esc(altTitle) + '</h3>' +
                  '<div class="mute">أقرب رحلة قادمة: <b>' + esc(label(altTrip)) + '</b> · متبقي ' + seatsLeft(altTrip) + ' مقعد</div>' +
                '</div>' +
                '<button class="btn sm" type="button" data-act="book" data-trip="' + altTrip.id + '">حجز البديل فوراً</button>' +
              '</div>' +
            '</section>'
          : '') +
      '</div>' +

      /* Left Column: Live Map & ETAs */
      '<div>' +
        '<section class="card map-card">' +
          '<div class="map-head">' +
            '<h3 style="margin:0">الخريطة الحية ومسار الحافلة</h3>' +
            '<select data-field="map-trip" aria-label="اختر الرحلة المعروضة">' + tripSelectorOpts + '</select>' +
          '</div>' +
          '<div id="mapBox" class="map-box"></div>' +
        '</section>' +

        '<section class="card">' +
          '<h3>وقت الوصول المتوقع</h3>' +
          etaRowsHtml(t) +
        '</section>' +
      '</div>' +
    '</div>';
  }

  function bookView(s) {
    const rid = draft.route;
    const route = MB.R[rid];
    const trips = s.trips.filter((t) => t.routeId === rid && t.status !== 'cancelled').sort((a, b) => a.scheduledAt - b.scheduledAt);
    const tabs = MB.routes.map((x) =>
      '<button class="btn ' + (x.id === rid ? '' : 'sec') + '" type="button" data-act="route" data-route="' + x.id + '">' + esc(x.name) + '</button>'
    ).join(' ');

    function tripRowHtml(t) {
      const mine = bookingFor(s, t.id);
      const waiting = s.waitlistMine.some((w) => w.tripId === t.id && w.status === 'waiting');
      let action;
      if (mine) action = '<span class="badge ok">محجوز · مقعد ' + mine.seat + '</span>';
      else if (t.status !== 'scheduled' && t.status !== 'at_start') action = statusBadge(t);
      else if (seatsLeft(t) > 0) action = '<button class="btn sm" type="button" data-act="book" data-trip="' + t.id + '">احجز مقعد</button>';
      else if (waiting) action = '<span class="badge warn">في قائمة الانتظار</span>';
      else action = '<button class="btn sec sm" type="button" data-act="waitlist" data-trip="' + t.id + '">انضم للانتظار</button>';

      return '<div class="trip-row">' +
        '<div class="grow"><b>الساعة ' + esc(t.time) + '</b> · ' + statusBadge(t) + '<div class="meta">' + seatPill(t) + ' · حافلة ' + esc(MB.bus[t.busId].plate) + '</div></div>' +
        action +
      '</div>';
    }

    const myRows = s.myBookings.filter((b) => b.status === 'confirmed').map((b) => {
      const t = trip(b.tripId);
      if (!t) return '';
      return '<div class="trip-row">' +
        '<div class="grow"><b>' + esc(label(t)) + '</b><div class="mute">مقعد رقم ' + b.seat + ' · ' + esc(BOOK_STATUS[b.status] || b.status) + '</div></div>' +
        '<button class="btn sec sm" type="button" data-act="cancel-booking" data-id="' + b.id + '">إلغاء الحجز</button>' +
      '</div>';
    }).join('');

    const waitRows = s.waitlistMine.filter((x) => x.status === 'waiting').map((x, idx) => {
      const t = trip(x.tripId);
      if (!t) return '';
      return '<div class="trip-row">' +
        '<div class="grow"><b>' + esc(label(t)) + '</b><div class="mute">ترتيبك في الانتظار: ' + (idx + 1) + ' — ستتم ترقيتك تلقائياً فور شغور مقعد</div></div>' +
        '<div class="row">' +
          '<button class="btn sm" type="button" data-act="sim-free" data-trip="' + t.id + '">محاكاة: شغور مقعد وترقية تلقائية</button>' +
          '<button class="btn sec sm" type="button" data-act="leave-wait" data-id="' + x.id + '">خروج</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="card">' +
        '<div class="row" style="justify-content:space-between">' +
          '<div><h2 style="margin:0 0 4px">حجز المقاعد وقائمة الانتظار</h2><div class="mute">' + esc('من ' + route.fromName + ' → إلى ' + route.toName) + '</div></div>' +
          '<div class="row">' + tabs + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<section class="card"><h3>رحلات الذهاب للجامعة</h3>' + (trips.filter((t) => t.direction === 'go').map(tripRowHtml).join('') || '<p class="mute">لا توجد رحلات ذهاب</p>') + '</section>' +
        '<section class="card"><h3>رحلات العودة</h3>' + (trips.filter((t) => t.direction === 'back').map(tripRowHtml).join('') || '<p class="mute">لا توجد رحلات عودة</p>') + '</section>' +
      '</div>' +
      '<div class="grid g2">' +
        '<section class="card"><h3>حجوزاتي المؤكدة</h3>' + (myRows || '<p class="mute">لا توجد حجوزات مؤكدة حالياً.</p>') + '</section>' +
        '<section class="card"><h3>قائمة الانتظار الذكية</h3>' + (waitRows || '<p class="mute">لست في قائمة انتظار حالياً. عند اكتمال أي رحلة يمكنك الانضمام لقائمة الانتظار هنا.</p>') + '</section>' +
      '</div>';
  }

  function chatView(s) {
    const t = pickActive(s);
    if (!t) return '<div class="card"><h3>لا توجد رحلة نشطة للمحادثة</h3></div>';
    const drv = MB.drv[t.driverId] || { name: '—', rating: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const msgs = chatMsgs(s, t.id);

    return '<div class="chat-card-wrap">' +
      '<section class="card">' +
        '<div class="chat-head">' +
          '<span class="avatar">' + esc(drvInitial(t)) + '</span>' +
          '<div class="grow">' +
            '<b>' + esc(drv.name) + '</b>' +
            '<div class="meta"><span>' + esc(label(t)) + '</span> · <span class="plate">' + esc(bus.plate) + '</span> · <span class="rating">★ ' + esc(drv.rating) + '</span></div>' +
          '</div>' +
          statusBadge(t) +
        '</div>' +
        '<div class="chat-list" id="chatList">' +
          (msgs.length
            ? msgs.map((c) => '<div class="bub-row ' + (c.from === 'student' ? 'me' : 'drv') + '"><div class="bub">' + esc(c.text) + '</div><div class="bub-ts">' + (c.from === 'student' ? 'أنت · ' : 'السائق · ') + esc(MB.fmtTime(c.ts)) + '</div></div>').join('')
            : '<div class="mute" style="margin:auto;text-align:center">ابدأ المحادثة مع السائق أو اختر رداً سريعاً بالأسفل.</div>') +
        '</div>' +
        '<div class="chips">' +
          QUICK_REPLIES.map((q) => '<button class="chip" type="button" data-act="chip" data-trip="' + t.id + '" data-text="' + esc(q) + '">' + esc(q) + '</button>').join('') +
        '</div>' +
        '<div class="chat-input-row">' +
          '<input id="chatInput" data-field="chat-text" data-trip="' + t.id + '" value="' + esc(draft.chat[t.id] || '') + '" placeholder="اكتب رسالة للسائق بدون الحاجة للاتصال الهاتفي..." autocomplete="off">' +
          '<button class="btn" type="button" data-act="chat-send" data-trip="' + t.id + '">إرسال</button>' +
        '</div>' +
      '</section>' +
    '</div>';
  }

  function alertsView(s) {
    const t = pickActive(s);
    const curStars = (t && draft.rate[t.id]) || 5;
    const d = draft.report;
    const list = s.notifications.slice(0, 20);
    const rules = ((s.policies && s.policies.rules) || []).map((r) =>
      /محط/.test(r) ? 'الباص بيمشي في مساره المحدد باستمرار.' : r
    );

    const notifHtml = list.map((n) => {
      const alt = n.altTripId ? trip(n.altTripId) : null;
      const altBtn = alt && seatsLeft(alt) > 0 && !bookingFor(s, alt.id)
        ? '<button class="btn sm" style="margin-top:6px" type="button" data-act="book" data-trip="' + alt.id + '">احجز البديل (' + esc(alt.time) + ')</button>'
        : '';
      return '<div class="trip-row" style="align-items:flex-start;flex-direction:column">' +
        '<div class="row" style="width:100%"><span class="badge ' + (KIND_CLS[n.kind] || '') + '">' + esc(KIND_LABEL[n.kind] || 'إشعار') + '</span><span class="mute" style="margin-right:auto">' + MB.fmtTime(n.ts) + '</span></div>' +
        '<div style="font-size:14px">' + esc(n.text) + '</div>' +
        altBtn +
      '</div>';
    }).join('');

    return '<div class="grid g2">' +
      /* Right Column: Targeted Notifications + Policies */
      '<div>' +
        '<section class="card">' +
          '<div class="row" style="justify-content:space-between;margin-bottom:8px">' +
            '<h3 style="margin:0">إشعاراتك الموجهة</h3>' +
            '<button class="btn sec sm" type="button" data-act="notif-read">تحديد الكل كمقروء</button>' +
          '</div>' +
          (notifHtml || '<p class="mute">لا توجد إشعارات جديدة.</p>') +
        '</section>' +

        '<section class="card">' +
          '<h3>سياسات ومواعيد الركوب المثبتة</h3>' +
          '<p class="mute" style="margin:0 0 8px">آخر موعد لرحلات العودة اليومية: <b>' + esc(s.policies ? s.policies.lastReturn : '19:30') + '</b></p>' +
          '<ul style="margin:0;padding-right:18px;font-size:14px">' +
            rules.map((r) => '<li style="margin-bottom:4px">' + esc(r) + '</li>').join('') +
          '</ul>' +
        '</section>' +
      '</div>' +

      /* Left Column: Rating & Problem Report */
      '<div>' +
        (t
          ? '<section class="card">' +
              '<h3>تقييم الرحلة والسائق</h3>' +
              '<div class="mute" style="margin-bottom:8px">' + esc(label(t)) + ' · السائق: ' + esc(MB.drv[t.driverId].name) + '</div>' +
              '<div class="row" style="margin-bottom:10px">' +
                [1, 2, 3, 4, 5].map((n) =>
                  '<button class="btn ' + (n <= curStars ? '' : 'sec') + ' sm" type="button" data-act="star" data-trip="' + t.id + '" data-stars="' + n + '">' + n + ' ★</button>'
                ).join('') +
                '<button class="btn ok sm" type="button" data-act="rate-send" data-trip="' + t.id + '">حفظ التقييم</button>' +
              '</div>' +
            '</section>'
          : '') +

        '<section class="card">' +
          '<h3>إرسال بلاغ أو شكوى للإدارة</h3>' +
          '<label>تصنيف البلاغ</label>' +
          '<select data-field="report-cat">' + REPORT_CATS.map((c) => '<option' + (c === d.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
          '<label>تفاصيل المشكلة</label>' +
          '<textarea rows="3" data-field="report-text" placeholder="اكتب ملاحظتك أو المشكلة لتصل مباشرة للوحة الإدارة...">' + esc(d.text) + '</textarea>' +
          '<button class="btn" style="margin-top:10px" type="button" data-act="report-send">إرسال البلاغ للإدارة</button>' +
        '</section>' +
      '</div>' +
    '</div>';
  }

  function trackView(s, tid) {
    const t = trip(tid) || pickActive(s);
    if (!t) return '<div class="card"><h3>الرابط غير صالح</h3><a class="btn" href="#home">العودة</a></div>';
    const drv = MB.drv[t.driverId] || { name: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    return '<section class="card">' +
        '<div class="row" style="justify-content:space-between">' +
          '<div><h2 style="margin:0">متابعة الرحلة المباشرة للأهل</h2><div class="mute">' + esc(label(t)) + ' · حافلة ' + esc(bus.plate) + ' · السائق ' + esc(drv.name) + '</div>' +
          '<div class="mute" style="font-size:12.5px">' + esc(routeLine(t)) + '</div></div>' +
          '<a class="btn sec sm" href="#home">العودة لواجهة الطالب</a>' +
        '</div>' +
      '</section>' +
      '<div class="card map-card"><div id="mapBox" class="map-box" style="height:380px"></div></div>' +
      '<section class="card"><h3>وقت الوصول المتوقع</h3>' +
        etaRowsHtml(t) +
      '</section>';
  }

  // ---------- Map Mounting ----------
  function destroyMap() {
    if (mapCtl && mapCtl.map) mapCtl.map.remove();
    mapCtl = null;
  }

  function mountMap(tid) {
    const el = document.getElementById('mapBox');
    const t = trip(tid);
    if (!el || !t || !window.L) return;
    const L = window.L;
    const route = MB.R[t.routeId];
    const poly = MB.polyOf(t);
    const ends = endNames(t);
    const map = L.map(el, { scrollWheelZoom: false }).setView([28.11, 30.80], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    el.classList.toggle('picking', draft.pickMode === tid);
    const line = L.polyline(poly, { color: route.color, weight: 5, opacity: 0.9 }).addTo(map);
    // route ends only: start and finish markers
    L.marker(poly[0], {
      icon: L.divIcon({ className: '', html: '<div class="pin">من</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).bindTooltip(esc(ends.from)).addTo(map);
    L.marker(poly[poly.length - 1], {
      icon: L.divIcon({ className: '', html: '<div class="pin">إلى</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).bindTooltip(esc(ends.to)).addTo(map);
    // my pickup point (pulsing while still active)
    const pk = myPk(MB.state, t.id);
    if (pk) {
      const live = pk.status === 'waiting' || pk.status === 'accepted' || pk.status === 'boarding';
      L.marker([pk.lat, pk.lng], {
        icon: L.divIcon({ className: '', html: '<div class="pk-pin' + (live ? ' live' : '') + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 800,
      }).bindTooltip(esc(PK_LABEL[pk.status] || '')).addTo(map);
    }
    map.on('click', (e) => { if (draft.pickMode === tid) pickOnMap(tid, e.latlng.lat, e.latlng.lng); });
    map.fitBounds(line.getBounds(), { padding: [28, 28] });
    mapCtl = { tripId: tid, map, bus: null, line };
    tickMap();
    setTimeout(() => map.invalidateSize(), 50);
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
            className: 'mb-bus',
            html: '<div class="bus-pill">الحافلة</div>',
            iconSize: [64, 28],
            iconAnchor: [32, 14],
          }),
          zIndexOffset: 1000,
        }).addTo(mapCtl.map);
      } else {
        mapCtl.bus.setLatLng([pos.lat, pos.lng]);
      }
    }
  }

  function parseRoute() {
    const h = location.hash.replace(/^#/, '');
    if (h.indexOf('track=') === 0) return { view: 'track', id: decodeURIComponent(h.slice(6)) };
    if (h === 'support') return { view: 'alerts', id: '' };
    return { view: VIEWS.indexOf(h) >= 0 ? h : 'home', id: '' };
  }

  function updateBadges(s) {
    const unreadA = s.notifications.filter((n) => !n.read).length;
    const unreadC = unreadChat(s);
    document.querySelectorAll('[data-badge="alerts"]').forEach((el) => { el.textContent = unreadA; el.hidden = !unreadA; });
    document.querySelectorAll('[data-badge="chat"]').forEach((el) => { el.textContent = unreadC; el.hidden = !unreadC; });
  }

  function render() {
    const s = MB.state;
    if (!s) return;
    const r = parseRoute();
    document.body.classList.toggle('track', r.view === 'track');
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === r.view));

    destroyMap();
    if (r.view === 'home') {
      app.innerHTML = renderHomeView(s);
      const active = pickActive(s);
      if (active) mountMap(active.id);
    } else if (r.view === 'track') {
      app.innerHTML = trackView(s, r.id);
      const t = trip(r.id) || pickActive(s);
      if (t) mountMap(t.id);
    } else if (r.view === 'book') {
      app.innerHTML = bookView(s);
    } else if (r.view === 'chat') {
      app.innerHTML = chatView(s);
      const list = document.getElementById('chatList');
      if (list) list.scrollTop = list.scrollHeight;
      if (unreadChat(s) > 0) MB.update((st) => { st.me.chatReadTs = now(); });
    } else {
      app.innerHTML = alertsView(s);
    }
    updateBadges(s);
  }

  function tick() {
    checkApproach();
    if (mapCtl && mapCtl.map) tickMap();
    document.querySelectorAll('[data-live="eta"]').forEach((el) => {
      el.textContent = etaText(trip(el.dataset.trip));
    });
    document.querySelectorAll('[data-live="endeta"]').forEach((el) => {
      el.textContent = endText(trip(el.dataset.trip));
    });
    document.querySelectorAll('[data-live="etabig"]').forEach((el) => {
      const t = trip(el.dataset.trip);
      if (t) el.innerHTML = etaBigHtml(t);
    });
    document.querySelectorAll('[data-live="stepper"]').forEach((el) => {
      const t = trip(el.dataset.trip);
      if (t) el.innerHTML = stepperHtml(t);
    });
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case 'route': draft.route = d.route; render(); break;
      case 'ready': readyTap(d.trip); break;
      case 'ready-demo': readyDemo(d.trip); break;
      case 'pick-cancel': draft.pickMode = null; draft.locating = null; render(); break;
      case 'pk-cancel': cancelPickup(d.id); break;
      case 'share': shareTrip(d.trip); break;
      case 'copy': copyText(d.link); break;
      case 'chip': sendChat(d.trip, d.text); break;
      case 'chat-send': sendChat(d.trip); break;
      case 'book': bookAction(d.trip); break;
      case 'waitlist': joinWaitlist(d.trip); break;
      case 'leave-wait': leaveWaitlist(d.id); break;
      case 'sim-free': simulateFreedSeat(d.trip); break;
      case 'cancel-booking': cancelBooking(d.id); break;
      case 'star': draft.rate[d.trip] = Number(d.stars); render(); break;
      case 'rate-send': sendRating(d.trip); break;
      case 'report-send': sendReport(); break;
      case 'notif-read': MB.update((st) => st.notifications.forEach((n) => { n.read = true; })); break;
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    const f = el.dataset && el.dataset.field;
    if (!f) return;
    if (f === 'map-trip') {
      draft.mapTrip = el.value;
      render();
    } else if (f === 'report-cat') {
      draft.report.cat = el.value;
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    const f = el.dataset && el.dataset.field;
    if (f === 'report-text') draft.report.text = el.value;
    else if (f === 'chat-text') draft.chat[el.dataset.trip] = el.value;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.dataset && e.target.dataset.field === 'chat-text') {
      e.preventDefault();
      sendChat(e.target.dataset.trip);
    }
  });

  window.addEventListener('hashchange', () => {
    draft.pickMode = null;
    draft.locating = null;
    window.scrollTo(0, 0);
    render();
  });

  MB.subscribe(() => {
    if (!busy()) render();
    else pending = true;
  });
  app.addEventListener('focusout', () => {
    setTimeout(() => { if (pending && !busy()) { pending = false; render(); } }, 200);
  });

  MB.update(ensure);
  render();
  setInterval(tick, 1000);
})();
