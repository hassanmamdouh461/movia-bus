/* Lotus Bus - admin (إدارة) interface. Depends on ../shared/core.js (window.MB). */
(function () {
  'use strict';
  const MB = window.MB;

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const todayKey = () => dayKey(Date.now());
  const at = (day, hm) => new Date(day + 'T' + hm + ':00').getTime();
  const hhmm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const hhmmss = (ts) => { const d = new Date(ts); return hhmm(ts) + ':' + pad(d.getSeconds()); };
  const dirLabel = (d) => (d === 'go' ? 'ذهاب' : 'عودة');
  const lineLabel = (r) => (r && r.fromName && r.toName ? r.fromName + ' → ' + r.toName : r ? r.name : '—');
  const routeName = (id) => lineLabel(MB.R[id]);
  // defensive: old saved state may lack pickups; never throw
  const pkOf = (tripId, active) => { try { return MB.pickupsOf(tripId, active) || []; } catch (e) { return []; } };
  const drvName = (id) => (MB.drv[id] ? MB.drv[id].name : '—');
  const plateOf = (id) => (MB.bus[id] ? MB.bus[id].plate : '—');
  const busNo = (t) => (MB.bus[t.busId] ? MB.bus[t.busId].plate.split(' ').pop() : '—');
  const titleOf = (t) => routeName(t.routeId) + ' · ' + dirLabel(t.direction) + ' · ' + t.time;
  const dayTrips = (day) => MB.state.trips.filter((t) => dayKey(t.scheduledAt) === day).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const tripsToday = () => dayTrips(todayKey());
  const fillPct = (t) => (t.capacity ? Math.round((t.booked / t.capacity) * 100) : 0);
  const canChange = (t) => t.status === 'scheduled' || t.status === 'at_start';
  const STATUS_CLS = { scheduled: 'info', at_start: 'warn', en_route: 'ok', arrived: '', cancelled: 'bad' };
  const badgeStatus = (t) => '<span class="badge ' + (STATUS_CLS[t.status] || '') + '">' + esc(MB.statusLabel[t.status] || t.status) + '</span>' + (t.published === false ? ' <span class="badge warn">مسودة</span>' : '');
  const kpi = (label, value) => '<div class="card"><div class="mute">' + esc(label) + '</div><div class="kpi">' + esc(value) + '</div></div>';
  const empty = (msg) => '<p class="mute">' + esc(msg) + '</p>';
  const head = (title, extra) => '<div class="row head"><h2 class="grow">' + esc(title) + '</h2>' + (extra || '') + '</div>';
  const table = (heads, rowsHtml) => '<div class="tbl"><table><thead><tr>' + heads.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';

  function toast(msg, bad) {
    document.querySelectorAll('.adm-toast').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'toast adm-toast';
    if (bad) el.style.background = 'var(--bad)';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  // Generic modal form. onSubmit(data) returns an error string, or '' / undefined on success.
  function openModal(title, bodyHtml, onSubmit, submitLabel) {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = '<form class="card" novalidate><h2>' + esc(title) + '</h2>' + bodyHtml +
      '<p class="err" style="color:var(--bad);min-height:1.5em;margin:8px 0 0"></p>' +
      '<div class="row" style="justify-content:flex-end"><button type="button" class="btn sec" data-close>إلغاء</button><button class="btn" type="submit">' + esc(submitLabel || 'حفظ') + '</button></div></form>';
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) close(); });
    const form = wrap.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const err = onSubmit(data);
      if (err) wrap.querySelector('.err').textContent = err;
      else close();
    });
    document.body.appendChild(wrap);
    const first = form.querySelector('input,select');
    if (first) first.focus();
    return close;
  }

  // ---------- trip operations ----------
  let draft = null;        // publish working copy (in memory only, nothing live until confirm)
  let tripDay = todayKey();
  let cmpCat = 'all';
  let polDraft = null;
  let lastScan = null;
  let cur = 'monitor';

  // nearest alternative: same line & direction first, then same line, then any line; same day, published, not started
  function findAlt(t) {
    const day = dayKey(t.scheduledAt);
    const rank = (x) => (x.routeId === t.routeId && x.direction === t.direction ? 0 : x.routeId === t.routeId ? 1 : 2);
    return MB.state.trips
      .filter((x) => x.id !== t.id && x.published !== false && (x.status === 'scheduled' || x.status === 'at_start') && dayKey(x.scheduledAt) === day)
      .sort((a, b) => rank(a) - rank(b) || Math.abs(a.scheduledAt - t.scheduledAt) - Math.abs(b.scheduledAt - t.scheduledAt))[0] || null;
  }

  function nextTripOf(t) {
    const day = dayKey(t.scheduledAt);
    return MB.state.trips
      .filter((x) => x.id !== t.id && x.routeId === t.routeId && x.direction === t.direction && x.status === 'scheduled' && x.scheduledAt > t.scheduledAt && dayKey(x.scheduledAt) === day)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)[0] || null;
  }

  // removes an unpublished draft outright, otherwise marks the trip cancelled
  function retireTrip(s, id) {
    const x = s.trips.find((tr) => tr.id === id);
    if (!x) return;
    if (x.published === false) s.trips.splice(s.trips.indexOf(x), 1);
    else x.status = 'cancelled';
  }

  function cancelTrip(id) {
    const t = MB.trip(id);
    if (!t || !canChange(t)) return toast('لا يمكن إلغاء هذه الرحلة', true);
    if (!window.confirm('إلغاء ' + titleOf(t) + '؟')) return;
    const snap = { ...t };
    const isDraft = t.published === false;
    const alt = findAlt(t);
    MB.update((s) => retireTrip(s, id));
    if (!isDraft) MB.notify('ملغاة: ' + titleOf(snap) + '. ' + (alt ? 'أقرب بديل: ' + titleOf(alt) : 'لا توجد رحلة بديلة في نفس اليوم'), 'info');
    toast(isDraft ? 'حُذفت المسودة' : 'تم إلغاء الرحلة وإرسال التنبيه بالبديل');
  }

  function mergeTrip(id) {
    const t = MB.trip(id);
    if (!t || t.status !== 'scheduled') return toast('لا يمكن دمج هذه الرحلة', true);
    const next = nextTripOf(t);
    if (!next) return toast('لا توجد رحلة تالية لنفس الخط للدمج فيها', true);
    if (!window.confirm('دمج ' + titleOf(t) + ' في ' + titleOf(next) + '؟')) return;
    const snap = { ...t };
    const total = t.booked + t.waitlist;
    const fit = Math.min(total, Math.max(0, next.capacity - next.booked));
    MB.update((s) => {
      const n = s.trips.find((x) => x.id === next.id);
      n.booked += fit;
      n.waitlist += total - fit;
      retireTrip(s, id);
    });
    if (snap.published !== false) MB.notify('تم دمج ' + titleOf(snap) + ' في ' + titleOf(next) + ' (' + total + ' راكب)', 'info');
    toast('تم دمج ' + total + ' راكب في الرحلة التالية');
  }

  // "زوّد حافلة": adds a draft bus for the same line/time, moves waitlisted students onto it
  function addBusShortcut(id) {
    const t = MB.trip(id);
    if (!t) return;
    const busyBus = new Set(MB.state.trips.filter((x) => x.status !== 'cancelled' && x.scheduledAt === t.scheduledAt).map((x) => x.busId));
    const busyDrv = new Set(MB.state.trips.filter((x) => x.status !== 'cancelled' && x.scheduledAt === t.scheduledAt).map((x) => x.driverId));
    const bus = MB.buses.find((b) => !busyBus.has(b.id));
    const drv = MB.drivers.find((d) => !busyDrv.has(d.id));
    if (!bus || !drv) return toast('لا توجد حافلة أو سائق متاح في هذا الموعد', true);
    const moved = Math.min(t.waitlist, bus.capacity);
    const nt = { id: MB.newTripId(), routeId: t.routeId, direction: t.direction, time: t.time, scheduledAt: t.scheduledAt, driverId: drv.id, busId: bus.id, capacity: bus.capacity, booked: moved, waitlist: 0, status: 'scheduled', startedAt: null, published: false };
    MB.update((s) => {
      s.trips.push(nt);
      const src = s.trips.find((x) => x.id === id);
      if (src) src.waitlist = Math.max(0, src.waitlist - moved);
    });
    MB.notify('أُضيفت حافلة ' + plateOf(bus.id) + ' لـ' + titleOf(t) + ' (' + moved + ' من قائمة الانتظار) بانتظار تأكيد النشر', 'info');
    toast('أُضيفت الحافلة كمسودة. أكّد النشر من تبويب نشر الجدول');
  }

  function tripFields(t, day) {
    const routeOpts = MB.routes.map((r) => '<option value="' + r.id + '" ' + (t && t.routeId === r.id ? 'selected' : '') + '>' + esc(lineLabel(r)) + '</option>').join('');
    const drvOpts = MB.drivers.map((d) => '<option value="' + d.id + '" ' + (t && t.driverId === d.id ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('');
    const busOpts = MB.buses.map((b) => '<option value="' + b.id + '" ' + (t && t.busId === b.id ? 'selected' : '') + '>' + esc(b.plate) + ' · ' + b.capacity + ' مقعد</option>').join('');
    return '<label>التاريخ</label><input type="date" name="date" value="' + esc(day) + '" required>' +
      '<label>الخط</label><select name="routeId">' + routeOpts + '</select>' +
      '<label>الاتجاه</label><select name="direction"><option value="go" ' + (!t || t.direction === 'go' ? 'selected' : '') + '>ذهاب</option><option value="back" ' + (t && t.direction === 'back' ? 'selected' : '') + '>عودة</option></select>' +
      '<label>وقت الانطلاق</label><input type="time" name="time" value="' + (t ? esc(t.time) : '07:00') + '" required>' +
      '<label>السائق</label><select name="driverId">' + drvOpts + '</select>' +
      '<label>الحافلة (السعة تتحدد منها)</label><select name="busId">' + busOpts + '</select>';
  }

  function saveTrip(data, editId) {
    const sched = at(data.date || '', data.time || '');
    if (!data.date || !data.time || isNaN(sched)) return 'اختر تاريخاً ووقتاً صحيحين';
    const bus = MB.bus[data.busId], route = MB.R[data.routeId], drv = MB.drv[data.driverId];
    if (!bus || !route || !drv) return 'اختر الخط والسائق والحافلة';
    const clash = MB.state.trips.find((x) => x.id !== editId && x.status !== 'cancelled' && x.scheduledAt === sched && (x.busId === bus.id || x.driverId === drv.id));
    if (clash) return (clash.busId === bus.id ? 'الحافلة' : 'السائق') + ' مرتبط برحلة أخرى في نفس الموعد';
    MB.update((s) => {
      if (editId) {
        const t = s.trips.find((x) => x.id === editId);
        const total = t.booked + t.waitlist;
        Object.assign(t, { routeId: route.id, direction: data.direction === 'back' ? 'back' : 'go', time: data.time, scheduledAt: sched, driverId: drv.id, busId: bus.id, capacity: bus.capacity });
        t.booked = Math.min(total, bus.capacity);
        t.waitlist = total - t.booked;
      } else {
        const t = { id: MB.newTripId(), routeId: route.id, direction: data.direction === 'back' ? 'back' : 'go', time: data.time, scheduledAt: sched, driverId: drv.id, busId: bus.id, capacity: bus.capacity, booked: 0, waitlist: 0, status: 'scheduled', startedAt: null, published: false };
        s.trips.push(t);
      }
    });
    return '';
  }

  function openTripModal(id) {
    const t = id ? MB.trip(id) : null;
    if (t && !canChange(t)) return toast('لا يمكن تعديل رحلة ' + (MB.statusLabel[t.status] || ''), true);
    openModal(t ? 'تعديل الرحلة' : 'إضافة رحلة جديدة', tripFields(t, t ? dayKey(t.scheduledAt) : tripDay), (data) => {
      const err = saveTrip(data, id || null);
      if (!err) toast(t ? 'تم تحديث الرحلة' : 'أُضيفت الرحلة كمسودة. أكّدها من تبويب نشر الجدول');
      return err;
    }, 'حفظ');
  }

  // ---------- 3.1 publish with review ----------
  function freshDraft() {
    return tripsToday().filter((t) => t.status !== 'cancelled').map((t) => ({ ...t, src: t.id, removed: false, isNew: false }));
  }

  function addDraftBus(i) {
    const src = draft[i];
    if (!src) return;
    const slot = draft.filter((d) => !d.removed && d.time === src.time);
    const usedBus = new Set(slot.map((d) => d.busId));
    const usedDrv = new Set(slot.map((d) => d.driverId));
    const bus = MB.buses.find((b) => !usedBus.has(b.id));
    const drv = MB.drivers.find((d) => !usedDrv.has(d.id));
    if (!bus || !drv) return toast('لا توجد حافلة أو سائق متاح في هذا الموعد', true);
    draft.splice(i + 1, 0, { ...src, src: null, id: null, busId: bus.id, driverId: drv.id, capacity: bus.capacity, booked: 0, waitlist: 0, status: 'scheduled', startedAt: null, published: false, removed: false, isNew: true });
    renderView();
  }

  function confirmPublish() {
    if (!draft) return;
    if (draft.some((d) => !d.removed && !/^\d{2}:\d{2}$/.test(d.time || ''))) return toast('أدخل وقتاً صحيحاً لكل رحلة', true);
    const day = todayKey();
    const cancelled = [];
    let added = 0, kept = 0;
    MB.update((s) => {
      draft.forEach((d) => {
        if (d.isNew) {
          const bus = MB.bus[d.busId];
          const t = { id: MB.newTripId(), routeId: d.routeId, direction: d.direction, time: d.time, scheduledAt: at(day, d.time), driverId: d.driverId, busId: d.busId, capacity: bus.capacity, booked: 0, waitlist: 0, status: 'scheduled', startedAt: null, published: true };
          s.trips.push(t);
          added++;
          return;
        }
        const x = s.trips.find((tr) => tr.id === d.src);
        if (!x) return;
        if (d.removed) {
          if (x.published === false) retireTrip(s, x.id);
          else if (canChange(x)) { cancelled.push({ ...x }); x.status = 'cancelled'; }
          return;
        }
        if (canChange(x)) { x.time = d.time; x.scheduledAt = at(dayKey(x.scheduledAt), d.time); }
        x.published = true;
        kept++;
      });
    });
    cancelled.forEach((snap) => {
      const alt = findAlt(snap);
      MB.notify('ملغاة: ' + titleOf(snap) + '. ' + (alt ? 'أقرب بديل: ' + titleOf(alt) : 'لا توجد رحلة بديلة في نفس اليوم'), 'info');
    });
    draft = null;
    renderView();
    toast('تم النشر: ' + kept + ' رحلة، ' + added + ' حافلة جديدة، ' + cancelled.length + ' ملغاة');
  }

  function reopenAsDraft() {
    if (!window.confirm('إعادة فتح جدول اليوم كمسودة؟ الرحلات المجدولة (غير المنطلقة) ستختفي عن الطلاب والسائقين حتى تؤكد النشر.')) return;
    MB.update((s) => s.trips.forEach((t) => { if (dayKey(t.scheduledAt) === todayKey() && t.status === 'scheduled') t.published = false; }));
    draft = null;
    renderView();
    toast('الجدول أصبح مسودة');
  }

  function renderPublish() {
    if (!draft) draft = freshDraft();
    const n = (fn) => draft.filter(fn).length;
    const summary = [
      kpi('منشورة', n((d) => !d.removed && !d.isNew && d.published !== false)),
      kpi('مسودات', n((d) => !d.removed && !d.isNew && d.published === false)),
      kpi('جديدة', n((d) => !d.removed && d.isNew)),
      kpi('محذوفة لليوم', n((d) => d.removed)),
    ].join('');
    const rows = draft.map((d, i) => {
      const locked = d.status === 'en_route' || d.status === 'arrived';
      let badge;
      if (d.removed) badge = '<span class="badge bad">محذوفة لليوم</span>';
      else if (d.isNew) badge = '<span class="badge info">حافلة جديدة</span>';
      else if (d.published === false) badge = '<span class="badge warn">مسودة</span>';
      else badge = '<span class="badge ok">منشورة</span>';
      let actions;
      if (d.removed) actions = '<button class="btn sm sec" data-act="pubRestore" data-i="' + i + '">استرجاع</button>';
      else if (locked) actions = '<span class="mute">' + esc(MB.statusLabel[d.status]) + '</span>';
      else actions = '<button class="btn sm bad" data-act="pubRemove" data-i="' + i + '">حذف لليوم</button> <button class="btn sm sec" data-act="pubBus" data-i="' + i + '">+ حافلة للخط</button>';
      return '<tr class="' + (d.removed ? 'rm' : '') + '">' +
        '<td><input type="time" value="' + esc(d.time) + '" data-chg="pubTime" data-i="' + i + '" ' + (locked || d.removed ? 'disabled' : '') + '></td>' +
        '<td>' + esc(routeName(d.routeId)) + ' · ' + dirLabel(d.direction) + '</td>' +
        '<td>' + esc(drvName(d.driverId)) + '</td>' +
        '<td>' + esc(plateOf(d.busId)) + ' <span class="mute">(' + d.capacity + ')</span></td>' +
        '<td>' + badge + '</td>' +
        '<td class="acts">' + actions + '</td></tr>';
    }).join('');
    return head('نشر جدول اليوم', '') +
      '<div class="grid g4">' + summary + '</div>' +
      '<div class="card" style="margin-top:12px"><h3>مسودة الجدول</h3>' +
      '<p class="mute" style="margin-top:0">عدّل المسودة كما تريد: احذف رحلة لليوم، غيّر الوقت، أو أضف حافلة لخط مزدحم. لا يُنشر أي تغيير قبل زر "تأكيد النشر".</p>' +
      (draft.length ? table(['الوقت', 'الخط والاتجاه', 'السائق', 'الحافلة (السعة)', 'الحالة', 'إجراء'], rows) : empty('لا توجد رحلات لليوم. أضفها من تبويب الرحلات.')) +
      '<div class="row" style="justify-content:flex-end;margin-top:12px">' +
      '<button class="btn sec" data-act="pubRefresh">تحديث من الجدول الحالي</button>' +
      '<button class="btn sec" data-act="pubReopen">إعادة فتح الجدول كمسودة</button>' +
      '<button class="btn ok" data-act="pubConfirm">تأكيد النشر</button></div></div>';
  }

  // ---------- 3.2 trips ----------
  function renderTrips() {
    const list = dayTrips(tripDay);
    const rows = list.map((t) => {
      const editable = canChange(t);
      const acts = editable
        ? '<button class="btn sm sec" data-act="tripEdit" data-id="' + t.id + '">تعديل</button> <button class="btn sm bad" data-act="tripCancel" data-id="' + t.id + '">إلغاء</button>'
        : '<span class="mute">—</span>';
      return '<tr><td>' + esc(t.time) + '</td><td>' + esc(routeName(t.routeId)) + ' · ' + dirLabel(t.direction) + '</td><td>' + esc(drvName(t.driverId)) + '</td><td>' + esc(plateOf(t.busId)) + ' <span class="mute">(' + t.capacity + ')</span></td><td>' + t.booked + ' / ' + t.capacity + '</td><td>' + badgeStatus(t) + '</td><td class="acts">' + acts + '</td></tr>';
    }).join('');
    return head('الرحلات', '<div class="row toolbar"><input type="date" data-chg="tripDay" value="' + esc(tripDay) + '"><button class="btn" data-act="tripAdd">+ إضافة رحلة</button></div>') +
      '<div class="card">' +
      (list.length ? table(['الوقت', 'الخط والاتجاه', 'السائق', 'الحافلة', 'الحجز', 'الحالة', 'إجراءات'], rows) : empty('لا توجد رحلات في هذا اليوم. اضغط "إضافة رحلة".')) +
      '<p class="adm-note">الرحلات الجديدة تُضاف كمسودة وتظهر للطلاب بعد تأكيد النشر من تبويب نشر الجدول.</p></div>';
  }

  // ---------- 3.3 demand board ----------
  function renderDemand() {
    const trips = tripsToday().filter((t) => t.status !== 'cancelled' && t.status !== 'arrived' && t.direction === 'go');
    const booked = trips.reduce((a, t) => a + t.booked, 0);
    const cap = trips.reduce((a, t) => a + t.capacity, 0);
    const weak = trips.filter((t) => canChange(t) && fillPct(t) < 30).length;
    const crowded = trips.filter((t) => t.waitlist > 0).length;
    const rows = trips.map((t) => {
      const p = fillPct(t);
      const weakRow = canChange(t) && p < 30;
      let acts = '';
      if (weakRow) {
        const next = nextTripOf(t);
        acts += '<button class="btn sm bad" data-act="demCancel" data-id="' + t.id + '">إلغاء</button> ';
        acts += '<button class="btn sm sec" data-act="demMerge" data-id="' + t.id + '"' + (next ? '' : ' disabled title="لا توجد رحلة تالية"') + '>دمج</button> ';
      }
      if (t.waitlist > 0 && canChange(t)) acts += '<button class="btn sm ok" data-act="demAddBus" data-id="' + t.id + '">زوّد حافلة</button>';
      return '<tr><td>' + esc(titleOf(t)) + '</td><td>' + badgeStatus(t) + '</td>' +
        '<td style="min-width:160px"><div class="bar"><i style="width:' + Math.min(100, p) + '%"></i></div></td>' +
        '<td>' + t.booked + ' / ' + t.capacity + ' <span class="mute">(' + p + '%)</span></td>' +
        '<td>' + (t.waitlist ? '<span class="badge warn">' + t.waitlist + ' منتظر</span>' : '—') + '</td>' +
        '<td class="acts">' + (acts || '<span class="mute">—</span>') + '</td></tr>';
    }).join('');
    return head('لوحة الطلب المباشر', '') +
      '<div class="grid g4">' + kpi('الحجوزات اليوم', booked) + kpi('المقاعد المتاحة', cap) + kpi('نسبة الامتلاء', (cap ? Math.round((booked / cap) * 100) : 0) + '%') + kpi('رحلات ضعيفة / مزدحمة', weak + ' / ' + crowded) + '</div>' +
      '<div class="card" style="margin-top:12px"><h3>الرحلات النشطة اليوم</h3>' +
      (trips.length ? table(['الرحلة', 'الحالة', 'الامتلاء', 'المقاعد', 'الانتظار', 'إجراء'], rows) : empty('لا توجد رحلات نشطة اليوم.')) +
      '<p class="adm-note">ضعيفة: أقل من 30% من المقاعد. مزدحمة: بها طلاب في قائمة الانتظار. الإجراءات المعلّقة تُنفَّذ بنقرة وتُرسَل تنبيهاً تلقائياً.</p></div>';
  }

  // ---------- 3.4 live monitor ----------
  let map = null;
  let markers = {};

  function renderMonitor() {
    map = null;
    markers = {};
    return head('المراقبة المباشرة', '<span class="live-pill"><i></i>مباشر</span>') +
      '<div id="liveMap" class="map live"></div>' +
      '<div id="monStats" class="grid g4"></div>' +
      '<div class="card" style="margin-bottom:12px"><h3>طلبات الركوب (Ready)</h3><div id="readyStats" class="row" style="flex-wrap:wrap;gap:8px"></div>' +
      '<p class="adm-note">أعداد فقط لطلبات رحلات اليوم، بدون أي بيانات شخصية للطلاب.</p></div>' +
      '<div class="card"><h3>الرحلات الجارية</h3>' +
      '<div class="tbl"><table><thead><tr><th>الخط</th><th>السائق</th><th>التقدم</th><th>الركاب</th><th>طلبات نشطة</th><th>تم الركوب</th><th>الحالة</th></tr></thead><tbody id="monBody"></tbody></table></div>' +
      '</div>';
  }

  function initMap() {
    const el = $('#liveMap');
    if (!el) return;
    if (!window.L) {
      el.innerHTML = '<p class="mute" style="padding:16px">تعذّر تحميل الخريطة. تحقق من الاتصال بالإنترنت، وما زالت الجداول تعمل.</p>';
      return;
    }
    map = L.map(el).setView([28.11, 30.80], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    const pts = [];
    (MB.routes || []).forEach((r) => {
      if (!r.polyline || !r.polyline.length) return;
      L.polyline(r.polyline, { color: r.color, weight: 4, opacity: 0.75 }).addTo(map);
      const a = r.polyline[0], b = r.polyline[r.polyline.length - 1];
      pts.push(a, b);
      L.circleMarker(a, { radius: 6, color: r.color, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip('بداية: ' + esc(r.fromName || '')).addTo(map);
      L.circleMarker(b, { radius: 6, color: r.color, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip('نهاية: ' + esc(r.toName || '')).addTo(map);
    });
    if (pts.length) map.fitBounds(pts, { padding: [24, 24] });
  }

  function updateMonitor() {
    if (cur !== 'monitor' || !$('#monBody')) return;
    const en = MB.state.trips.filter((t) => t.status === 'en_route');
    const pax = en.reduce((a, t) => a + t.booked, 0);
    const avg = en.length ? Math.round((en.reduce((a, t) => a + MB.progressOf(t), 0) / en.length) * 100) : 0;
    $('#monStats').innerHTML = kpi('حافلات في الطريق', en.length) + kpi('الركاب على متنها', pax) + kpi('متوسط التقدم', avg + '%');
    $('#monBody').innerHTML = en.length ? en.map((t) => {
      const p = MB.position(t) || { progress: MB.progressOf(t), paused: false };
      const pctv = Math.round(p.progress * 100);
      const active = pkOf(t.id, true).length;
      const boarded = pkOf(t.id, false).filter((k) => k.status === 'boarded').length;
      const pausedBadge = p.paused ? '<span class="badge warn">واقف للركوب</span>' : '<span class="badge ok">في الطريق</span>';
      return '<tr><td>' + esc(routeName(t.routeId)) + ' · ' + dirLabel(t.direction) + '</td><td>' + esc(drvName(t.driverId)) + '</td>' +
        '<td style="min-width:120px"><div class="bar"><i style="width:' + pctv + '%"></i></div> ' + pctv + '%</td>' +
        '<td>' + t.booked + ' / ' + t.capacity + '</td><td>' + active + '</td><td>' + boarded + '</td><td>' + pausedBadge + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="mute">لا توجد حافلات في الطريق الآن</td></tr>';

    // Ready requests: counts only (no student identity) across today's trips
    const rs = $('#readyStats');
    if (rs) {
      const todayIds = new Set(tripsToday().map((t) => t.id));
      const cnt = { waiting: 0, accepted: 0, boarded: 0, skipped: 0, passed: 0 };
      (MB.state.pickups || []).forEach((k) => {
        if (!todayIds.has(k.tripId)) return;
        if (k.status === 'boarding') cnt.accepted++;
        else if (cnt[k.status] != null) cnt[k.status]++;
      });
      const chip = (cls, label, n) => '<span class="badge ' + cls + '">' + esc(label) + ': ' + n + '</span>';
      rs.innerHTML = chip('warn', 'منتظر', cnt.waiting) + chip('info', 'مقبول (جارٍ الركوب)', cnt.accepted) +
        chip('ok', 'تم الركوب', cnt.boarded) + chip('bad', 'اعتذر السائق', cnt.skipped) + chip('', 'فاتهم الباص', cnt.passed);
    }

    if (map && window.L) {
      const seen = new Set();
      en.forEach((t) => {
        const p = MB.position(t);
        if (!p) return;
        seen.add(t.id);
        const ll = [p.lat, p.lng];
        if (markers[t.id]) markers[t.id].setLatLng(ll);
        else {
          markers[t.id] = L.marker(ll, { icon: L.divIcon({ className: 'adm-busicon', html: '<div class="pin bus">' + esc(busNo(t)) + '</div>', iconSize: [34, 34], iconAnchor: [17, 17] }) })
            .bindTooltip(esc(titleOf(t)))
            .addTo(map);
        }
      });
      Object.keys(markers).forEach((id) => { if (!seen.has(id)) { markers[id].remove(); delete markers[id]; } });
    }
  }

  // ---------- 3.6 reports ----------
  function reportData(kind) {
    const trips = MB.state.trips;
    if (kind === 'lines') {
      const rows = MB.routes.map((r) => {
        const ts = trips.filter((t) => t.routeId === r.id && t.status !== 'cancelled');
        const booked = ts.reduce((a, t) => a + t.booked, 0);
        const cap = ts.reduce((a, t) => a + t.capacity, 0);
        return [lineLabel(r), ts.length, booked, cap, cap ? Math.round((booked / cap) * 100) : 0];
      });
      return { name: 'passengers-per-line', head: ['الخط', 'عدد الرحلات', 'إجمالي الحجوزات', 'إجمالي المقاعد', 'نسبة الامتلاء %'], rows };
    }
    if (kind === 'punct') {
      const rows = trips.filter((t) => t.status === 'arrived' && t.startedAt).map((t) => {
        const delay = Math.round((t.startedAt - t.scheduledAt) / 60000);
        return [titleOf(t), dayKey(t.scheduledAt), t.time, hhmm(t.startedAt), delay, delay <= 5 ? 'نعم' : 'لا'];
      });
      return { name: 'punctuality', head: ['الرحلة', 'التاريخ', 'موعد الجدول', 'وقت البدء الفعلي', 'التأخير (دقيقة)', 'في الموعد (حتى 5 دقائق)'], rows };
    }
  }

  function toCsv(head, rows) {
    const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    // BOM first so Excel reads the UTF-8 Arabic correctly
    return '﻿' + [head].concat(rows).map((r) => r.map(cell).join(',')).join('\r\n');
  }

  function downloadCsv(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reportTable(kind) {
    const d = reportData(kind);
    if (!d.rows.length) return empty('لا توجد بيانات لهذا التقرير بعد.');
    return table(d.head, d.rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join(''));
  }

  function renderReports() {
    const p = reportData('punct');
    const onTime = p.rows.filter((r) => r[5] === 'نعم').length;
    const ratePct = p.rows.length ? Math.round((onTime / p.rows.length) * 100) : null;
    const pax = MB.state.trips.filter((t) => t.status !== 'cancelled').reduce((a, t) => a + t.booked, 0);
    return head('التقارير والتصدير', '<div class="row no-print"><button class="btn sec" data-act="print">طباعة / حفظ PDF</button></div>') +
      '<div class="grid g4">' + kpi('إجمالي الحجوزات', pax) + kpi('نسبة الالتزام بالمواعيد', ratePct == null ? '—' : ratePct + '%') + kpi('رحلات منتهية', p.rows.length) + '</div>' +
      '<div class="card" style="margin-top:12px"><div class="row"><h3 class="grow">عدد الركاب لكل خط</h3><button class="btn sm no-print" data-act="rep" data-kind="lines">تحميل CSV</button></div>' + reportTable('lines') + '</div>' +
      '<div class="card"><div class="row"><h3 class="grow">الالتزام بالمواعيد</h3><button class="btn sm no-print" data-act="rep" data-kind="punct">تحميل CSV</button></div>' + reportTable('punct') + '</div>';
  }

  // ---------- 3.7 complaints ----------
  function renderComplaints() {
    const all = MB.state.reports;
    const cats = [...new Set(all.map((r) => r.category).filter(Boolean))];
    const list = all.filter((r) => cmpCat === 'all' || r.category === cmpCat);
    const openN = all.filter((r) => r.status !== 'closed').length;
    const filter = '<select data-chg="cmpFilter" style="width:auto"><option value="all">كل الفئات</option>' +
      cats.map((c) => '<option value="' + esc(c) + '" ' + (cmpCat === c ? 'selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';
    const rows = list.map((r) => '<tr><td>' + dayKey(r.ts) + '<br><span class="mute">' + hhmm(r.ts) + '</span></td><td>' + esc(r.studentName) + '</td><td>' + esc(r.category) + '</td>' +
      '<td style="max-width:320px">' + esc(r.text) + '</td>' +
      '<td>' + (r.status === 'closed' ? '<span class="badge ok">مغلقة</span>' : '<span class="badge warn">مفتوحة</span>') + '</td>' +
      '<td><input value="' + esc(r.assignee || '') + '" placeholder="اسم المسؤول" data-chg="cmpAssign" data-id="' + esc(r.id) + '"></td>' +
      '<td><button class="btn sm ' + (r.status === 'closed' ? 'sec' : 'ok') + '" data-act="cmpToggle" data-id="' + esc(r.id) + '">' + (r.status === 'closed' ? 'إعادة فتح' : 'إغلاق') + '</button></td></tr>').join('');
    return head('الشكاوى والبلاغات', '<div class="row toolbar">' + filter + '</div>') +
      '<div class="grid g4">' + kpi('الإجمالي', all.length) + kpi('مفتوحة', openN) + kpi('مغلقة', all.length - openN) + '</div>' +
      '<div class="card" style="margin-top:12px">' +
      (list.length ? table(['التاريخ', 'الطالب', 'الفئة', 'نص الشكوى', 'الحالة', 'المسؤول', 'إجراء'], rows) : empty('لا توجد شكاوى في هذه الفئة.')) + '</div>';
  }

  // ---------- 3.10 policies ----------
  function renderPolicies() {
    if (!polDraft) polDraft = { lastReturn: MB.state.policies.lastReturn, rules: MB.state.policies.rules.slice() };
    const rules = polDraft.rules.length
      ? polDraft.rules.map((r, i) => '<div class="row rule"><input value="' + esc(r) + '" data-inp="pol" data-i="' + i + '" placeholder="اكتب القاعدة"><button class="btn sm bad" data-act="polDel" data-i="' + i + '">حذف</button></div>').join('')
      : empty('لا توجد قواعد. أضف قاعدة جديدة.');
    return head('سياسات الرحلات', '') +
      '<div class="card"><h3>آخر رحلة عودة</h3><label for="polTime">الوقت الأخير المعلن للطلاب</label>' +
      '<input id="polTime" type="time" value="' + esc(polDraft.lastReturn) + '" data-inp="polTime" style="max-width:200px"></div>' +
      '<div class="card"><h3>قواعد الحافلات</h3><p class="mute" style="margin-top:0">تظهر هذه القواعد لجميع الطلاب والسائقين.</p>' + rules +
      '<div class="row" style="margin-top:8px"><button class="btn sec" data-act="polAdd">+ إضافة قاعدة</button><button class="btn ok" data-act="polSave">حفظ السياسات</button></div></div>';
  }

  // ---------- 3.9 privacy ----------
  function renderPrivacy() {
    return head('سياسة الخصوصية', '') +
      '<div class="card priv"><h3>ما تراه كل جهة</h3><ul>' +
      '<li>السائق يرى <b>مواقع طلبات الركوب</b> المجهولة على مساره فقط، ولا يرى أسماء الطلاب أو أرقام هواتفهم.</li>' +
      '<li>لا تُعرض <b>أرقام هواتف الطلاب</b> في أي شاشة من لوحة الإدارة أو في التقارير المصدّرة.</li>' +
      '<li>التقارير المصدّرة تحتوي على أعداد وإحصائيات مجمّعة (ركاب الخطوط، الالتزام بالمواعيد).</li>' +
      '<li>شكاوى الطلاب تُعرض للإدارة فقط.</li>' +
      '</ul></div>';
  }

  // ---------- KPI strip (always visible above the views) ----------
  function kpiCard(tone, label, value, sub) {
    return '<div class="kcard ' + tone + '"><div class="klabel">' + esc(label) + '</div><div class="kval">' + esc(value) + '</div><div class="ksub">' + esc(sub) + '</div></div>';
  }

  function renderKpis() {
    const el = $('#kpis');
    if (!el) return;
    const s = MB.state;
    const today = todayKey();
    const live = tripsToday().filter((t) => t.published !== false && t.status !== 'cancelled');
    const riders = live.reduce((a, t) => a + t.booked, 0);
    const cap = live.reduce((a, t) => a + t.capacity, 0);
    const occ = cap ? Math.round((riders / cap) * 100) : 0;
    const active = s.trips.filter((t) => t.status === 'en_route').length;
    const todayIds = new Set(live.map((t) => t.id));
    const readyActive = (s.pickups || []).filter((k) => todayIds.has(k.tripId) && (k.status === 'accepted' || k.status === 'boarding')).length;
    el.innerHTML = [
      kpiCard('ok', 'رحلات نشطة', active, 'حافلات في الطريق الآن'),
      kpiCard('info', 'ركاب اليوم', riders, 'حجوزات رحلات اليوم'),
      kpiCard('warn', 'نسبة الإشغال', occ + '%', 'من إجمالي المقاعد اليوم'),
      kpiCard('brand', 'طلبات Ready النشطة', readyActive, 'طلبات ركوب مقبولة لرحلات اليوم'),
    ].join('');
  }

  // ---------- trip chat (read-only oversight) ----------
  const CHAT_WHO = { driver: 'السائق', student: 'طالب' };

  function renderChat() {
    const msgs = (MB.state.chat || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const groups = {};
    msgs.forEach((m) => { (groups[m.tripId] = groups[m.tripId] || []).push(m); });
    const ids = Object.keys(groups).sort((a, b) => {
      const la = groups[a][groups[a].length - 1].ts || 0, lb = groups[b][groups[b].length - 1].ts || 0;
      return lb - la;
    });
    const cards = ids.map((id) => {
      const t = MB.trip(id);
      const list = groups[id].map((m) => {
        const cls = m.from === 'driver' ? 'drv' : 'stu';
        return '<div class="chat-msg ' + cls + '"><span class="who">' + esc(CHAT_WHO[m.from] || 'غير معروف') + '</span>' +
          '<span class="txt">' + esc(m.text) + '</span><span class="tm">' + (m.ts ? hhmm(m.ts) : '—') + '</span></div>';
      }).join('');
      return '<div class="card chat-card"><div class="chat-head"><h3 class="grow">' + esc(t ? titleOf(t) : 'رحلة ' + id) + '</h3>' +
        '<span class="badge info">' + groups[id].length + ' رسالة</span></div><div class="chat-list">' + list + '</div></div>';
    }).join('');
    return head('المحادثات', '<span class="badge info">للقراءة فقط</span>') +
      '<p class="adm-note" style="margin:0 0 12px">محادثات الرحلات بين السائق والطلاب، مجمّعة حسب الرحلة، للمتابعة فقط ولا يمكن الرد منها.</p>' +
      (ids.length ? cards : '<div class="card">' + empty('لا توجد محادثات على الرحلات بعد.') + '</div>');
  }

  // ---------- router & render ----------
  const VIEWS = {
    monitor: { label: 'المتابعة الحية للأسطول', render: renderMonitor },
    publish: { label: 'جدول اليوم والرحلات', render: () => renderPublish() + '<div style="margin-top:18px">' + renderTrips() + '</div>' },
    demand: { label: 'لوحة الطلب المباشر', render: renderDemand },
    complaints: { label: 'البلاغات والسياسات', render: () => renderComplaints() + '<div style="margin-top:18px">' + renderPolicies() + '</div><div style="margin-top:18px">' + renderPrivacy() + '</div>' },
    reports: { label: 'التقارير والتصدير', render: renderReports },
  };

  function renderView() {
    $('#view').innerHTML = VIEWS[cur].render();
    if (cur === 'monitor') { initMap(); updateMonitor(); }
  }

  function go() {
    const h = (location.hash || '').slice(1);
    cur = VIEWS[h] ? h : 'monitor';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === cur));
    renderKpis();
    renderView();
  }

  function onState() {
    renderKpis();
    if (cur === 'monitor') updateMonitor();
    else renderView();
  }

  // ---------- actions (delegated) ----------
  const ACTIONS = {
    pubRemove: ({ i }) => {
      const d = draft[+i];
      if (!d) return;
      if (d.isNew) draft.splice(+i, 1);
      else d.removed = true;
      renderView();
    },
    pubRestore: ({ i }) => { if (draft[+i]) { draft[+i].removed = false; renderView(); } },
    pubBus: ({ i }) => addDraftBus(+i),
    pubRefresh: () => { draft = null; renderView(); toast('تم تحديث المسودة من الجدول الحالي'); },
    pubReopen: () => reopenAsDraft(),
    pubConfirm: () => confirmPublish(),
    tripAdd: () => openTripModal(null),
    tripEdit: ({ id }) => openTripModal(id),
    tripCancel: ({ id }) => cancelTrip(id),
    demCancel: ({ id }) => cancelTrip(id),
    demMerge: ({ id }) => mergeTrip(id),
    demAddBus: ({ id }) => addBusShortcut(id),
    rep: ({ kind }) => {
      const d = reportData(kind);
      downloadCsv(d.name + '-' + todayKey() + '.csv', toCsv(d.head, d.rows));
      toast('تم تنزيل ملف CSV (UTF-8 مع BOM)');
    },
    print: () => window.print(),
    cmpToggle: ({ id }) => MB.update((s) => {
      const r = s.reports.find((x) => x.id === id);
      if (r) r.status = r.status === 'closed' ? 'open' : 'closed';
    }),
    polDel: ({ i }) => { polDraft.rules.splice(+i, 1); renderView(); },
    polAdd: () => { polDraft.rules.push(''); renderView(); const inputs = document.querySelectorAll('[data-inp="pol"]'); if (inputs.length) inputs[inputs.length - 1].focus(); },
    polSave: () => {
      if (!/^\d{2}:\d{2}$/.test(polDraft.lastReturn || '')) return toast('أدخل وقت آخر رحلة صحيح', true);
      const rules = polDraft.rules.map((r) => r.trim()).filter(Boolean);
      const lastReturn = polDraft.lastReturn;
      MB.update((s) => { s.policies.lastReturn = lastReturn; s.policies.rules = rules; });
      polDraft = null;
      renderView();
      toast('تم حفظ السياسات وستظهر للجميع');
    },
  };

  const CHANGES = {
    pubTime: (v, d) => { if (draft[+d.i]) draft[+d.i].time = v; },
    tripDay: (v) => { if (v) { tripDay = v; renderView(); } },
    cmpFilter: (v) => { cmpCat = v; renderView(); },
    cmpAssign: (v, d) => MB.update((s) => {
      const r = s.reports.find((x) => x.id === d.id);
      if (r) r.assignee = v.trim();
    }),
  };

  const INPUTS = {
    polTime: (v) => { polDraft.lastReturn = v; },
    pol: (v, d) => { polDraft.rules[+d.i] = v; },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(el.dataset, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-chg]');
    if (!el) return;
    const fn = CHANGES[el.dataset.chg];
    if (fn) fn(el.value, el.dataset);
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-inp]');
    if (!el) return;
    const fn = INPUTS[el.dataset.inp];
    if (fn) fn(el.value, el.dataset);
  });

  // ---------- boot ----------
  $('#nav').innerHTML = Object.keys(VIEWS).map((k) => '<a href="#' + k + '" data-nav="' + k + '">' + esc(VIEWS[k].label) + '</a>').join('');
  window.addEventListener('hashchange', go);
  MB.subscribe(onState);
  setInterval(() => {
    const c = $('#clock');
    if (c) c.textContent = hhmmss(Date.now());
    if (cur === 'monitor') updateMonitor();
  }, 1000);
  go();
})();
