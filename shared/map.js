/* Lotus Bus - shared map pieces (window.MBMap). Needs Leaflet (window.L) loaded first.
   One look for the student, driver and admin maps: calm basemap (dark at night when asked),
   a route with a white outline + direction arrows, and the bus marker (bus icon, direction tip, small label). */
(function () {
  'use strict';

  const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTR = '&copy; OpenStreetMap';

  const isNight = (d) => { const h = (d || new Date()).getHours(); return h >= 19 || h < 5; };

  /* OpenStreetMap tiles, calmed down with a CSS filter (see .mb-tiles in mb.css) so the route and the pins stand out;
     with { night: true } the map turns dark after sunset, by itself */
  function addTiles(map, opts) {
    const L = window.L;
    const o = Object.assign({ night: false }, opts);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTR, className: 'mb-tiles' }).addTo(map);
    const apply = () => map.getContainer().classList.toggle('map-night', !!o.night && isNight());
    apply();
    if (o.night) {
      const iv = setInterval(() => {
        if (!map.getContainer().isConnected) { clearInterval(iv); return; }
        apply();
      }, 60000);
    }
    return { apply };
  }

  /* ---- geometry ---- */
  function pointAt(poly, p) {
    const f = Math.max(0, Math.min(1, p)) * (poly.length - 1);
    const i = Math.min(poly.length - 2, Math.floor(f)), k = f - i;
    return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * k, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * k];
  }
  const bearing = (a, b) => {
    const dy = (b[0] - a[0]) * 111000, dx = (b[1] - a[1]) * 98000;
    if (Math.abs(dx) + Math.abs(dy) < 1) return null;
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  };
  /* direction of travel at progress p, measured over a short stretch so tiny zig-zags do not make it jitter */
  function headingAt(poly, p) {
    return bearing(pointAt(poly, p - 0.012), pointAt(poly, p + 0.012));
  }
  /* the part of the path between two progress values, as a list of points */
  function sliceBetween(poly, p1, p2) {
    const a = Math.min(p1, p2), b = Math.max(p1, p2), n = poly.length - 1;
    const out = [pointAt(poly, a)];
    for (let i = Math.ceil(a * n); i <= Math.floor(b * n); i++) if (i > a * n && i < b * n) out.push(poly[i]);
    out.push(pointAt(poly, b));
    return out;
  }

  /* ---- route: white outline, grey part already driven, coloured part ahead, direction arrows ---- */
  function chevrons(map, poly) {
    const L = window.L, group = L.layerGroup();
    let acc = 0, next = 400;
    for (let i = 0; i < poly.length - 1; i++) {
      const seg = Math.hypot((poly[i + 1][0] - poly[i][0]) * 111000, (poly[i + 1][1] - poly[i][1]) * 98000);
      while (seg > 0 && acc + seg >= next) {
        const k = (next - acc) / seg;
        const pt = [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * k, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * k];
        const hd = bearing(poly[i], poly[i + 1]);
        if (hd !== null) {
          L.marker(pt, {
            icon: L.divIcon({
              className: 'mb-chev',
              html: '<svg viewBox="0 0 14 14" width="14" height="14" style="transform:rotate(' + hd.toFixed(0) + 'deg)"><path d="M3 9 7 4l4 5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
              iconSize: [14, 14],
              iconAnchor: [7, 7],
            }),
            interactive: false,
            keyboard: false,
          }).addTo(group);
        }
        next += 700;
      }
      acc += seg;
    }
    // arrows only when zoomed in enough to read them
    const sync = () => {
      const show = map.getZoom() >= 14;
      if (show && !map.hasLayer(group)) group.addTo(map);
      if (!show && map.hasLayer(group)) map.removeLayer(group);
    };
    map.on('zoomend', sync);
    sync();
    group._off = () => map.off('zoomend', sync);
    return group;
  }

  function route(map, poly, color) {
    const L = window.L;
    const base = { interactive: false, lineCap: 'round', lineJoin: 'round' };
    const casing = L.polyline(poly, Object.assign({ color: '#fff', weight: 11, opacity: 0.95 }, base)).addTo(map);
    const done = L.polyline([], Object.assign({ color: '#94a3b8', weight: 6, opacity: 1 }, base)).addTo(map);
    const line = L.polyline(poly, Object.assign({ color, weight: 6, opacity: 0.95 }, base)).addTo(map);
    const arrows = chevrons(map, poly);
    return {
      casing, done, line, arrows, poly,
      destroy() {
        [casing, done, line].forEach((l) => map.removeLayer(l));
        arrows._off();
        if (map.hasLayer(arrows)) map.removeLayer(arrows);
      },
    };
  }

  /* ---- the bus: a round bus icon, a small tip showing the direction of travel, an optional label under it ---- */
  const BUS_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<rect x="4" y="3.5" width="16" height="14" rx="3" fill="#fff"/>' +
    '<rect x="6" y="6" width="12" height="5" rx="1" fill="#042959"/>' +
    '<circle cx="8.5" cy="14.3" r="1.2" fill="#042959"/><circle cx="15.5" cy="14.3" r="1.2" fill="#042959"/>' +
    '<rect x="6" y="17" width="3" height="3.5" rx="1" fill="#fff"/><rect x="15" y="17" width="3" height="3.5" rx="1" fill="#fff"/></svg>';

  function bus(map, ll) {
    const L = window.L;
    const m = L.marker(ll, {
      icon: L.divIcon({
        className: 'mb-bus',
        html: '<div class="bm"><div class="bm-rot"><i class="bm-tip"></i></div><div class="bm-dot">' + BUS_SVG + '</div><div class="bm-lbl"></div></div>',
        iconSize: [0, 0],
      }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map);
    let hd = 0, lastLbl = '';
    return {
      marker: m,
      getLatLng: () => m.getLatLng(),
      /* ll = [lat,lng]; heading in degrees (0 = north) or null to keep the last one */
      move(ll2, heading) {
        m.setLatLng(ll2);
        if (heading === null || heading === undefined) return;
        const el = m.getElement();
        if (!el) return;
        // shortest turn, so the tip never spins the long way round
        hd += ((heading - hd + 540) % 360) - 180;
        const rot = el.querySelector('.bm-rot');
        if (rot) rot.style.transform = 'rotate(' + hd.toFixed(1) + 'deg)';
      },
      label(txt) {
        if (txt === lastLbl) return;
        lastLbl = txt;
        const el = m.getElement(), l = el && el.querySelector('.bm-lbl');
        if (l) l.textContent = txt;
      },
      remove() { m.remove(); },
    };
  }

  window.MBMap = { addTiles, route, bus, pointAt, headingAt, sliceBetween, bearing, isNight };
})();
