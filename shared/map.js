/* Lotus Bus - shared map pieces (window.MBMap). Needs Leaflet (window.L) + protomaps-leaflet (window.protomapsL).
   Self-hosted vector basemap for Minya & New Minya with full building footprints, cased road hierarchy,
   all 350+ OSM Arabic POIs/neighborhoods, plus curated Minya & New Minya landmarks. */
(function () {
  'use strict';

  const PMTILES = '/shared/minya.pmtiles';
  const FONT_REG = '600 11.5px Tajawal, Segoe UI, Tahoma, sans-serif';
  const FONT_BOLD = '700 12.5px Tajawal, Segoe UI, Tahoma, sans-serif';
  const FONT_CITY = '800 15px Tajawal, Segoe UI, Tahoma, sans-serif';

  function lumFlavor() {
    const P = window.protomapsL;
    return Object.assign({}, P.namedFlavor('light'), {
      background: '#eaeff6', earth: '#f3f6fa',
      park_a: '#d8eedd', park_b: '#c2e5cb', wood_a: '#d5ecdb', wood_b: '#bfe2c8',
      scrub_a: '#e2efe4', scrub_b: '#d1e6d5', sand: '#f2efe6', school: '#e3ebf8', hospital: '#f8e5e8',
      industrial: '#e6ebf2', pedestrian: '#ebeef4',
      water: '#7ec4f4', buildings: '#dce3ee',
      minor_a: '#ffffff', minor_b: '#ffffff', minor_service: '#f8fafc', other: '#f1f5f9',
      minor_casing: '#cbd5e1', minor_service_casing: '#d8e0eb', link_casing: '#b8c4d4',
      major: '#ffffff', major_casing_early: '#94a3b8', major_casing_late: '#94a3b8',
      highway: '#fde68a', highway_casing_early: '#d97706', highway_casing_late: '#d97706',
      railway: '#64748b', boundaries: '#94a3b8',
      roads_label_minor: '#334155', roads_label_minor_halo: '#ffffff',
      roads_label_major: '#0f172a', roads_label_major_halo: '#ffffff',
      city_label: '#042959', city_label_halo: '#ffffff', subplace_label: '#1e3a5f', subplace_label_halo: '#ffffff',
      landcover: { grassland: '#dfeee2', barren: '#f3f0e6', urban_area: '#eaeff5', farmland: '#d9eddc', glacier: '#ffffff', scrub: '#e5efe0', forest: '#cbe6d0' },
    });
  }

  function lumPaintRules(P, f) {
    const exp = P.exp;
    return [
      ...P.paintRules(f),
      // Crisp 3D-like building footprints with architectural outline
      {
        dataLayer: 'buildings',
        minzoom: 13,
        symbolizer: new P.PolygonSymbolizer({ fill: '#dfe6f0', stroke: '#c3cede', width: 0.7, opacity: 0.92 }),
      },
      // Nile shoreline stroke
      {
        dataLayer: 'water',
        symbolizer: new P.PolygonSymbolizer({ fill: '#7ec4f4', stroke: '#55a6e0', width: 1.2 }),
        filter: (z, feat) => feat.geomType === 3,
      },
      // Road casings (drawn underneath road fills so every street is sharp at all zooms)
      {
        dataLayer: 'roads',
        minzoom: 11.5,
        symbolizer: new P.LineSymbolizer({ color: '#cbd5e1', width: (z) => exp(1.5, [[11.5, 1.2], [13, 2.8], [15, 6.2], [18, 15]])(z) }),
        filter: (z, feat) => feat.props.kind === 'minor_road',
      },
      {
        dataLayer: 'roads',
        minzoom: 9,
        symbolizer: new P.LineSymbolizer({ color: '#94a3b8', width: (z) => exp(1.5, [[9, 1.6], [12, 3.8], [15, 8.5], [18, 20]])(z) }),
        filter: (z, feat) => feat.props.kind === 'major_road',
      },
      {
        dataLayer: 'roads',
        minzoom: 7,
        symbolizer: new P.LineSymbolizer({ color: '#d97706', width: (z) => exp(1.5, [[7, 2], [12, 5], [15, 10.5], [18, 24]])(z) }),
        filter: (z, feat) => feat.props.kind === 'highway' || feat.props.kind_detail === 'trunk',
      },
      // Road inner fills
      {
        dataLayer: 'roads',
        minzoom: 11.5,
        symbolizer: new P.LineSymbolizer({ color: '#ffffff', width: (z) => exp(1.5, [[11.5, 0.7], [13, 1.8], [15, 4.4], [18, 12]])(z) }),
        filter: (z, feat) => feat.props.kind === 'minor_road',
      },
      {
        dataLayer: 'roads',
        minzoom: 9,
        symbolizer: new P.LineSymbolizer({ color: '#ffffff', width: (z) => exp(1.5, [[9, 1], [12, 2.5], [15, 6.2], [18, 16]])(z) }),
        filter: (z, feat) => feat.props.kind === 'major_road' && feat.props.kind_detail !== 'trunk',
      },
      {
        dataLayer: 'roads',
        minzoom: 7,
        symbolizer: new P.LineSymbolizer({ color: '#fde68a', width: (z) => exp(1.5, [[7, 1.2], [12, 3.4], [15, 7.8], [18, 19]])(z) }),
        filter: (z, feat) => feat.props.kind === 'highway' || feat.props.kind_detail === 'trunk',
      },
    ];
  }

  function lumLabelRules(P, f) {
    const props = ['name:ar', 'name', 'name:en'];
    const areaKinds = new Set(['residential', 'primary', 'secondary', 'tertiary', 'city_gate', 'neighbourhood', 'suburb', 'commercial', 'industrial']);
    const majorPoiKinds = new Set(['university', 'college', 'hospital', 'stadium', 'aerodrome', 'mall', 'museum', 'park', 'sports_centre', 'bus_station', 'station', 'courthouse', 'police', 'post_office', 'community_centre', 'theatre', 'attraction', 'monastery']);
    const everydayPoiKinds = new Set(['place_of_worship', 'religious', 'school', 'hotel', 'bank', 'supermarket', 'pharmacy', 'fuel', 'restaurant', 'cafe', 'clinic', 'doctors', 'library', 'marketplace']);

    return [
      // 1. Cities & Towns (المنيا، المنيا الجديدة، سوادة)
      {
        dataLayer: 'places',
        minzoom: 8,
        symbolizer: new P.CenteredTextSymbolizer({
          labelProps: props, fill: '#042959', stroke: '#ffffff', width: 3.5, lineHeight: 1.3, font: FONT_CITY,
        }),
        filter: (z, feat) => feat.props.kind === 'locality' || feat.props.kind === 'region',
      },
      // 2. Neighborhoods, Districts & Squares (الأحياء، المجاورات، الميادين، المساكن)
      {
        dataLayer: 'pois',
        minzoom: 12,
        symbolizer: new P.CenteredTextSymbolizer({
          labelProps: props, fill: '#1e3a5f', stroke: '#ffffff', width: 3, lineHeight: 1.25, font: FONT_BOLD,
        }),
        filter: (z, feat) => areaKinds.has(feat.props.kind) && Boolean(feat.props['name:ar'] || feat.props.name),
      },
      // 3. Major Landmarks (الجامعات، المستشفيات، النوادي، الحدائق، المحطات، المولات)
      {
        dataLayer: 'pois',
        minzoom: 12,
        symbolizer: new P.GroupSymbolizer([
          new P.CircleSymbolizer({ radius: 4, fill: '#042959', stroke: '#ffffff', width: 1.5 }),
          new P.OffsetTextSymbolizer({
            labelProps: props, fill: '#042959', stroke: '#ffffff', width: 3, offsetX: 7, offsetY: 4, font: FONT_BOLD,
          }),
        ]),
        filter: (z, feat) => majorPoiKinds.has(feat.props.kind) && Boolean(feat.props['name:ar'] || feat.props.name),
      },
      // 4. Everyday Landmarks (المساجد، الكنائس، المدارس، البنوك، الصيدليات، السوبرماركت)
      {
        dataLayer: 'pois',
        minzoom: 13.5,
        symbolizer: new P.GroupSymbolizer([
          new P.CircleSymbolizer({ radius: 3.2, fill: '#2b90d9', stroke: '#ffffff', width: 1.2 }),
          new P.OffsetTextSymbolizer({
            labelProps: props, fill: '#334155', stroke: '#ffffff', width: 2.5, offsetX: 6, offsetY: 3.5, font: FONT_REG,
          }),
        ]),
        filter: (z, feat) => everydayPoiKinds.has(feat.props.kind) && Boolean(feat.props['name:ar'] || feat.props.name),
      },
      // 5. Major Road & Bridge Labels
      {
        dataLayer: 'roads',
        minzoom: 11,
        symbolizer: new P.LineLabelSymbolizer({
          labelProps: props, fill: '#0f172a', stroke: '#ffffff', width: 3, font: FONT_BOLD, repeatDistance: 220,
        }),
        filter: (z, feat) => feat.props.kind === 'highway' || feat.props.kind === 'major_road',
      },
      // 6. Minor Street Labels
      {
        dataLayer: 'roads',
        minzoom: 13.5,
        symbolizer: new P.LineLabelSymbolizer({
          labelProps: props, fill: '#334155', stroke: '#ffffff', width: 2.5, font: FONT_REG, repeatDistance: 200,
        }),
        filter: (z, feat) => feat.props.kind === 'minor_road' || feat.props.kind === 'other',
      },
      // 7. Nile & Water Labels
      {
        dataLayer: 'water',
        minzoom: 10,
        symbolizer: new P.CenteredTextSymbolizer({
          labelProps: props, fill: '#0369a1', stroke: '#ffffff', width: 2.5, font: FONT_BOLD,
        }),
      },
    ];
  }

  /* Curated key hubs along Lotus University bus corridors so New Minya & Minya landmarks are always crystal clear */
  const LANDMARKS = [
    { lat: 28.1260, lng: 30.8469, name: '🎓 جامعة اللوتس بالمنيا (LUM)', minZoom: 10, pri: true },
    { lat: 28.1180, lng: 30.7435, name: 'حي شلبي', minZoom: 11 },
    { lat: 28.1245, lng: 30.7462, name: 'جامعة المنيا', minZoom: 11 },
    { lat: 28.1111, lng: 30.7515, name: 'شارع طه حسين', minZoom: 12 },
    { lat: 28.1078, lng: 30.7531, name: 'أرض سلطان', minZoom: 12 },
    { lat: 28.1033, lng: 30.7556, name: 'شارع عدنان المالكي', minZoom: 13 },
    { lat: 28.1055, lng: 30.7575, name: 'كورنيش النيل', minZoom: 12 },
    { lat: 28.0982, lng: 30.7568, name: 'ميدان بالاس', minZoom: 12 },
    { lat: 28.0965, lng: 30.7542, name: 'محطة قطار المنيا', minZoom: 12 },
    { lat: 28.0939, lng: 30.7728, name: 'كوبري المنيا العلوي (النيل)', minZoom: 11 },
    { lat: 28.1067, lng: 30.7737, name: 'شرق النيل — الشرفا', minZoom: 12 },
    { lat: 28.1005, lng: 30.7925, name: 'الحي السياحي', minZoom: 12 },
    { lat: 28.0940, lng: 30.8005, name: 'الحي الأول — المنيا الجديدة', minZoom: 12 },
    { lat: 28.0880, lng: 30.8050, name: 'جهاز مدينة المنيا الجديدة', minZoom: 12 },
    { lat: 28.0912, lng: 30.8085, name: 'جامعة دراية', minZoom: 12 },
    { lat: 28.0835, lng: 30.8125, name: 'الحي الثالث', minZoom: 13 },
    { lat: 28.0785, lng: 30.8220, name: 'جامعة المنيا الأهلية', minZoom: 12 },
    { lat: 28.0885, lng: 30.8240, name: 'الحي السادس', minZoom: 12 },
    { lat: 28.0954, lng: 30.8151, name: 'إبني بيتك — اللوتس', minZoom: 12 },
    { lat: 28.1013, lng: 30.8404, name: 'مدخل الصفا — المنيا الجديدة', minZoom: 12 },
  ];

  function addLandmarks(map) {
    const L = window.L;
    const group = L.layerGroup().addTo(map);
    const items = LANDMARKS.map((lm) => ({
      minZoom: lm.minZoom,
      marker: L.marker([lm.lat, lm.lng], {
        icon: L.divIcon({
          className: 'mb-lm' + (lm.pri ? ' pri' : ''),
          html: '<span>' + lm.name + '</span>',
          iconSize: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }),
    }));
    const sync = () => {
      const z = map.getZoom();
      items.forEach((it) => {
        const show = z >= it.minZoom;
        if (show && !group.hasLayer(it.marker)) group.addLayer(it.marker);
        if (!show && group.hasLayer(it.marker)) group.removeLayer(it.marker);
      });
    };
    map.on('zoomend', sync);
    sync();
  }

  function addTiles(map) {
    if (map.attributionControl) map.attributionControl.remove();
    const P = window.protomapsL;
    if (!P) return;
    const f = lumFlavor();
    P.leafletLayer({
      url: PMTILES, maxDataZoom: 15, maxZoom: 19, attribution: '',
      paintRules: lumPaintRules(P, f), labelRules: lumLabelRules(P, f), backgroundColor: f.background,
    }).addTo(map);
    addLandmarks(map);
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
  const ARROW_SPACING = [[15, 450], [13, 900], [0, 1800]];   // [min zoom, metres between arrows]

  function chevrons(map, poly) {
    const L = window.L;
    const cum = [0];
    for (let i = 1; i < poly.length; i++) {
      cum.push(cum[i - 1] + Math.hypot((poly[i][0] - poly[i - 1][0]) * 111000, (poly[i][1] - poly[i - 1][1]) * 98000));
    }
    const total = cum[cum.length - 1];
    const atDist = (d) => {
      d = Math.max(0, Math.min(total, d));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1] || 1, k = (d - cum[i - 1]) / seg;
      return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * k, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * k];
    };
    const layers = ARROW_SPACING.map(([minZoom, spacing]) => {
      const group = L.layerGroup();
      for (let d = spacing / 2; d < total; d += spacing) {
        const hd = bearing(atDist(d - 25), atDist(d + 25));
        if (hd === null) continue;
        L.marker(atDist(d), {
          icon: L.divIcon({
            className: 'mb-chev',
            html: '<svg viewBox="0 0 16 16" width="16" height="16" style="transform:rotate(' + hd.toFixed(0) + 'deg)">' +
              '<path d="M3.5 10.5 8 5l4.5 5.5" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
              '<path d="M3.5 10.5 8 5l4.5 5.5" fill="none" stroke="#042959" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          interactive: false,
          keyboard: false,
        }).addTo(group);
      }
      return { minZoom, group };
    });
    const sync = () => {
      const z = map.getZoom();
      const want = layers.find((l) => z >= l.minZoom);
      layers.forEach((l) => {
        const on = l === want;
        if (on && !map.hasLayer(l.group)) l.group.addTo(map);
        if (!on && map.hasLayer(l.group)) map.removeLayer(l.group);
      });
    };
    map.on('zoomend', sync);
    sync();
    return {
      destroy() {
        map.off('zoomend', sync);
        layers.forEach((l) => { if (map.hasLayer(l.group)) map.removeLayer(l.group); });
      },
    };
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
        arrows.destroy();
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
      move(ll2, heading) {
        m.setLatLng(ll2);
        if (heading === null || heading === undefined) return;
        const el = m.getElement();
        if (!el) return;
        hd += (((heading - hd) % 360) + 540) % 360 - 180;
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

  window.MBMap = { addTiles, route, bus, pointAt, headingAt, sliceBetween, bearing };
})();
