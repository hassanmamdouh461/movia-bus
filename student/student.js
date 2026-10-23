/* Lotus Bus — Student Interface (Simplified, clean, responsive) */
(function () {
  'use strict';
  const MB = window.MB;
  if (!MB) return;
  const app = document.getElementById('app');
  const TOTAL_MIN = Math.round((MB.TRIP_MS / 60000) * 3);
  const REPORT_CATS = ['تأخير الحافلة', 'نظافة الحافلة', 'سلوك السائق', 'تجاوز مكان الركوب', 'أخرى'];
  const KIND_LABEL = { bus: 'اقتراب الحافلة', driver: 'تحديث السائق', cancel: 'إلغاء وبديل', booking: 'تأكيد حجز', info: 'إشعار' };
  const KIND_CLS = { bus: 'info', driver: 'ok', cancel: 'bad', booking: 'ok', info: '' };
  const BOOK_STATUS = { confirmed: 'مؤكد', cancelled: 'ملغي', missed: 'فاتتك الرحلة', trip_cancelled: 'ألغيت الرحلة' };
  const VIEWS = ['home', 'chat', 'alerts'];
  const QUICK_REPLIES = ['أنا منتظر في مكاني', 'كم دقيقة للوصول؟', 'تمام يا كابتن شكراً'];
  // pickup (Ready) status -> chip text / badge class
  const PK_LABEL = {
    waiting: 'في انتظار السواق', accepted: 'السواق هيقف لك', boarding: 'الباص واقف — اركب',
    boarded: 'تم الركوب', skipped: 'السواق مش هيقدر يقف — أقرب رحلة', passed: 'الباص عدّى مكانك',
  };
  const PK_CLS = { waiting: 'warn', accepted: 'ok', boarding: 'ok', boarded: 'ok', skipped: 'bad', passed: 'bad' };

  const draft = {
    route: 'r1',
    dir: 'go',          // 'go' (ذهاب) or 'back' (عودة) in the map card
    pickMode: null,     // trip id while the student is choosing a point on the map
    locating: null,     // trip id while geolocation is being requested
    chat: {},
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
  // start / end names of a trip's direction
  function endNames(t) {
    const r = MB.R[t.routeId];
    return t.direction === 'go' ? { from: r.fromName, to: r.toName } : { from: r.toName, to: r.fromName };
  }
  function routeLine(t) { const e = endNames(t); return 'من ' + e.from + ' → إلى ' + e.to; }
  function statusBadge(t) {
    // "مجدولة" / "في الطريق" badges are intentionally not shown to students
    if (t.status === 'scheduled' || t.status === 'en_route') return '';
    const cls = { scheduled: 'info', at_start: 'warn', en_route: 'ok', arrived: '', cancelled: 'bad' }[t.status] || '';
    return '<span class="badge ' + cls + '">' + esc(MB.statusLabel[t.status] || t.status) + '</span>';
  }
  function seatPill(t) {
    if (t.status !== 'scheduled' && t.status !== 'at_start' && t.status !== 'en_route') return '';
    return '<span class="pill ok">' + t.booked + ' مسجّل</span>';
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
  function isBookingMissed(s, b) {
    if (!b || b.status !== 'confirmed') return true;
    const t = trip(b.tripId);
    if (!t || t.status === 'cancelled' || t.status === 'arrived') return true;
    const pk = myPk(s, t.id);
    if (pk && (pk.status === 'passed' || pk.status === 'skipped')) return true;
    return false;
  }
  function activeGoBooking(s) {
    return s.myBookings.find((b) => {
      if (b.status !== 'confirmed') return false;
      const t = trip(b.tripId);
      return t && t.direction === 'go' && !isBookingMissed(s, b);
    }) || null;
  }
  function myTrips(s) {
    return s.myBookings.filter((b) => b.status === 'confirmed').map((b) => trip(b.tripId)).filter(Boolean)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
  }
  function pickActive(s) {
    const dir = draft.dir || 'go';
    if (draft.mapTrip) {
      const mt = trip(draft.mapTrip);
      if (mt && mt.direction === dir && mt.status !== 'cancelled') return mt;
    }
    const dirTrips = s.trips.filter((t) => t.direction === dir && t.status !== 'cancelled')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    if (dir === 'go') {
      const actB = activeGoBooking(s);
      if (actB && trip(actB.tripId)) return trip(actB.tripId);
      const anyGo = myTrips(s).find((t) => t.direction === 'go');
      if (anyGo) return anyGo;
    }
    return dirTrips.find((t) => t.status === 'en_route')
      || dirTrips.find((t) => t.status === 'at_start')
      || dirTrips.find((t) => t.status === 'scheduled')
      || dirTrips[0]
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
      if (info.kind === 'min') return (info.m <= 1 ? 1 : info.m) + ' <small>دقيقة</small>';
      if (info.kind === 'now') return 'الآن <small>اركب الآن</small>';
      if (info.kind === 'skipped') return 'مش هيقف <small>السواق معتذر</small>';
      return 'مرت <small>الحافلة عدّت مكانك</small>';
    }
    if (t.status === 'scheduled') return esc(t.time) + ' <small>موعد الانطلاق</small>';
    if (t.status === 'at_start') return 'الآن <small>في بداية الخط</small>';
    if (t.status === 'arrived') return 'وصلت <small>انتهت الرحلة</small>';
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
    ['myBookings', 'sharedLinks', 'notifications', 'reports', 'chat', 'pickups'].forEach((k) => {
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

  function releaseSeat(t) {
    t.booked = Math.max(0, t.booked - 1);
  }

  function nextTripFor(s, t) {
    const free = s.trips
      .filter((x) => x.id !== t.id && (x.status === 'scheduled' || x.status === 'at_start') && x.direction === 'go' && !bookingFor(s, x.id))
      .sort((a, b) => a.scheduledAt - b.scheduledAt);
    const same = free.filter((x) => x.routeId === t.routeId && x.direction === t.direction);
    return same[0] || free[0] || null;
  }

  // ---------- Actions ----------
  function bookAction(tid, forceReplace) {
    const s = MB.state;
    const t = trip(tid);
    if (t && t.direction === 'back') return toast('رحلات العودة من غير حجز — الباص بيتحرك في ميعاده');
    if (!t || (t.status !== 'scheduled' && t.status !== 'at_start')) return toast('التسجيل غير متاح لهذه الرحلة حالياً');
    const existingHere = bookingFor(s, tid);
    if (existingHere && !isBookingMissed(s, existingHere)) return toast('أنت مسجل في هذه الرحلة بالفعل');
    const curGo = activeGoBooking(s);
    if (curGo && curGo.tripId !== tid && !forceReplace) {
      return toast('أقصى حد لتسجيل رحلات الذهاب هو رحلة واحدة — ألغِ تسجيلك الأول لاختيار غيره');
    }
    MB.update((st) => {
      // Clear any previous confirmed 'go' bookings (either missed or being replaced)
      st.myBookings.forEach((b) => {
        if (b.status !== 'confirmed') return;
        const bt = st.trips.find((x) => x.id === b.tripId);
        if (!bt || bt.direction === 'go') {
          if (bt && (bt.status === 'scheduled' || bt.status === 'at_start' || bt.status === 'en_route')) {
            releaseSeat(bt);
          }
          st.pickups = (st.pickups || []).filter((k) => !(k.tripId === b.tripId && k.mine));
          b.status = isBookingMissed(st, b) ? 'missed' : 'cancelled';
        }
      });
      book(st, st.trips.find((x) => x.id === tid));
    });
    draft.dir = 'go';
    draft.mapTrip = tid;
    toast('تم تسجيلك في رحلة الذهاب بنجاح');
  }

  function cancelBooking(id) {
    MB.update((st) => {
      const bb = st.myBookings.find((x) => x.id === id);
      if (!bb) return;
      const tt = st.trips.find((x) => x.id === bb.tripId);
      bb.status = 'cancelled';
      st.pickups = (st.pickups || []).filter((k) => !(k.tripId === bb.tripId && k.mine));
      if (tt) releaseSeat(tt);
      if (tt) st.notifications.unshift(note('تم إلغاء تسجيلك في ' + label(tt), 'booking', tt.id));
    });
    toast('تم إلغاء تسجيلك الأول — يمكنك الآن التسجيل في أي رحلة ذهاب أخرى');
  }

  function markMissed(id) {
    MB.update((st) => {
      const bb = st.myBookings.find((x) => x.id === id);
      if (!bb) return;
      const tt = st.trips.find((x) => x.id === bb.tripId);
      bb.status = 'missed';
      st.pickups = (st.pickups || []).filter((k) => !(k.tripId === bb.tripId && k.mine));
      if (tt) releaseSeat(tt);
      if (tt) st.notifications.unshift(note('فاتك موعد ' + label(tt) + ' — يمكنك التسجيل في رحلة ذهاب أخرى الآن', 'cancel', tt.id));
    });
    toast('تم تسجيل أن الميعاد فاتك — يمكنك الآن التسجيل في أي رحلة ذهاب أخرى');
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

  function dirTripsBoxHtml(s, activeTrip) {
    const dir = draft.dir || 'go';
    const actGo = activeGoBooking(s);
    const missedEntry = !actGo && s.myBookings.slice().reverse().find((b) => {
      const bt = trip(b.tripId);
      return (!bt || bt.direction === 'go') && (b.status === 'missed' || (b.status === 'confirmed' && isBookingMissed(s, b)));
    });

    if (dir === 'back') {
      const list = s.trips
        .filter((x) => x.direction === 'back' && x.status !== 'cancelled' && x.status !== 'arrived')
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      const rows = list.map((x) => {
        const isCur = activeTrip && activeTrip.id === x.id;
        return '<div class="dir-row' + (isCur ? ' on' : '') + '">' +
          '<div class="dir-row-info" data-act="view-trip" data-trip="' + x.id + '">' +
            '<b>' + esc(MB.R[x.routeId].name) + ' — التحرك الساعة ' + esc(x.time) + '</b>' +
            '<div class="meta">' + statusBadge(x) + ' <span>من الجامعة إلى ' + esc(MB.R[x.routeId].fromName) + ' · حافلة ' + esc(MB.bus[x.busId].plate) + '</span></div>' +
          '</div>' +
          '<button class="btn ' + (isCur ? 'sm' : 'sec sm') + '" type="button" data-act="view-trip" data-trip="' + x.id + '">' +
            (isCur ? 'معروضة على الخريطة' : 'عرض على الخريطة') +
          '</button>' +
        '</div>';
      }).join('');
      return '<div class="dir-box">' +
        '<div class="dir-note">' +
          '<b>رحلات العودة من الجامعة (بدون حجز مسبق):</b> الحافلات تتحرك تلقائياً في المواعيد المحددة بالأسفل. اضغط على أي رحلة لمتابعتها على الخريطة.' +
        '</div>' +
        '<div class="dir-list">' + (rows || '<p class="mute" style="margin:0">لا توجد رحلات عودة حالياً</p>') + '</div>' +
      '</div>';
    }

    // dir === 'go' (ذهاب): my trip status on top, then the trips I can still register in
    const goTrips = s.trips
      .filter((x) => x.direction === 'go' && x.status !== 'cancelled')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    let statusHtml;
    if (actGo && trip(actGo.tripId)) {
      const curT = trip(actGo.tripId);
      statusHtml = '<div class="dir-note ok">' +
        '<div><b>✓ أنت مسجّل</b> — ' + esc(MB.R[curT.routeId].name) + ' · الساعة ' + esc(curT.time) + ' · مقعد ' + actGo.seat + '</div>' +
        '<div class="row" style="margin-top:8px">' +
          '<button class="btn sec sm" type="button" data-act="cancel-booking" data-id="' + actGo.id + '">إلغاء التسجيل</button>' +
          '<button class="btn warn sm" type="button" data-act="mark-missed" data-id="' + actGo.id + '">فاتني الميعاد</button>' +
        '</div>' +
      '</div>';
    } else if (missedEntry) {
      const mt = trip(missedEntry.tripId);
      statusHtml = '<div class="dir-note bad"><b>فاتتك الرحلة</b>' + (mt ? ' — ' + esc(MB.R[mt.routeId].name) + ' · الساعة ' + esc(mt.time) : '') + '</div>';
    } else {
      statusHtml = '<div class="dir-note"><b>مش مسجّل في أي رحلة ذهاب</b></div>';
    }

    const open = goTrips.filter((x) => (x.status === 'scheduled' || x.status === 'at_start') && !(actGo && actGo.tripId === x.id));
    const rows = open.map((x) => {
      const act = '<button class="btn ' + (actGo ? 'sec ' : '') + 'sm" type="button" data-act="book" data-trip="' + x.id + '">سجّل</button>';
      const isCur = activeTrip && activeTrip.id === x.id;
      return '<div class="dir-row' + (isCur ? ' on' : '') + '">' +
        '<div class="dir-row-info" data-act="view-trip" data-trip="' + x.id + '">' +
          '<b>' + esc(MB.R[x.routeId].name) + ' — ' + esc(x.time) + '</b>' +
          '<div class="meta">' + x.booked + ' مسجّل</div>' +
        '</div>' +
        '<div class="dir-row-acts">' + act + '</div>' +
      '</div>';
    }).join('');

    return '<div class="dir-box">' +
      statusHtml +
      '<h4 class="dir-sub">رحلات متاحة للتسجيل</h4>' +
      '<div class="dir-list">' + (rows || '<p class="mute" style="margin:0">لا توجد رحلات متاحة للتسجيل الآن</p>') + '</div>' +
    '</div>';
  }

  function renderHomeView(s) {
    const t = pickActive(s);
    if (!t) {
      return '<div class="card"><h3>لا توجد رحلات حالياً</h3></div>';
    }
    const dir = draft.dir || 'go';
    const drv = MB.drv[t.driverId] || { name: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const pk = myPk(s, t.id);
    const pkLive = !!pk && (pk.status === 'waiting' || pk.status === 'accepted' || pk.status === 'boarding');
    const ends = endNames(t);
    const lastLink = s.sharedLinks.filter((l) => l.tripId === t.id).pop();
    const altTrip = nextTripFor(s, t);
    const altTitle = pk && pk.status === 'passed' ? 'الباص عدّى مكانك — بديل فوري متاح'
      : pk && pk.status === 'skipped' ? 'السواق مش هيقدر يقف — أقرب رحلة متاحة'
        : 'فاتك الموعد؟ بديل فوري متاح';

    return '<div class="home-grid">' +
      /* Primary Column: Live Map at the Top & ETAs */
      '<div class="home-col">' +
        '<section class="card map-card m-order-1">' +
          '<div class="map-head">' +
            '<h3 style="margin:0">الخريطة الحية ومسار الحافلة</h3>' +
            '<div class="dir-switch" role="tablist" aria-label="اتجاه الرحلات">' +
              '<button type="button" class="dir-btn' + (dir === 'go' ? ' on' : '') + '" data-act="map-dir" data-dir="go">ذهاب</button>' +
              '<button type="button" class="dir-btn' + (dir === 'back' ? ' on' : '') + '" data-act="map-dir" data-dir="back">عودة</button>' +
            '</div>' +
          '</div>' +
          dirTripsBoxHtml(s, t) +
          '<div id="mapBox" class="map-box"></div>' +
        '</section>' +

        '<section class="card m-order-4">' +
          '<h3>وقت الوصول المتوقع</h3>' +
          etaRowsHtml(t) +
        '</section>' +
      '</div>' +

      /* Secondary Column: Active Trip Details & Actions */
      '<div class="home-col">' +
        '<section class="card m-order-2">' +
          '<div class="tc-top">' +
            '<span class="avatar">' + esc(drvInitial(t)) + '</span>' +
            '<div class="grow">' +
              '<div class="mute">' + esc(label(t)) + '</div>' +
              '<div class="mute" style="font-size:12.5px">' + esc(routeLine(t)) + '</div>' +
              '<b class="tc-driver">' + esc(drv.name) + '</b>' +
              '<div class="meta"><span class="plate">حافلة: ' + esc(bus.plate) + '</span></div>' +
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
          ? '<section class="card m-order-3">' +
              '<div class="row">' +
                '<div class="grow">' +
                  '<h3 style="margin:0 0 2px">' + esc(altTitle) + '</h3>' +
                  '<div class="mute">أقرب رحلة قادمة: <b>' + esc(label(altTrip)) + '</b> · ' + altTrip.booked + ' مسجّل</div>' +
                '</div>' +
                '<button class="btn sm" type="button" data-act="book-alt" data-trip="' + altTrip.id + '">حجز البديل فوراً</button>' +
              '</div>' +
            '</section>'
          : '') +
      '</div>' +
    '</div>';
  }

  function chatView(s) {
    const t = pickActive(s);
    if (!t) return '<div class="card"><h3>لا توجد رحلة نشطة للمحادثة</h3></div>';
    const drv = MB.drv[t.driverId] || { name: '—' };
    const bus = MB.bus[t.busId] || { plate: '—' };
    const msgs = chatMsgs(s, t.id);

    return '<div class="chat-card-wrap">' +
      '<section class="card">' +
        '<div class="chat-head">' +
          '<span class="avatar">' + esc(drvInitial(t)) + '</span>' +
          '<div class="grow">' +
            '<b>' + esc(drv.name) + '</b>' +
            '<div class="meta"><span>' + esc(label(t)) + '</span> · <span class="plate">' + esc(bus.plate) + '</span></div>' +
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
    const d = draft.report;
    const list = s.notifications.slice(0, 20);
    const rules = ((s.policies && s.policies.rules) || []).map((r) =>
      /محط/.test(r) ? 'الباص بيمشي في مساره المحدد باستمرار.' : r
    );

    const notifHtml = list.map((n) => {
      const alt = n.altTripId ? trip(n.altTripId) : null;
      const altBtn = alt && !bookingFor(s, alt.id)
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

      /* Left Column: Problem Report */
      '<div>' +
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
      case 'map-dir': draft.dir = d.dir === 'back' ? 'back' : 'go'; draft.mapTrip = null; render(); break;
      case 'view-trip': draft.mapTrip = d.trip; render(); break;
      case 'ready': readyTap(d.trip); break;
      case 'ready-demo': readyDemo(d.trip); break;
      case 'pick-cancel': draft.pickMode = null; draft.locating = null; render(); break;
      case 'pk-cancel': cancelPickup(d.id); break;
      case 'share': shareTrip(d.trip); break;
      case 'copy': copyText(d.link); break;
      case 'chip': sendChat(d.trip, d.text); break;
      case 'chat-send': sendChat(d.trip); break;
      case 'book': bookAction(d.trip, false); break;
      case 'book-alt': bookAction(d.trip, true); break;
      case 'cancel-booking': cancelBooking(d.id); break;
      case 'mark-missed': markMissed(d.id); break;
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

  window.addEventListener('resize', () => {
    if (mapCtl && mapCtl.map) mapCtl.map.invalidateSize();
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
