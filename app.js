// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
const S = {
  home: null, work: null,
  startPt: 'home',
  waypoints: [],
  schedMode: 'auto',
  route: null,
  routeData: null,
  trk: {
    active: false, delay: 0, _prevDelay: 0,
    startedAt: null, currentIdx: 0,
    wps: [],            // [{id, status, arrivedAt, leftAt, actualDelay}]
    timerInterval: null
  },
  setLocFor: null,
  addingPt: false,
  pendingCoords: null,
  map: null, markers: {}, routeLayer: null,
  previewMk: null,
  searchMarkers: [],   // markers shown for search results
  nid: 1,
  searchCache: {},
  sortable: null
};

const SEARCH_CACHE_MAX = 100;
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// ═══════════════════════════════════════════════
//  MAP INIT
// ═══════════════════════════════════════════════
function initMap() {
  // Fix broken default Leaflet markers when CSS is in a separate file
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  });

  S.map = L.map('map', { zoomControl: true }).setView([40.4168, -3.7038], 6);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · © <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19
  }).addTo(S.map);
  S.map.on('click', onMapClick);
  loadStorage();
}

function onMapClick(e) {
  const { lat, lng } = e.latlng;

  if (S.setLocFor) {
    const t = S.setLocFor;
    S.setLocFor = null;
    setCursor('');
    setBaseLoc(t, lat, lng);
    revGeo(lat, lng, name => {
      if (t === 'home') S.home.name = name; else S.work.name = name;
      updateBaseUI(t);
      saveStorage();
    });
    return;
  }

  if (S.addingPt) {
    const name = document.getElementById('npName').value.trim() || `Cliente ${S.nid}`;
    const dwell = parseDwell(document.getElementById('npDwell').value, 30);
    const arr = document.getElementById('npArrival').value || null;
    const openTime = parseTimeOrNull(document.getElementById('npOpen').value);
    const closeTime = parseTimeOrNull(document.getElementById('npClose').value);
    const openTime2 = parseTimeOrNull(document.getElementById('npOpen2').value);
    const closeTime2 = parseTimeOrNull(document.getElementById('npClose2').value);
    if ((openTime && closeTime && t2m(openTime) >= t2m(closeTime)) || (openTime2 && closeTime2 && t2m(openTime2) >= t2m(closeTime2))) {
      notify('El horario del cliente es inválido', 'error');
      return;
    }
    addWP({ lat, lng, name, dwell, desiredArrival: arr, openTime, closeTime, openTime2, closeTime2 });
    S.addingPt = false;
    setCursor('');
    document.getElementById('npName').value = '';
    document.getElementById('npDwell').value = '';
    document.getElementById('npArrival').value = '';
    document.getElementById('npOpen').value = '';
    document.getElementById('npClose').value = '';
    document.getElementById('npOpen2').value = '';
    document.getElementById('npClose2').value = '';
    notify('Punto añadido: ' + name, 'success');
    return;
  }
}

function setCursor(c) { document.getElementById('map').style.cursor = c; }

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDwell(raw, fallback = 30) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(480, Math.max(1, n));
}

function parseTimeOrNull(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  return t;
}

function fmtHM(mins) {
  const total = Math.max(0, Math.round(Number(mins) || 0));
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}h:${m}m`;
}

function parseOpeningHoursRange(raw) {
  if (!raw || typeof raw !== 'string') {
    return { openTime: null, closeTime: null, openTime2: null, closeTime2: null, openingHoursRaw: null };
  }
  const matches = [...raw.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)].slice(0, 2);
  if (!matches.length) {
    return { openTime: null, closeTime: null, openTime2: null, closeTime2: null, openingHoursRaw: raw };
  }
  const first = matches[0];
  const second = matches[1];
  return {
    openTime: first?.[1]?.padStart(5, '0') || null,
    closeTime: first?.[2]?.padStart(5, '0') || null,
    openTime2: second?.[1]?.padStart(5, '0') || null,
    closeTime2: second?.[2]?.padStart(5, '0') || null,
    openingHoursRaw: raw
  };
}

function getCustomerWindows(wp) {
  const windows = [];
  if (wp.openTime && wp.closeTime) {
    windows.push({ start: t2m(wp.openTime), end: t2m(wp.closeTime), label: `${wp.openTime}-${wp.closeTime}` });
  }
  if (wp.openTime2 && wp.closeTime2) {
    windows.push({ start: t2m(wp.openTime2), end: t2m(wp.closeTime2), label: `${wp.openTime2}-${wp.closeTime2}` });
  }
  return windows.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start < w.end).sort((a, b) => a.start - b.start);
}

function formatCustomerHours(wp) {
  const parts = [];
  if (wp.openTime && wp.closeTime) parts.push(`${wp.openTime}-${wp.closeTime}`);
  if (wp.openTime2 && wp.closeTime2) parts.push(`${wp.openTime2}-${wp.closeTime2}`);
  return parts.join(' · ');
}

function adjustArrivalToCustomerHours(arrival, dwell, wp) {
  const windows = getCustomerWindows(wp);
  if (!windows.length) return { arrival, conflict: null };

  for (const w of windows) {
    if (arrival <= w.start && (w.start + dwell) <= w.end) {
      return { arrival: w.start, conflict: null };
    }
    if (arrival >= w.start && arrival < w.end && (arrival + dwell) <= w.end) {
      return { arrival, conflict: null };
    }
  }

  const nextWindow = windows.find(w => arrival < w.start && (w.start + dwell) <= w.end);
  if (nextWindow) return { arrival: nextWindow.start, conflict: null };

  return { arrival, conflict: `Fuera de horario (${windows.map(w => w.label).join(' · ')})` };
}

function normalizeCache() {
  const now = Date.now();
  const keys = Object.keys(S.searchCache);
  keys.forEach(k => {
    const e = S.searchCache[k];
    if (!e || (now - e.ts) > SEARCH_CACHE_TTL_MS) delete S.searchCache[k];
  });
  const ordered = Object.entries(S.searchCache).sort((a, b) => a[1].ts - b[1].ts);
  while (ordered.length > SEARCH_CACHE_MAX) {
    const [k] = ordered.shift();
    delete S.searchCache[k];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function invalidateRoute() {
  S.route = null;
  S.routeData = null;
  const trackBtn = document.getElementById('trackBtn');
  if (trackBtn) trackBtn.style.display = 'none';
}

async function fetchJsonWithRetry(url, opts = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) {
        if (RETRYABLE_STATUS.has(r.status) && attempt < retries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr || new Error('network error');
}

async function fetchTextWithRetry(url, opts = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) {
        if (RETRYABLE_STATUS.has(r.status) && attempt < retries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      return { text: await r.text(), url: r.url };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr || new Error('network error');
}

// ═══════════════════════════════════════════════
//  BASE LOCATIONS (Home / Work)
// ═══════════════════════════════════════════════
function startSetLoc(type) {
  S.setLocFor = type;
  document.getElementById('locTitle').textContent = type === 'home' ? '🏠 Establecer Casa' : '💼 Establecer Trabajo';
  document.getElementById('locInput').value = '';
  document.getElementById('locResults').style.display = 'none';
  document.getElementById('locResults').innerHTML = '';
  document.getElementById('locModal').style.display = 'flex';
}

function closeLocModal() {
  document.getElementById('locModal').style.display = 'none';
}

function setBaseLoc(type, lat, lng, name) {
  const obj = { lat, lng, name: name || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  if (type === 'home') S.home = obj; else S.work = obj;
  invalidateRoute();
  updateBaseUI(type);
  setMk(type, lat, lng, type === 'home' ? '🏠' : '💼', type === 'home' ? '#2563eb' : '#7c3aed');
  S.map.setView([lat, lng], 14);
  saveStorage();
}

function updateBaseUI(type) {
  const obj = type === 'home' ? S.home : S.work;
  const sfx = type === 'home' ? 'home' : 'work';
  document.getElementById(sfx + 'Name').textContent = obj ? obj.name : (type === 'home' ? 'Establecer Casa' : 'Establecer Trabajo');
  document.getElementById(sfx + 'Coords').textContent = obj ? `${obj.lat.toFixed(5)}, ${obj.lng.toFixed(5)}` : '';
  document.getElementById(sfx + 'Btn').classList.toggle('set', !!obj);
}

function setStart(type) {
  S.startPt = type;
  invalidateRoute();
  document.getElementById('sp-home').classList.toggle('on', type === 'home');
  document.getElementById('sp-work').classList.toggle('on', type === 'work');
  saveStorage();
}

// ═══════════════════════════════════════════════
//  MARKERS
// ═══════════════════════════════════════════════

// Search result marker: small numbered circle (purple, distinct from waypoints)
function mkSearchIcon(num, highlight = false) {
  const bg = highlight ? '#7c3aed' : '#6d28d9';
  const size = highlight ? 28 : 24;
  return L.divIcon({
    html: `<div style="
      background:${bg};color:#fff;
      width:${size}px;height:${size}px;
      border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:800;
      box-shadow:0 2px 6px rgba(0,0,0,.4);
      border:2px solid #fff;
      transition:all .15s;
    ">${num}</div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -(size/2 + 4)],
    className: ''
  });
}

function clearSearchMarkers() {
  S.searchMarkers.forEach(m => S.map.removeLayer(m));
  S.searchMarkers = [];
}

function resetBusinessSearchUI() {
  clearSearchMarkers();
  const box = document.getElementById('bizResults');
  if (box) {
    box.style.display = 'none';
    box.innerHTML = '';
    box._results = [];
  }
  const input = document.getElementById('bizInput');
  if (input) input.value = '';
  const type = document.getElementById('bizType');
  if (type) type.value = '';
  const scope = document.getElementById('bizScope');
  if (scope) scope.value = 'here';
}

function showSearchResultsOnMap(results, onAddFn) {
  clearSearchMarkers();
  if (!results?.length) return;

  const bounds = [];
  results.slice(0, 6).forEach((r, i) => {
    const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
    if (isNaN(lat) || isNaN(lng)) return;
    const name = r.display_name?.split(',')[0] || '';
    const sub  = r.display_name?.split(',').slice(1, 3).join(',').trim() || '';

    const m = L.marker([lat, lng], { icon: mkSearchIcon(i + 1) })
      .addTo(S.map)
      .bindPopup(`
        <div style="min-width:160px;font-size:.82rem">
          <b>${esc(name)}</b>
          ${sub ? `<div style="color:#6b7280;font-size:.75rem;margin-top:2px">${esc(sub)}</div>` : ''}
          <button onclick="(${onAddFn.toString()})(${lat},${lng},${JSON.stringify(name).replace(/"/g,'&quot;')})"
            style="margin-top:7px;padding:4px 10px;background:#2563eb;color:#fff;border:none;
            border-radius:5px;cursor:pointer;font-size:.75rem;width:100%">
            ➕ Añadir a ruta
          </button>
        </div>`);

    S.searchMarkers.push(m);
    bounds.push([lat, lng]);
  });

  if (bounds.length > 1) S.map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 16 });
  else if (bounds.length === 1) S.map.setView(bounds[0], 15);
}

function mkIcon(label, color, isEmoji) {
  const inner = isEmoji
    ? `<span style="transform:rotate(45deg);font-size:14px">${label}</span>`
    : `<span style="transform:rotate(45deg);font-size:12px;font-weight:800">${label}</span>`;
  return L.divIcon({
    html: `<div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 7px rgba(0,0,0,.35);border:2px solid #fff">${inner}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -32], className: ''
  });
}

function setMk(id, lat, lng, label, color, isEmoji = true, popup) {
  if (S.markers[id]) S.map.removeLayer(S.markers[id]);
  const m = L.marker([lat, lng], { icon: mkIcon(label, color, isEmoji) }).addTo(S.map);
  if (popup) m.bindPopup(popup);
  S.markers[id] = m;
  return m;
}

function rmMk(id) {
  if (S.markers[id]) { S.map.removeLayer(S.markers[id]); delete S.markers[id]; }
}

function wpTrkStatus(id) {
  const tw = S.trk.wps.find(w => w.id === id);
  return tw?.status || 'pending';
}

function addWPMarker(wp) {
  const idx   = S.waypoints.indexOf(wp) + 1;
  const trkSt = wpTrkStatus(wp.id);
  const color = trkSt === 'done' ? '#6b7280' : trkSt === 'at_client' ? '#16a34a' : '#ea580c';
  const m = setMk('wp_' + wp.id, wp.lat, wp.lng, idx, color, false);
  m.options.draggable = true;
  m.dragging && m.dragging.enable();

  const popContent = () => `
    <div style="min-width:160px;font-size:.82rem">
      <b>${esc(wp.name)}</b><br>
      <span style="color:#6b7280">Estancia: ${fmtHM(wp.dwell)}</span>
      ${wp.desiredArrival ? `<br><span style="color:#2563eb">Llegar: ${esc(wp.desiredArrival)}</span>` : ''}
      ${formatCustomerHours(wp) ? `<br><span style="color:#0f766e">Horario: ${esc(formatCustomerHours(wp))}</span>` : ''}
      ${wp.plannedArrival ? `<br><span style="color:#374151">Previsto: ${esc(wp.plannedArrival)} – ${esc(wp.plannedDeparture)}</span>` : ''}
      ${wp.scheduleConflict ? `<br><span style="color:#b45309">${esc(wp.scheduleConflict)}</span>` : ''}
      <div style="margin-top:6px;display:flex;gap:4px">
        <button onclick="editWP(${wp.id})" style="padding:3px 8px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.72rem">Editar</button>
      </div>
    </div>`;

  m.bindPopup(popContent());
  m.on('click', () => m.setPopupContent(popContent()));
  m.on('dragend', ev => {
    wp.lat = ev.target.getLatLng().lat;
    wp.lng = ev.target.getLatLng().lng;
    invalidateRoute();
    saveStorage();
  });
}

// ═══════════════════════════════════════════════
//  GEOCODING (Nominatim)
// ═══════════════════════════════════════════════

// Viewbox from current map view (expanded 50% to bias without being too strict)
function mapViewbox() {
  if (!S.map) return '';
  const b = S.map.getBounds().pad(0.5);
  return `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
}

// Detect country code from home/work coordinates
function countryHint() {
  const ref = S.home || S.work;
  if (!ref) return '';
  // Spain: lat 36-44, lng -10..5
  if (ref.lat >= 35 && ref.lat <= 44 && ref.lng >= -10 && ref.lng <= 5) return 'es';
  // Portugal
  if (ref.lat >= 37 && ref.lat <= 42 && ref.lng >= -10 && ref.lng <= -6) return 'pt';
  // France
  if (ref.lat >= 42 && ref.lat <= 51 && ref.lng >= -5 && ref.lng <= 10) return 'fr';
  return '';
}

async function nominatim(q, opts = {}) {
  // Geographic bias: use current map viewbox so results are near where you're working
  const vb = opts.viewbox !== undefined ? opts.viewbox : mapViewbox();
  const cc = opts.countrycodes !== undefined ? opts.countrycodes : countryHint();
  const vbParam = vb ? `&viewbox=${encodeURIComponent(vb)}` : '';
  const ccParam = cc ? `&countrycodes=${cc}` : '';
  // bounded=1 restricts strictly to viewbox; omit it so we bias but don't hide all results
  const key = `nom|${q.trim().toLowerCase()}|${vb}|${cc}`;
  normalizeCache();
  const cached = S.searchCache[key];
  if (cached) return cached.data;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6${vbParam}${ccParam}`;
    const d = await fetchJsonWithRetry(url, {
      headers: { 'Accept-Language': 'es', 'User-Agent': 'RutaRapida/1.0' }
    });
    S.searchCache[key] = { ts: Date.now(), data: d };
    return d;
  } catch { return []; }
}

const BIZ_TYPE_ALIASES = {
  restaurant: ['restaurant', 'restaurante', 'comida'],
  cafe: ['cafe', 'cafeteria', 'coffee'],
  supermarket: ['supermarket', 'supermercado', 'market'],
  pharmacy: ['pharmacy', 'farmacia'],
  bank: ['bank', 'banco', 'atm'],
  hospital: ['hospital', 'urgencias'],
  clinic: ['clinic', 'clinica', 'centro medico'],
  hardware: ['hardware', 'ferreteria', 'bricolaje'],
  car_repair: ['car repair', 'taller', 'mecanico'],
  bakery: ['bakery', 'panaderia', 'pasteleria'],
  convenience: ['convenience', 'tienda', 'ultramarinos'],
  hairdresser: ['hairdresser', 'peluqueria', 'barberia'],
  dentist: ['dentist', 'dentista', 'clinica dental'],
  veterinary: ['veterinary', 'veterinario', 'clinica veterinaria'],
  post_office: ['post office', 'correos']
};

function buildBizQueries(name, type) {
  const clean = (name || '').trim();
  const aliases = type ? (BIZ_TYPE_ALIASES[type] || [type]) : [];
  const out = [];

  if (clean && aliases.length) {
    aliases.forEach(a => out.push(`${clean} ${a}`));
    aliases.forEach(a => out.push(`${a} ${clean}`));
  }
  if (clean) out.push(clean);
  aliases.forEach(a => out.push(a));

  const uniq = [];
  const seen = new Set();
  out.forEach(q => {
    const k = q.toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    uniq.push(q);
  });
  return uniq.slice(0, 8);
}

function dedupeBizResults(list) {
  const seen = new Set();
  const out = [];
  list.forEach(r => {
    const key = `${r.osm_type || ''}:${r.osm_id || ''}:${r.lat || ''}:${r.lon || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  });
  return out;
}

async function nominatimBiz(q, limit = 10, opts = {}) {
  const bounded = opts.bounded ? '1' : '0';
  const centerBoost = opts.centerBoost ? '&extratags=1' : '';
  const key = `biz|${q.trim().toLowerCase()}|${limit}|${bounded}|${opts.zoom || 0}`;
  normalizeCache();
  const cached = S.searchCache[key];
  if (cached) return cached.data;
  try {
    const b = S.map.getBounds();
    const viewbox = `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
    const zoomPart = Number.isFinite(opts.zoom) ? `&zoom=${opts.zoom}` : '';
    const boundedPart = opts.bounded ? '&bounded=1' : '';
    const viewboxPart = opts.useViewbox ? `&viewbox=${encodeURIComponent(viewbox)}` : '';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${limit}${boundedPart}${viewboxPart}&addressdetails=1&extratags=1${centerBoost}${zoomPart}`;
    const d = await fetchJsonWithRetry(
      url,
      { headers: { 'Accept-Language': 'es', 'User-Agent': 'RutaRapida/1.0' } }
    );
    S.searchCache[key] = { ts: Date.now(), data: d };
    return d;
  } catch {
    return [];
  }
}

async function revGeo(lat, lng, cb) {
  try {
    const d = await fetchJsonWithRetry(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`, {
      headers: { 'Accept-Language': 'es', 'User-Agent': 'RutaRapida/1.0' }
    });
    cb(d.address?.road || d.address?.suburb || d.display_name?.split(',')[0] || `${lat.toFixed(4)},${lng.toFixed(4)}`);
  } catch { cb(`${lat.toFixed(4)},${lng.toFixed(4)}`); }
}

async function searchPlace() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  const res = await nominatim(q);
  const box = document.getElementById('searchResults');
  box.style.display = 'block';
  if (!res.length) {
    clearSearchMarkers();
    box.innerHTML = '<div class="sres-item" style="color:#6b7280">Sin resultados en esta zona. Mueve el mapa a la zona correcta y vuelve a buscar.</div>';
    return;
  }
  // Show numbered markers on map for all results
  showSearchResultsOnMap(res, addSearchResultAsPoint);
  // List with matching numbers
  box.innerHTML = res.slice(0, 6).map((r, i) =>
    `<div class="sres-item" onclick="pickSearch(${r.lat},${r.lon},${i})"
      onmouseenter="highlightSearchMk(${i})" onmouseleave="unhighlightSearchMk(${i})">
      <span style="display:inline-flex;align-items:center;justify-content:center;
        width:18px;height:18px;border-radius:50%;background:#6d28d9;color:#fff;
        font-size:10px;font-weight:800;margin-right:6px;flex-shrink:0">${i+1}</span>
      <span>
        <div class="sres-main">${esc(r.display_name.split(',')[0])}</div>
        <div class="sres-sub">${esc(r.display_name.split(',').slice(1, 3).join(',').trim())}</div>
      </span>
    </div>`).join('');
  box._results = res;
}

function pickSearch(lat, lng, i) {
  document.getElementById('searchResults').style.display = 'none';
  // Zoom to selected and open its popup
  S.map.setView([lat, lng], 16);
  if (S.searchMarkers[i]) S.searchMarkers[i].openPopup();
}

function highlightSearchMk(i) {
  if (S.searchMarkers[i]) S.searchMarkers[i].setIcon(mkSearchIcon(i + 1, true));
}
function unhighlightSearchMk(i) {
  if (S.searchMarkers[i]) S.searchMarkers[i].setIcon(mkSearchIcon(i + 1, false));
}

function addSearchResultAsPoint(lat, lng, name) {
  clearSearchMarkers();
  document.getElementById('searchResults').style.display = 'none';
  S.pendingCoords = { lat: parseFloat(lat), lng: parseFloat(lng), name: String(name || 'Lugar') };
  document.getElementById('eId').value = '__new__';
  document.getElementById('editTitle').textContent = '📍 Nuevo punto';
  document.getElementById('eName').value = S.pendingCoords.name;
  document.getElementById('eDwell').value = '30';
  document.getElementById('eArrival').value = '';
  document.getElementById('eOpen').value = S.pendingCoords.openTime || '';
  document.getElementById('eClose').value = S.pendingCoords.closeTime || '';
  document.getElementById('eOpen2').value = S.pendingCoords.openTime2 || '';
  document.getElementById('eClose2').value = S.pendingCoords.closeTime2 || '';
  document.getElementById('editModal').style.display = 'flex';
  showTab('points');
}

async function searchBusiness() {
  const name = document.getElementById('bizInput').value.trim();
  const type = document.getElementById('bizType').value;
  const scope = document.getElementById('bizScope')?.value || 'here';
  const queries = buildBizQueries(name, type);
  if (!queries.length) {
    notify('Escribe un nombre o selecciona un tipo de comercio', 'error');
    return;
  }

  notify('Buscando comercios…');
  let found = [];

  if (scope === 'here') {
    // Pass 1: query set, bounded in current viewport
    for (const q of queries) {
      const r = await nominatimBiz(q, 10, { bounded: true, useViewbox: true, zoom: 18 });
      found = dedupeBizResults(found.concat(r));
      if (found.length >= 10) break;
    }

    // Pass 2: same query set without bounded restriction
    if (found.length < 6) {
      for (const q of queries) {
        const r = await nominatimBiz(q, 10, { bounded: false, useViewbox: false });
        found = dedupeBizResults(found.concat(r));
        if (found.length >= 12) break;
      }
    }

    // Pass 3: try simpler type aliases if still low
    if (found.length < 4 && type && BIZ_TYPE_ALIASES[type]) {
      for (const alias of BIZ_TYPE_ALIASES[type]) {
        const r = await nominatimBiz(alias, 8, { bounded: true, useViewbox: true });
        found = dedupeBizResults(found.concat(r));
        if (found.length >= 12) break;
      }
    }
  } else {
    // Global mode: never bounded to current map view
    for (const q of queries) {
      const r = await nominatimBiz(q, 12, { bounded: false, useViewbox: false });
      found = dedupeBizResults(found.concat(r));
      if (found.length >= 12) break;
    }

    if (found.length < 5 && type && BIZ_TYPE_ALIASES[type]) {
      for (const alias of BIZ_TYPE_ALIASES[type]) {
        const r = await nominatimBiz(alias, 10, { bounded: false, useViewbox: false });
        found = dedupeBizResults(found.concat(r));
        if (found.length >= 12) break;
      }
    }
  }

  const res = found;
  const box = document.getElementById('bizResults');
  box.style.display = 'block';
  if (!res.length) {
    box.innerHTML = '<div class="sres-item">Sin resultados en el área visible del mapa</div>';
    return;
  }

  const sliced = res.slice(0, 12);
  box._results = sliced;

  // Show all results as markers on map
  showSearchResultsOnMap(sliced, addBizAsPoint);

  box.innerHTML = sliced.map((r, i) => {
    const main = esc(r.display_name.split(',')[0]);
    const sub = esc(r.display_name.split(',').slice(1, 3).join(',').trim());
    const hours = parseOpeningHoursRange(r?.extratags?.opening_hours || '');
    return `<div class="sres-item" onclick="pickBusiness(${r.lat},${r.lon},${i})"
      onmouseenter="highlightSearchMk(${i})" onmouseleave="unhighlightSearchMk(${i})">
      <span style="display:inline-flex;align-items:center;justify-content:center;
        width:18px;height:18px;border-radius:50%;background:#6d28d9;color:#fff;
        font-size:10px;font-weight:800;margin-right:6px;flex-shrink:0">${i+1}</span>
      <span>
        <div class="sres-main">${main}</div>
        <div class="sres-sub">${sub}${hours.openTime && hours.closeTime ? ` · ${esc(hours.openTime)}-${esc(hours.closeTime)}` : ''}</div>
      </span>
    </div>`;
  }).join('');
}

function pickBusiness(lat, lng, i) {
  const box = document.getElementById('bizResults');
  const item = box._results?.[i];
  if (!item) return;
  S.map.setView([parseFloat(lat), parseFloat(lng)], 16);
  if (S.searchMarkers[i]) S.searchMarkers[i].openPopup();
}

function addBizAsPoint(lat, lng, name) {
  const box = document.getElementById('bizResults');
  const item = (box?._results || []).find(r =>
    Number.parseFloat(r.lat) === Number.parseFloat(lat) &&
    Number.parseFloat(r.lon) === Number.parseFloat(lng) &&
    (r.display_name?.split(',')[0] || 'Comercio') === String(name || 'Comercio')
  );
  const hours = parseOpeningHoursRange(item?.extratags?.opening_hours || '');
  S.pendingCoords = {
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    name: String(name || 'Comercio'),
    openTime: hours.openTime,
    closeTime: hours.closeTime,
    openTime2: hours.openTime2,
    closeTime2: hours.closeTime2,
    openingHoursRaw: hours.openingHoursRaw
  };
  document.getElementById('eId').value = '__new__';
  document.getElementById('editTitle').textContent = '📍 Nuevo punto';
  document.getElementById('eName').value = S.pendingCoords.name;
  document.getElementById('eDwell').value = '30';
  document.getElementById('eArrival').value = '';
  document.getElementById('eOpen').value = S.pendingCoords.openTime || '';
  document.getElementById('eClose').value = S.pendingCoords.closeTime || '';
  document.getElementById('eOpen2').value = S.pendingCoords.openTime2 || '';
  document.getElementById('eClose2').value = S.pendingCoords.closeTime2 || '';
  document.getElementById('editModal').style.display = 'flex';
}

async function searchLoc() {
  const q = document.getElementById('locInput').value.trim();
  if (!q) return;
  // For base locations (home/work), search without strict viewbox so user can set a brand-new location
  // But still use country hint if available
  const cc = countryHint();
  const res = await nominatim(q, { viewbox: '', countrycodes: cc });
  const box = document.getElementById('locResults');
  box.style.display = 'block';
  if (!res.length) { box.innerHTML = '<div class="sres-item" style="color:#6b7280">Sin resultados. Intenta con más detalle (ciudad, calle...)</div>'; return; }
  box.innerHTML = res.slice(0,6).map((r,i) =>
    `<div class="sres-item" onclick="pickLoc(${r.lat},${r.lon},${i})">
      <div class="sres-main">${esc(r.display_name.split(',')[0])}</div>
      <div class="sres-sub">${esc(r.display_name.split(',').slice(1,3).join(',').trim())}</div>
    </div>`).join('');
  box._results = res;
}

function pickLoc(lat, lng, i) {
  const name = document.getElementById('locResults')._results?.[i]?.display_name?.split(',')[0] || '';
  const t = S.setLocFor;
  closeLocModal();
  S.setLocFor = null;
  if (t) setBaseLoc(t, parseFloat(lat), parseFloat(lng), name);
}

// ═══════════════════════════════════════════════
//  URL PARSING (Google Maps / Waze)
// ═══════════════════════════════════════════════
async function parseUrl() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { notify('Pega una URL primero', 'error'); return; }

  notify('Procesando URL…');
  let coords = extractCoords(url);

  if (!coords && isShortUrl(url)) {
    notify('URL corta detectada, intentando resolver…');
    coords = await resolveShort(url);
  }

  if (!coords?.lat) {
    // Try as search query
    if (coords?.q) {
      notify('Buscando por nombre…');
      const res = await nominatim(coords.q);
      if (res.length) {
        coords = { lat: parseFloat(res[0].lat), lng: parseFloat(res[0].lon), name: res[0].display_name.split(',')[0] };
      } else {
        notify('No se encontraron coordenadas. Abre el enlace en Google Maps y pega la URL larga del navegador.', 'error');
        return;
      }
    } else {
      if (isShortUrl(url)) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      }
      notify('No se pudo resolver automáticamente. Se abrió el enlace: copia la URL larga final y pégala aquí.', 'error');
      return;
    }
  }

  // Open edit modal to complete info
  S.pendingCoords = coords;
  document.getElementById('eId').value = '__new__';
  document.getElementById('editTitle').textContent = '📍 Nuevo punto';
  document.getElementById('eName').value = coords.name || '';
  document.getElementById('eDwell').value = '30';
  document.getElementById('eArrival').value = '';
  document.getElementById('editModal').style.display = 'flex';
  document.getElementById('urlInput').value = '';
}

function isShortUrl(url) {
  return /goo\.gl|maps\.app\.goo\.gl|bit\.ly/i.test(url);
}

function parseFreeCoords(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();

  const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  m = s.match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  m = s.match(/lat(?:itude)?\s*[:=]\s*(-?\d+(?:\.\d+)?).{0,20}lon(?:gitude)?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i)
    || s.match(/lon(?:gitude)?\s*[:=]\s*(-?\d+(?:\.\d+)?).{0,20}lat(?:itude)?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    const firstLat = /lat/i.test(s.slice(0, s.indexOf(m[1]) + m[1].length));
    const lat = firstLat ? a : b;
    const lng = firstLat ? b : a;
    if (inRange(lat, lng)) return { lat, lng };
  }

  return null;
}

function extractCoords(url) {
  if (!url || typeof url !== 'string') return null;
  const free = parseFreeCoords(url);
  if (free) return free;
  let m;

  // Try nested URL parameters first (common in maps.app.goo.gl dynamic links)
  try {
    const u = new URL(url);
    const nested = u.searchParams.get('link') || u.searchParams.get('url') || u.searchParams.get('q');
    if (nested && /^https?:/i.test(nested)) {
      const dec = decodeURIComponent(nested);
      const fromNested = extractCoords(dec);
      if (fromNested) return fromNested;
    }
  } catch {}

  // Extract place name from /place/Name/ segment (used as fallback name)
  let name = '';
  const placeM = url.match(/\/place\/([^/@?]+)/);
  if (placeM) {
    name = decodeURIComponent(placeM[1].replace(/\+/g, ' ')).split(',')[0].trim();
  }

  // PRIORITY 1: Google Maps data encoding !3d{lat}!4d{lng}
  // This is the actual place pin — always more accurate than the @viewport center
  m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  // Alternative Google encoding
  m = url.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (m) return { lat: +m[2], lng: +m[1], name };

  // PRIORITY 2: Explicit coord params ?q=lat,lng or ?ll=lat,lng
  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  m = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&]destination=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  // PRIORITY 3: Waze latlng / navigate params
  m = url.match(/[?&]latlng=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  m = url.match(/navigate=yes&ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  // PRIORITY 4: @lat,lng viewport center (less precise for places, use as last coord resort)
  m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  // PRIORITY 5: no coords — fall back to place name search
  if (name) return { q: name, name };

  m = url.match(/[?&]q=([^&]+)/);
  if (m && !/^\d/.test(m[1])) return { q: decodeURIComponent(m[1].replace(/\+/g, ' ')) };

  return null;
}

function findMapsUrlInText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  const m = cleaned.match(/https:\/\/(?:www\.)?google\.[^/\s]+\/maps[^\s"'<>]*/i)
    || cleaned.match(/https:\/\/maps\.google\.[^/\s]+\/[^\s"'<>]*/i)
    || cleaned.match(/https:\/\/www\.google\.com\/maps[^\s"'<>]*/i);
  return m ? m[0] : null;
}

async function resolveShort(url) {
  const tryExtract = (rawUrl, body) => {
    const fromUrl = extractCoords(rawUrl);
    if (fromUrl) return fromUrl;

    const embedded = findMapsUrlInText(body);
    if (embedded) {
      const fromEmbedded = extractCoords(embedded);
      if (fromEmbedded) return fromEmbedded;
    }
    return null;
  };

  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, '')}`
  ];

  for (const p of proxies) {
    try {
      const r = await fetchTextWithRetry(p, { signal: AbortSignal.timeout(6000) }, 1);
      const coords = tryExtract(r.url, r.text);
      if (coords) return coords;
    } catch {}
  }

  // Fallback: algunos enlaces cortos traen querystring con un destino embebido.
  try {
    const u = new URL(url);
    const nested = u.searchParams.get('link') || u.searchParams.get('url') || u.searchParams.get('q');
    if (nested) {
      const dec = decodeURIComponent(nested);
      const coords = extractCoords(dec);
      if (coords) return coords;
    }
  } catch {}

  return null;
}

// ═══════════════════════════════════════════════
//  WAYPOINT MANAGEMENT
// ═══════════════════════════════════════════════
function addWP({ lat, lng, name, dwell, desiredArrival, openTime, closeTime, openTime2, closeTime2, openingHoursRaw }) {
  const wp = {
    id: S.nid++, lat, lng,
    name: name || `Cliente ${S.nid}`,
    dwell: parseDwell(dwell, 30),
    desiredArrival: desiredArrival || null,
    openTime: parseTimeOrNull(openTime),
    closeTime: parseTimeOrNull(closeTime),
    openTime2: parseTimeOrNull(openTime2),
    closeTime2: parseTimeOrNull(closeTime2),
    openingHoursRaw: openingHoursRaw || null,
    plannedArrival: null, plannedDeparture: null, actualDelay: null,
    scheduleConflict: null
  };
  S.waypoints.push(wp);
  invalidateRoute();
  addWPMarker(wp);
  renderWPs();
  saveStorage();
  showTab('points');
  return wp;
}

function startAddPoint() {
  const name = document.getElementById('npName').value.trim();
  if (!name) { notify('Escribe el nombre del punto primero', 'error'); document.getElementById('npName').focus(); return; }
  S.addingPt = true;
  setCursor('crosshair');
  notify('Haz clic en el mapa para colocar el punto');
}

function editWP(id) {
  const wp = S.waypoints.find(w => w.id === id);
  if (!wp) return;
  S.pendingCoords = null;
  document.getElementById('eId').value = id;
  document.getElementById('editTitle').textContent = '✏️ Editar punto';
  document.getElementById('eName').value = wp.name;
  document.getElementById('eDwell').value = wp.dwell;
  document.getElementById('eArrival').value = wp.desiredArrival || '';
  document.getElementById('eOpen').value = wp.openTime || '';
  document.getElementById('eClose').value = wp.closeTime || '';
  document.getElementById('eOpen2').value = wp.openTime2 || '';
  document.getElementById('eClose2').value = wp.closeTime2 || '';
  document.getElementById('editModal').style.display = 'flex';
}

function saveEdit() {
  const id = document.getElementById('eId').value;
  const name = document.getElementById('eName').value.trim() || 'Cliente';
  const dwell = parseDwell(document.getElementById('eDwell').value, 30);
  const arr = document.getElementById('eArrival').value || null;
  const openTime = parseTimeOrNull(document.getElementById('eOpen').value);
  const closeTime = parseTimeOrNull(document.getElementById('eClose').value);
  const openTime2 = parseTimeOrNull(document.getElementById('eOpen2').value);
  const closeTime2 = parseTimeOrNull(document.getElementById('eClose2').value);

  if ((openTime && closeTime && t2m(openTime) >= t2m(closeTime)) || (openTime2 && closeTime2 && t2m(openTime2) >= t2m(closeTime2))) {
    notify('El horario del cliente es inválido', 'error');
    return;
  }

  if (id === '__new__' && S.pendingCoords) {
    addWP({ ...S.pendingCoords, name, dwell, desiredArrival: arr, openTime, closeTime, openTime2, closeTime2 });
    S.pendingCoords = null;
  } else {
    const wp = S.waypoints.find(w => w.id === +id);
    if (wp) {
      wp.name = name;
      wp.dwell = dwell;
      wp.desiredArrival = arr;
      wp.openTime = openTime;
      wp.closeTime = closeTime;
      wp.openTime2 = openTime2;
      wp.closeTime2 = closeTime2;
      wp.scheduleConflict = null;
      invalidateRoute();
      addWPMarker(wp);
      renderWPs();
      saveStorage();
    }
  }
  closeModal();
}

function closeModal() {
  document.getElementById('editModal').style.display = 'none';
  S.pendingCoords = null;
}

function removeWP(id) {
  S.waypoints = S.waypoints.filter(w => w.id !== id);
  invalidateRoute();
  rmMk('wp_' + id);
  renderWPs();
  saveStorage();
}

function clearAll() {
  if (S.waypoints.length && !confirm('¿Eliminar todos los puntos?')) return;
  S.waypoints.forEach(w => rmMk('wp_' + w.id));
  S.waypoints = [];
  if (S.routeLayer) { S.map.removeLayer(S.routeLayer); S.routeLayer = null; }
  S.route = null;
  renderWPs();
  document.getElementById('routeEmpty').style.display = 'block';
  document.getElementById('routeResults').style.display = 'none';
  saveStorage();
}

function renderWPs() {
  const list = document.getElementById('wpList');
  document.getElementById('wpCount').textContent = S.waypoints.length;
  if (!S.waypoints.length) {
    if (S.sortable) {
      S.sortable.destroy();
      S.sortable = null;
    }
    list.innerHTML = '<div class="empty"><i class="fas fa-map-pin"></i>Añade puntos de ruta</div>';
    return;
  }

  list.innerHTML = S.waypoints.map((wp, i) => {
    const trkSt = wpTrkStatus(wp.id);
    const done  = trkSt === 'done';
    const tw    = S.trk.wps.find(w => w.id === wp.id);
    let status  = '';
    if (S.trk.active && done && tw?.actualDelay !== null && tw?.actualDelay !== undefined) {
      const d = tw.actualDelay;
      status = d > 5  ? `<span class="wp-status s-late">+${d}min tarde</span>`
             : d < -5 ? `<span class="wp-status s-early">${Math.abs(d)}min antes</span>`
             :           `<span class="wp-status s-ok">En hora</span>`;
    }
    const planned = wp.plannedArrival ? `<span class="badge bb">${esc(wp.plannedArrival)}</span>` : '';
    const fixed   = wp.desiredArrival ? `<span class="badge" style="background:#fef9c3;color:#854d0e">🎯 ${esc(wp.desiredArrival)}</span>` : '';
    const hoursText = formatCustomerHours(wp);
    const hours   = hoursText ? `<span class="badge" style="background:#ecfeff;color:#155e75">🕘 ${esc(hoursText)}</span>` : '';
    const conflict = wp.scheduleConflict ? `<span class="wp-status s-late">${esc(wp.scheduleConflict)}</span>` : '';
    const numBg   = done ? '#6b7280' : trkSt === 'at_client' ? '#16a34a' : '#ea580c';

    return `<div class="wp-item ${done ? 'done' : ''}" data-id="${wp.id}">
      <div class="wp-num" style="background:${numBg};cursor:${S.trk.active ? 'default' : 'grab'}" title="${S.trk.active ? '' : 'Arrastrar para reordenar'}">${done ? '✓' : i+1}</div>
      <div style="flex:1;min-width:0">
        <div class="wp-name" style="${done ? 'text-decoration:line-through;color:#6b7280' : ''}">${esc(wp.name)}</div>
        <div class="wp-meta">
          <span>⏱ ${fmtHM(wp.dwell)}</span>
          ${fixed}${planned}${hours}
        </div>
        ${status}${conflict}
      </div>
      <div class="wp-acts">
        ${!S.trk.active ? `<button class="btn bg bi bsm" onclick="editWP(${wp.id})" title="Editar"><i class="fas fa-edit"></i></button>
        <button class="btn bd bi bsm" onclick="removeWP(${wp.id})" title="Eliminar"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    </div>`;
  }).join('');

  // Rerender markers with updated numbers
  S.waypoints.forEach(wp => addWPMarker(wp));

  // Drag to reorder
  if (typeof Sortable !== 'undefined') {
    if (S.sortable) S.sortable.destroy();
    S.sortable = new Sortable(list, {
      animation: 150,
      handle: '.wp-num',
      onEnd: evt => {
        const [item] = S.waypoints.splice(evt.oldIndex, 1);
        S.waypoints.splice(evt.newIndex, 0, item);
        renderWPs();
        saveStorage();
      }
    });
  }

  document.getElementById('trackBtn').style.display = S.waypoints.length && S.route ? 'flex' : 'none';
}

// ═══════════════════════════════════════════════
//  SCHEDULE
// ═══════════════════════════════════════════════
function setMode(m) {
  S.schedMode = m;
  ['auto','split','cont'].forEach(x => document.getElementById('md-' + x).classList.toggle('on', x === m));
  document.getElementById('contCard').style.display = m === 'cont' ? 'block' : 'none';
}

function getSched() {
  return {
    mS: t2m(document.getElementById('mStart').value),
    mE: t2m(document.getElementById('mEnd').value),
    aS: t2m(document.getElementById('aStart').value),
    aE: t2m(document.getElementById('aEnd').value),
    cS: t2m(document.getElementById('cStart').value),
    cH: parseDwell(document.getElementById('cHours').value, 8),
    mode: S.schedMode
  };
}

function validateSched(sc) {
  if (![sc.mS, sc.mE, sc.aS, sc.aE, sc.cS].every(Number.isFinite)) return 'Horario inválido';
  if (sc.mS >= sc.mE) return 'La franja de mañana es inválida';
  if (sc.aS >= sc.aE) return 'La franja de tarde es inválida';
  if (sc.mode === 'split' && sc.mE > sc.aS) return 'Mañana y tarde se solapan';
  if (sc.cH < 4 || sc.cH > 12) return 'Las horas de jornada continua deben estar entre 4 y 12';
  return '';
}

function t2m(t) {
  if (!t || typeof t !== 'string' || !t.includes(':')) return NaN;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}
function m2t(m) {
  if (!Number.isFinite(m)) return '--:--';
  const day = 24 * 60;
  const n = ((Math.round(m) % day) + day) % day;
  return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
}
function fmtDur(m) { return fmtHM(m); }

function getEffectiveStartMin(sc, mode, now = nowMin()) {
  if (mode === 'cont') return Math.max(sc.cS, now);

  const baseStart = sc.mS;
  if (now <= baseStart) return baseStart;
  if (now < sc.mE) return now;
  if (now < sc.aS) return sc.aS;
  return Math.max(sc.aS, now);
}

function getRemainingAvailability(sc, mode, now = nowMin()) {
  if (mode === 'cont') {
    const contEnd = sc.cS + (sc.cH * 60);
    return Math.max(0, contEnd - Math.max(now, sc.cS));
  }

  const morningLeft = now < sc.mE ? Math.max(0, sc.mE - Math.max(now, sc.mS)) : 0;
  const afternoonLeft = now < sc.aE ? Math.max(0, sc.aE - Math.max(now, sc.aS)) : 0;
  return morningLeft + afternoonLeft;
}

// ═══════════════════════════════════════════════
//  ROUTE OPTIMIZATION
// ═══════════════════════════════════════════════
function haversine(a, b) {
  const R=6371, dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lng-a.lng)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function nearestNeighbor(origin, wps) {
  const visited = new Array(wps.length).fill(false);
  const route = [];
  let cur = origin;
  for (let s=0; s<wps.length; s++) {
    let best=-1, bestD=Infinity;
    wps.forEach((w,j) => { if (visited[j]) return; const d=haversine(cur,w); if(d<bestD){best=j;bestD=d;}});
    visited[best]=true; route.push(best); cur=wps[best];
  }
  return route;
}

function routeCost(order, origin, wps) {
  let c=0, prev=origin;
  for (const i of order) { c+=haversine(prev, wps[i]); prev=wps[i]; }
  return c;
}

function twoOpt(order, origin, wps) {
  let best=[...order], bestC=routeCost(best,origin,wps), improved=true;
  while (improved) {
    improved=false;
    for (let i=0;i<best.length-1;i++) {
      for (let j=i+2;j<best.length;j++) {
        const nr=[...best.slice(0,i+1),...best.slice(i+1,j+1).reverse(),...best.slice(j+1)];
        const nc=routeCost(nr,origin,wps);
        if (nc < bestC-0.001) { best=nr; bestC=nc; improved=true; }
      }
    }
  }
  return best;
}

async function getOsrmTable(origin, pts) {
  if (!pts.length) return null;
  const all = [origin, ...pts];
  const coords = all.map(p => `${p.lng},${p.lat}`).join(';');
  try {
    const d = await fetchJsonWithRetry(
      `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`,
      { signal: AbortSignal.timeout(10000) }
    );
    return Array.isArray(d.durations) ? d.durations : null;
  } catch {
    return null;
  }
}

function nearestNeighborMatrix(originToPts, matrixPts) {
  const n = originToPts.length;
  const visited = new Array(n).fill(false);
  const route = [];
  let cur = -1;
  for (let step = 0; step < n; step++) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const c = cur === -1 ? originToPts[j] : matrixPts[cur][j];
      if (Number.isFinite(c) && c < bestCost) {
        best = j;
        bestCost = c;
      }
    }
    if (best === -1) break;
    visited[best] = true;
    route.push(best);
    cur = best;
  }
  return route;
}

function routeCostMatrix(order, originToPts, matrixPts) {
  let c = 0;
  let prev = -1;
  for (const i of order) {
    c += prev === -1 ? originToPts[i] : matrixPts[prev][i];
    prev = i;
  }
  return c;
}

function twoOptMatrix(order, originToPts, matrixPts) {
  let best = [...order];
  let bestC = routeCostMatrix(best, originToPts, matrixPts);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const nr = [...best.slice(0, i + 1), ...best.slice(i + 1, j + 1).reverse(), ...best.slice(j + 1)];
        const nc = routeCostMatrix(nr, originToPts, matrixPts);
        if (nc < bestC - 0.001) {
          best = nr;
          bestC = nc;
          improved = true;
        }
      }
    }
  }
  return best;
}

async function getOptimizedWaypoints(origin, waypoints) {
  const fixed = waypoints.filter(w => w.desiredArrival).sort((a, b) => a.desiredArrival.localeCompare(b.desiredArrival));
  const flex = waypoints.filter(w => !w.desiredArrival);

  let optimized = flex;
  if (flex.length > 1) {
    const table = await getOsrmTable(origin, flex);
    if (table && table.length === flex.length + 1) {
      const originToPts = table[0].slice(1).map(v => (v || 0) / 60);
      const matrixPts = table.slice(1).map(r => r.slice(1).map(v => (v || 0) / 60));
      const nn = nearestNeighborMatrix(originToPts, matrixPts);
      const oo = twoOptMatrix(nn, originToPts, matrixPts);
      optimized = oo.map(i => flex[i]);
    } else {
      const nn = nearestNeighbor(origin, flex);
      const oo = twoOpt(nn, origin, flex);
      optimized = oo.map(i => flex[i]);
    }
  }

  if (!fixed.length) return optimized;

  const merged = [];
  let fi = 0;
  let li = 0;
  while (fi < fixed.length || li < optimized.length) {
    if (li < optimized.length && (fi >= fixed.length || li <= Math.floor(fi * optimized.length / Math.max(fixed.length, 1)))) {
      merged.push(optimized[li++]);
    } else if (fi < fixed.length) {
      merged.push(fixed[fi++]);
    }
  }
  return merged;
}

async function optimizeOrder() {
  if (S.waypoints.length < 2) { notify('Necesitas al menos 2 puntos', 'error'); return; }
  const origin = S.startPt==='home' ? S.home : S.work;
  if (!origin) { notify('Establece el punto de partida primero', 'error'); return; }

  notify('Optimizando orden…');
  S.waypoints = await getOptimizedWaypoints(origin, S.waypoints);

  invalidateRoute();
  renderWPs();
  saveStorage();
  notify('¡Orden optimizado!', 'success');
}

// ═══════════════════════════════════════════════
//  OSRM ROUTING
// ═══════════════════════════════════════════════
async function getOsrmRoute(pts) {
  if (pts.length < 2) return null;
  const coords = pts.map(p=>`${p.lng},${p.lat}`).join(';');
  try {
    const d = await fetchJsonWithRetry(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`,
      { signal: AbortSignal.timeout(10000) }
    );
    return d.code === 'Ok' ? d.routes[0] : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════
//  SCHEDULE CALCULATION
// ═══════════════════════════════════════════════
async function calcRoute() {
  if (!S.waypoints.length) { notify('Añade al menos un punto', 'error'); return; }
  const origin = S.startPt==='home' ? S.home : S.work;
  if (!origin) { notify(`Establece ${S.startPt==='home'?'la casa':'el trabajo'} primero`, 'error'); showTab('setup'); return; }

  const btn = document.getElementById('calcBtn');
  btn.innerHTML = '<span class="spin"></span> Calculando…'; btn.disabled = true;

  try {
    const sc = getSched();
    const schedErr = validateSched(sc);
    if (schedErr) {
      notify(schedErr, 'error');
      showTab('schedule');
      return;
    }
    const optimizedWaypoints = await getOptimizedWaypoints(origin, S.waypoints);
    S.waypoints = optimizedWaypoints;
    renderWPs();
    const allPts = [origin, ...optimizedWaypoints, origin];

    notify('Obteniendo ruta real (OSRM)…');
    const osrm = await getOsrmRoute(allPts);
    if (!osrm) notify('Sin conexión a OSRM. Usando estimación lineal.', 'error');

    const result = buildSchedule(optimizedWaypoints, origin, sc, osrm);
    S.route = result;
    S.routeData = { origin, osrm };

    renderRoute(result);
    if (osrm) drawRoute(osrm.geometry);
    else drawLines(allPts);

    showRecommendation(result, sc);
    resetBusinessSearchUI();
    renderWPs();
    showTab('route');
    document.getElementById('trackBtn').style.display = 'flex';
    saveStorage(); // persist route + updated plannedArrival times

  } finally {
    btn.innerHTML = '<i class="fas fa-route"></i> Calcular ruta óptima';
    btn.disabled = false;
  }
}

function buildSchedule(wps, origin, sc, osrm) {
  let mode = sc.mode;
  const now = nowMin();
  const totalDwell = wps.reduce((s,w) => s+w.dwell, 0);
  const morningDur = sc.mE - sc.mS;
  const afternoonDur = sc.aE - sc.aS;
  const totalAvail = morningDur + afternoonDur;
  const contDur = sc.cH * 60;

  // Build segment durations & distances
  const allPts = [origin, ...wps, origin];
  let segDur = [], segDist = [];
  if (osrm?.legs) {
    segDur = osrm.legs.map(l => Math.round(l.duration/60));
    segDist = osrm.legs.map(l => l.distance/1000);
  } else {
    for (let i=0;i<allPts.length-1;i++) {
      const d = haversine(allPts[i], allPts[i+1]);
      segDist.push(d);
      segDur.push(Math.round(d/0.55)); // ~33km/h avg urban
    }
  }

  const totalTravel = segDur.reduce((s,d)=>s+d,0);
  const totalWork = totalDwell + totalTravel;

  // Auto decide mode
  if (mode === 'auto') {
    const morningLeft = now < sc.mE ? Math.max(0, sc.mE - Math.max(now, sc.mS)) : 0;
    const contLeft = getRemainingAvailability(sc, 'cont', now);
    if (morningLeft > 0 && totalWork <= morningLeft) mode = 'morning';
    else if (contLeft > 0 && totalWork <= contLeft) mode = 'cont';
    else mode = 'split';
  }

  const effectiveStart = getEffectiveStartMin(sc, mode, now);
  const itin = [];
  let cur = effectiveStart;

  itin.push({ type:'start', name: origin===S.home?'Casa':'Trabajo', time:m2t(cur), icon:origin===S.home?'🏠':'💼', color:'#2563eb' });

  let usedBreak = mode !== 'split' || cur >= sc.aS;

  for (let i=0; i<wps.length; i++) {
    const wp = wps[i];
    const travel = segDur[i];
    let arrival = cur + travel;
    wp.scheduleConflict = null;

    // Respect desired arrival (special case): if user forces a time, ignore customer hours.
    if (wp.desiredArrival) {
      const desired = t2m(wp.desiredArrival);
      if (desired > arrival) arrival = desired;
    } else {
      const adjusted = adjustArrivalToCustomerHours(arrival, wp.dwell, wp);
      arrival = adjusted.arrival;
      wp.scheduleConflict = adjusted.conflict;
    }

    // Split mode: check if crossing break
    if ((mode==='split'||mode==='morning') && !usedBreak) {
      if (arrival >= sc.mE) {
        // Need to break
        itin.push({ type:'break', timeS:m2t(sc.mE), timeE:m2t(sc.aS) });
        cur = sc.aS;
        arrival = cur + travel;
        usedBreak = true;
      }
    }

    itin.push({ type:'travel', from: i===0?(origin===S.home?'Casa':'Trabajo'):wps[i-1].name, to:wp.name, dur:travel, dist:segDist[i] });

    const depart = arrival + wp.dwell;
    if (!wp.desiredArrival && !wp.scheduleConflict) {
      const windows = getCustomerWindows(wp);
      const fitsWindow = windows.length ? windows.some(w => arrival >= w.start && depart <= w.end) : true;
      if (!fitsWindow) {
        wp.scheduleConflict = `Fuera de horario (${formatCustomerHours(wp) || 'sin horario'})`;
      }
    }
    wp.plannedArrival = m2t(arrival);
    wp.plannedDeparture = m2t(depart);

    itin.push({ type:'wp', wp, arrival, depart, wpIdx:i+1 });
    cur = depart;
  }

  // Return
  const retDur = segDur[wps.length] || 0;
  const retDist = segDist[wps.length] || 0;
  if (retDur) itin.push({ type:'travel', from:wps[wps.length-1]?.name||'Inicio', to:origin===S.home?'Casa':'Trabajo', dur:retDur, dist:retDist });
  const endT = cur + retDur;
  itin.push({ type:'end', name:origin===S.home?'Casa':'Trabajo', time:m2t(endT), icon:origin===S.home?'🏠':'💼', color:'#16a34a' });

  const totalDist = segDist.reduce((s,d)=>s+d,0);
  return {
    itin, mode, totalDist, totalTravel, totalDwell, totalWork,
    startT: m2t(effectiveStart),
    endT: m2t(endT),
    effectiveStart,
    plannedFromNow: now,
    segDur: [...segDur],
    segDist: [...segDist]
  };
}

function showRecommendation(result, sc) {
  const box = document.getElementById('modeRec');
  const pct = Math.round(result.totalWork / (sc.mE-sc.mS+sc.aE-sc.aS) * 100);
  const conflicts = S.waypoints.filter(w => w.scheduleConflict).length;
  const msgs = {
    morning: `✅ Toda la ruta cabe en la <b>jornada de mañana</b> (${pct}% del tiempo). Tarde libre.`,
    split: `📅 Modo <b>partido</b> óptimo: ruta bien distribuida en mañana y tarde.`,
    cont: `⚡ Modo <b>seguido</b> recomendado: terminas ${result.endT} sin pausa de comida.`,
    auto: `🪄 Modo auto aplicado.`
  };
  box.innerHTML = (msgs[result.mode] || msgs.auto) + (conflicts ? ` <br><span style="color:#b45309;font-weight:700">AtenciÃ³n: ${conflicts} cliente(s) quedan fuera de horario.</span>` : '');
  box.style.display = 'block';
}

function refreshRouteTimingIfNeeded() {
  if (!S.route || !S.routeData || S.trk.active) return;
  const sc = getSched();
  if (validateSched(sc)) return;

  const refreshed = buildSchedule(S.waypoints, S.routeData.origin, sc, S.routeData.osrm);
  if (refreshed.startT === S.route.startT && refreshed.endT === S.route.endT) return;

  S.route = refreshed;
  renderRoute(refreshed);
  showRecommendation(refreshed, sc);
  renderWPs();
}

function renderRoute(r) {
  if (!r?.itin) return;   // guard: itin might not be built if origin is missing
  document.getElementById('routeEmpty').style.display = 'none';
  document.getElementById('routeResults').style.display = 'flex';

  document.getElementById('sDist').textContent = r.totalDist.toFixed(1)+' km';
  document.getElementById('sTravel').textContent = fmtDur(r.totalTravel);
  document.getElementById('sDwell').textContent = fmtDur(r.totalDwell);
  document.getElementById('sTotal').textContent = fmtDur(r.totalWork);
  document.getElementById('sStart').textContent = r.startT;
  document.getElementById('sEnd').textContent = r.endT;

  const sc = getSched();
  const totalAvail = (sc.mE-sc.mS) + (sc.aE-sc.aS);
  const pct = Math.min(100, Math.round(r.totalWork/totalAvail*100));
  document.getElementById('sProg').style.width = pct+'%';

  const rl = document.getElementById('routeList');
  rl.innerHTML = r.itin.map(step => {
    if (step.type === 'travel') {
      return `<div class="rstep" style="opacity:.65">
        <div class="rstep-icon" style="background:#f1f5f9;color:#6b7280">🚗</div>
        <div class="rstep-info">
          <div style="color:#6b7280;font-size:.78rem">${esc(step.from)} → ${esc(step.to)}</div>
          <div class="rstep-detail">${step.dist.toFixed(1)} km · ${step.dur} min</div>
        </div>
      </div>`;
    }
    if (step.type === 'break') {
      return `<div class="rsep">🍽️ Descanso ${step.timeS} – ${step.timeE}</div>`;
    }
    const colors = { start:'#2563eb', end:'#16a34a', wp:'#ea580c' };
    const bgs = { start:'#dbeafe', end:'#dcfce7', wp:'#ffedd5' };
    const t = step.type === 'wp' ? 'wp' : step.type;
    const icon = step.type==='wp' ? `<b>${step.wpIdx}</b>` : step.icon;
    const name = esc(step.type==='wp' ? step.wp.name : step.name);
    const detail = step.type==='wp'
      ? `⏱ ${fmtHM(step.wp.dwell)}${step.wp.desiredArrival ? ` · 🎯 ${esc(step.wp.desiredArrival)}` : ''}${formatCustomerHours(step.wp) ? ` · 🕘 ${esc(formatCustomerHours(step.wp))}` : ''}${step.wp.scheduleConflict ? ` · ${esc(step.wp.scheduleConflict)}` : ''}`
      : '';
    const time = step.type==='wp'
      ? `<div style="font-weight:700;color:var(--blue)">${m2t(step.arrival)}</div><div style="font-size:.7rem;color:var(--gray)">${m2t(step.depart)}</div>`
      : `<div style="font-weight:700;color:${colors[t]||'#2563eb'}">${step.time}</div>`;

    return `<div class="rstep">
      <div class="rstep-icon" style="background:${bgs[t]||'#f1f5f9'};color:${colors[t]||'#374151'}">${icon}</div>
      <div class="rstep-info"><div class="rstep-name">${name}</div><div class="rstep-detail">${detail}</div></div>
      <div class="rstep-time">${time}</div>
    </div>`;
  }).join('');
}

function drawRoute(geo) {
  if (S.routeLayer) S.map.removeLayer(S.routeLayer);
  S.routeLayer = L.geoJSON(geo, { style: { color:'#2563eb', weight:5, opacity:.72 } }).addTo(S.map);
  S.map.fitBounds(S.routeLayer.getBounds(), { padding:[20,20] });
}

function drawLines(pts) {
  if (S.routeLayer) S.map.removeLayer(S.routeLayer);
  S.routeLayer = L.polyline(pts.map(p=>[p.lat,p.lng]), { color:'#2563eb', weight:3, opacity:.6, dashArray:'8,8' }).addTo(S.map);
  S.map.fitBounds(S.routeLayer.getBounds(), { padding:[20,20] });
}

// ═══════════════════════════════════════════════
//  TRACKING  (panel dedicado, persistencia LS)
// ═══════════════════════════════════════════════

// Estados por waypoint: 'pending' | 'traveling' | 'at_client' | 'done'

function toggleTracking() {
  S.trk.active ? stopTracking() : startTracking();
}

function startTracking() {
  if (!S.route) { notify('Calcula la ruta primero', 'error'); return; }

  // Inicializar estado por waypoint
  S.trk.active    = true;
  S.trk.startedAt = Date.now();
  S.trk.delay     = 0;
  S.trk.currentIdx = 0;
  S.trk.wps = S.waypoints.map(wp => ({
    id:           wp.id,
    status:       'pending',   // pending | traveling | at_client | done
    arrivedAt:    null,        // timestamp ms
    leftAt:       null,        // timestamp ms
    actualDelay:  null         // minutes vs plan
  }));
  if (S.trk.wps.length) S.trk.wps[0].status = 'traveling';

  // Header button
  document.getElementById('trackBtn').innerHTML = '<i class="fas fa-stop" style="color:#ef4444"></i> Parar';
  // Show tracking tab
  document.getElementById('trkTabBtn').style.display = '';
  showTab('tracking');

  saveTrkState();   // save tracking FIRST before anything else
  saveStorage();    // then save full session (waypoints with times, route)
  renderTrkPanel();
  notify('¡Seguimiento iniciado!', 'success');
}

function stopTracking() {
  if (S.trk.timerInterval) { clearInterval(S.trk.timerInterval); S.trk.timerInterval = null; }
  S.trk.active = false;
  S.trk.wps = [];
  S.trk.currentIdx = 0;
  document.getElementById('trackBtn').innerHTML = '<i class="fas fa-play"></i> Iniciar';
  document.getElementById('trkTabBtn').style.display = 'none';
  renderWPs();
  showTab('route');
  saveStorage();
  notify('Jornada finalizada');
}

// Usuario pulsó "He llegado"
function trkArrived() {
  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = S.waypoints.find(w => w.id === tw?.id);
  if (!tw || !wp || tw.status === 'at_client') return;

  tw.status    = 'at_client';
  tw.arrivedAt = Date.now();

  // Calcular retraso real vs planificado
  const plannedMin = t2m(wp.plannedArrival || nowT());
  const actualMin  = nowMin();
  tw.actualDelay   = actualMin - plannedMin;
  S.trk.delay      = tw.actualDelay;

  // Propagar retraso a siguientes waypoints
  propagateDelay(S.trk.currentIdx, tw.actualDelay);

  // Iniciar timer de tiempo en cliente
  startClientTimer(tw.arrivedAt, wp.dwell);

  saveTrkState();
  saveStorage();
  renderTrkPanel();
}

// Usuario pulsó "He salido"
function trkLeft() {
  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = S.waypoints.find(w => w.id === tw?.id);
  if (!tw || !wp || tw.status !== 'at_client') return;

  if (S.trk.timerInterval) { clearInterval(S.trk.timerInterval); S.trk.timerInterval = null; }

  tw.status  = 'done';
  tw.leftAt  = Date.now();

  // Recalcular retraso desde la salida real (puede diferir del dwell previsto)
  const plannedDepMin = t2m(wp.plannedDeparture || nowT());
  const actualDepMin  = nowMin();
  const newDelay      = actualDepMin - plannedDepMin;
  S.trk.delay         = newDelay;
  propagateDelay(S.trk.currentIdx, newDelay);

  // Avanzar al siguiente waypoint
  S.trk.currentIdx++;
  if (S.trk.currentIdx < S.trk.wps.length) {
    S.trk.wps[S.trk.currentIdx].status = 'traveling';
  }

  // Actualizar marker del completado a verde
  addWPMarker(wp);

  saveTrkState();   // tracking state first
  saveStorage();
  renderTrkPanel();
  renderWPs();

  if (S.trk.currentIdx >= S.trk.wps.length) {
    notify('🎉 ¡Has completado todas las paradas!', 'success');
  }
}

function propagateDelay(fromIdx, delayMin) {
  const delta = delayMin - (S.trk._prevDelay || 0);
  S.trk._prevDelay = delayMin;
  for (let i = fromIdx + 1; i < S.waypoints.length; i++) {
    const wp = S.waypoints[i];
    if (wp.plannedArrival)   wp.plannedArrival   = m2t(t2m(wp.plannedArrival)   + delta);
    if (wp.plannedDeparture) wp.plannedDeparture = m2t(t2m(wp.plannedDeparture) + delta);
  }
  if (S.route) {
    S.route.endT = m2t(t2m(S.route.endT) + delta);
    const el = document.getElementById('sEnd');
    if (el) { el.textContent = S.route.endT; el.style.color = delayMin > 5 ? '#dc2626' : delayMin < -5 ? '#16a34a' : '#2563eb'; }
  }
}

function startClientTimer(arrivedAt, dwellMin) {
  if (S.trk.timerInterval) clearInterval(S.trk.timerInterval);
  const planned = dwellMin * 60 * 1000; // ms

  function tick() {
    const elapsed = Date.now() - arrivedAt;
    const elSec   = Math.floor(elapsed / 1000);
    const mm      = String(Math.floor(elSec / 60)).padStart(2, '0');
    const ss      = String(elSec % 60).padStart(2, '0');
    const el      = document.getElementById('trkTimer');
    if (el) el.textContent = `${mm}:${ss}`;

    const sub = document.getElementById('trkTimerSub');
    if (sub) {
      const remaining = Math.round((planned - elapsed) / 60000);
      if (remaining > 0) sub.textContent = `Quedan ~${fmtHM(remaining)} de los ${fmtHM(dwellMin)} previstos`;
      else sub.textContent = `⚠️ ${fmtHM(Math.abs(remaining))} sobre el tiempo previsto`;
    }
  }
  tick();
  S.trk.timerInterval = setInterval(tick, 1000);
}

// Renderiza el panel completo de seguimiento
function renderTrkPanel() {
  const total   = S.trk.wps.length;
  const done    = S.trk.wps.filter(w => w.status === 'done').length;
  const pct     = total ? Math.round(done / total * 100) : 0;
  const delay   = S.trk.delay;

  // Progress bar
  document.getElementById('trkProgText').textContent  = `${done} / ${total} paradas`;
  document.getElementById('trkProgBar').style.width   = pct + '%';
  document.getElementById('trkStartTime').textContent = S.route?.startT || '—';
  document.getElementById('trkEndTime').textContent   = S.route?.endT   || '—';

  // Delay badge
  const badge = document.getElementById('trkDelayBadge');
  if (delay > 5)       { badge.textContent = `+${delay}min tarde`;        badge.style.background = '#dc2626'; }
  else if (delay < -5) { badge.textContent = `${Math.abs(delay)}min antes`; badge.style.background = '#16a34a'; }
  else                 { badge.textContent = 'En hora';                   badge.style.background = '#2563eb'; }

  // Current waypoint
  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = tw ? S.waypoints.find(w => w.id === tw.id) : null;
  const card = document.getElementById('trkCurrentCard');

  if (!wp) {
    // All done
    card.style.borderColor = '#16a34a';
    document.getElementById('trkCurrentLabel').textContent = '✅ JORNADA COMPLETADA';
    document.getElementById('trkCurrentName').textContent  = '¡Todas las paradas visitadas!';
    document.getElementById('trkCurrentAddr').textContent  = `Fin: ${S.route?.endT || ''}`;
    document.getElementById('trkArrivedBtn').style.display = 'none';
    document.getElementById('trkLeftBtn').style.display    = 'none';
    document.getElementById('trkTimerBlock').style.display = 'none';
    document.getElementById('trkMapsLink').href = '#';
    document.getElementById('trkWazeLink').href = '#';
  } else {
    const isAt = tw.status === 'at_client';
    card.style.borderColor = isAt ? '#16a34a' : '#2563eb';

    document.getElementById('trkCurrentLabel').textContent =
      isAt ? '🟢 EN CLIENTE' : '📍 PRÓXIMA PARADA';
    document.getElementById('trkCurrentName').textContent  = wp.name;
    document.getElementById('trkCurrentAddr').textContent  =
      `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
    document.getElementById('trkPlanned').textContent      = wp.plannedArrival  || '—';
    document.getElementById('trkEstimated').textContent    = delay === 0 ? (wp.plannedArrival||'—')
      : (wp.plannedArrival ? m2t(t2m(wp.plannedArrival)) : '—');
    document.getElementById('trkDwell').textContent        = fmtHM(wp.dwell);

    // Navigation links
    const gmUrl    = `https://www.google.com/maps/dir/?api=1&destination=${wp.lat},${wp.lng}&travelmode=driving`;
    const wazeUrl  = `https://waze.com/ul?ll=${wp.lat},${wp.lng}&navigate=yes`;
    document.getElementById('trkMapsLink').href = gmUrl;
    document.getElementById('trkWazeLink').href = wazeUrl;

    // Buttons visibility
    document.getElementById('trkArrivedBtn').style.display = tw.status === 'traveling' ? '' : 'none';
    document.getElementById('trkLeftBtn').style.display    = tw.status === 'at_client'  ? '' : 'none';

    // Timer block
    if (isAt && tw.arrivedAt) {
      document.getElementById('trkTimerBlock').style.display = '';
      startClientTimer(tw.arrivedAt, wp.dwell);
    } else {
      document.getElementById('trkTimerBlock').style.display = 'none';
    }
  }

  // Itinerary list
  renderTrkItinerary();
}

function renderTrkItinerary() {
  const el = document.getElementById('trkItinerary');
  if (!el) return;

  el.innerHTML = S.waypoints.map((wp, i) => {
    const tw     = S.trk.wps[i];
    const status = tw?.status || 'pending';
    const isDone = status === 'done';
    const isCur  = status === 'traveling' || status === 'at_client';

    let leftTime = '';
    if (isDone && tw.leftAt) {
      const d = new Date(tw.leftAt);
      leftTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

    const delayMin = tw?.actualDelay;
    let delayTag = '';
    if (isDone && delayMin !== null) {
      delayTag = delayMin > 5
        ? `<span style="color:#dc2626;font-size:.68rem;font-weight:700">+${delayMin}min</span>`
        : delayMin < -5
          ? `<span style="color:#16a34a;font-size:.68rem;font-weight:700">${Math.abs(delayMin)}min antes</span>`
          : `<span style="color:#0369a1;font-size:.68rem">En hora</span>`;
    }

    return `<div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);
      align-items:flex-start;opacity:${isDone ? '.55' : '1'};
      ${isCur ? 'background:#eff6ff;margin:0 -12px;padding:8px 12px;border-radius:6px;' : ''}">
      <div style="width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;
        align-items:center;justify-content:center;font-size:.75rem;font-weight:800;color:#fff;
        background:${isDone ? '#6b7280' : isCur ? '#2563eb' : '#e2e8f0'};
        color:${isCur || isDone ? '#fff' : '#6b7280'}">
        ${isDone ? '✓' : i + 1}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:.85rem;${isDone ? 'text-decoration:line-through;color:#6b7280' : ''}">
          ${esc(wp.name)}
        </div>
        <div style="font-size:.72rem;color:var(--gray);display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
          <span>⏱ ${fmtHM(wp.dwell)}</span>
          ${wp.plannedArrival ? `<span>🕐 ${wp.plannedArrival}</span>` : ''}
          ${leftTime ? `<span>🚪 ${leftTime}</span>` : ''}
          ${delayTag}
        </div>
      </div>
      ${isCur ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${wp.lat},${wp.lng}&travelmode=driving"
        target="_blank" rel="noopener"
        style="font-size:.7rem;padding:4px 8px;background:#2563eb;color:#fff;border-radius:5px;
          text-decoration:none;white-space:nowrap;flex-shrink:0">Navegar</a>` : ''}
    </div>`;
  }).join('');
}

function nowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function nowT()   { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`; }

// ═══════════════════════════════════════════════
//  UI
// ═══════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tc').forEach(c => c.classList.toggle('on', c.id === 'tab-' + tab));
  if (tab === 'route') refreshRouteTimingIfNeeded();
}

function notify(msg, type = '') {
  const colors = { success:'#15803d', error:'#dc2626', '':'#1e293b' };
  const n = document.createElement('div');
  n.className = 'notif';
  n.setAttribute('role', 'status');
  n.setAttribute('aria-live', 'polite');
  n.style.background = colors[type] || colors[''];
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

// ═══════════════════════════════════════════════
//  LOCAL STORAGE
// ═══════════════════════════════════════════════
//  PERSISTENCE  (una sola clave, guardado atómico)
// ═══════════════════════════════════════════════
const LS_KEY = 'rr2'; // nueva clave para evitar datos corruptos de versiones anteriores

function saveStorage() {
  try {
    const snap = {
      v:         3,
      ts:        Date.now(),
      home:      S.home,
      work:      S.work,
      startPt:   S.startPt,
      nid:       S.nid,
      schedMode: S.schedMode,
      sched: {
        mStart: document.getElementById('mStart')?.value || '08:00',
        mEnd:   document.getElementById('mEnd')?.value   || '13:30',
        aStart: document.getElementById('aStart')?.value || '16:00',
        aEnd:   document.getElementById('aEnd')?.value   || '18:30',
        cStart: document.getElementById('cStart')?.value || '08:00',
        cHours: document.getElementById('cHours')?.value || '8'
      },
      // Waypoints con tiempos planificados — toda la info necesaria
      waypoints: S.waypoints.map(w => ({
        id:               w.id,
        lat:              w.lat,
        lng:              w.lng,
        name:             w.name,
        dwell:            w.dwell,
        openTime:         w.openTime         || null,
        closeTime:        w.closeTime        || null,
        openTime2:        w.openTime2        || null,
        closeTime2:       w.closeTime2       || null,
        openingHoursRaw:  w.openingHoursRaw  || null,
        desiredArrival:   w.desiredArrival   || null,
        plannedArrival:   w.plannedArrival   || null,
        plannedDeparture: w.plannedDeparture || null,
        scheduleConflict: w.scheduleConflict || null
      })),
      // Resumen de ruta (sin itin — se reconstruye desde los waypoints)
      route: S.route ? {
        startT:      S.route.startT,
        endT:        S.route.endT,
        totalDist:   S.route.totalDist   || 0,
        totalTravel: S.route.totalTravel || 0,
        totalDwell:  S.route.totalDwell  || 0,
        totalWork:   S.route.totalWork   || 0,
        mode:        S.route.mode        || 'auto'
      } : null,
      // Estado de seguimiento (dentro del mismo blob — nunca se desincroniza)
      trk: S.trk.active ? {
        active:     true,
        startedAt:  S.trk.startedAt,
        currentIdx: S.trk.currentIdx,
        delay:      S.trk.delay      || 0,
        _prevDelay: S.trk._prevDelay || 0,
        wps:        S.trk.wps
      } : null
    };

    localStorage.setItem(LS_KEY, JSON.stringify(snap));
  } catch(e) {
    console.error('saveStorage:', e);
  }
}

// Compatibilidad: llamadas antiguas a saveTrkState() → ahora solo guarda todo
function saveTrkState() { saveStorage(); }

// Reconstruye el itinerario desde los waypoints guardados (sin OSRM)
function rebuildItin() {
  if (!S.route || !S.waypoints.length) return;
  const origin = S.startPt === 'home' ? S.home : S.work;
  if (!origin) return;

  const itin = [];
  itin.push({ type:'start', name: origin===S.home?'Casa':'Trabajo', time: S.route.startT, icon: origin===S.home?'🏠':'💼', color:'#2563eb' });

  let prevDep = S.route.startT;
  S.waypoints.forEach((wp, i) => {
    if (!wp.plannedArrival) return;
    const travelMin = Math.max(0, t2m(wp.plannedArrival) - t2m(prevDep));
    itin.push({ type:'travel', from: i===0?(origin===S.home?'Casa':'Trabajo'):S.waypoints[i-1].name, to: wp.name, dur: travelMin, dist: 0 });
    itin.push({ type:'wp', wp, arrival: t2m(wp.plannedArrival), depart: t2m(wp.plannedDeparture||wp.plannedArrival), wpIdx: i+1 });
    prevDep = wp.plannedDeparture || wp.plannedArrival;
  });

  const retMin = Math.max(0, t2m(S.route.endT) - t2m(prevDep));
  const last = S.waypoints.filter(w=>w.plannedArrival).slice(-1)[0];
  if (last) itin.push({ type:'travel', from: last.name, to: origin===S.home?'Casa':'Trabajo', dur: retMin, dist: 0 });
  itin.push({ type:'end', name: origin===S.home?'Casa':'Trabajo', time: S.route.endT, icon: origin===S.home?'🏠':'💼', color:'#16a34a' });

  S.route.itin = itin;
}

function loadStorage() {
  // Intentar leer la clave nueva; si no existe, intentar migrar de la vieja
  let raw = localStorage.getItem(LS_KEY);
  if (!raw) raw = localStorage.getItem('rr'); // migración desde versión anterior
  if (!raw) return;

  let d;
  try { d = JSON.parse(raw); } catch(e) { console.error('loadStorage parse:', e); return; }

  try {
    // ── 1. Config ──
    if (d.home)      { S.home = d.home; updateBaseUI('home'); setMk('home', d.home.lat, d.home.lng, '🏠', '#2563eb'); }
    if (d.work)      { S.work = d.work; updateBaseUI('work'); setMk('work', d.work.lat, d.work.lng, '💼', '#7c3aed'); }
    if (d.startPt)   setStart(d.startPt);
    if (d.nid)       S.nid = d.nid;
    if (d.schedMode) setMode(d.schedMode);
    if (d.sched) {
      const f = id => document.getElementById(id);
      ['mStart','mEnd','aStart','aEnd','cStart','cHours'].forEach(k => {
        if (d.sched[k]) f(k).value = d.sched[k];
      });
    }

    // ── 2. Waypoints ──
    if (d.waypoints?.length) {
      d.waypoints.forEach(w => {
        S.waypoints.push({
          ...w,
          openTime: parseTimeOrNull(w.openTime),
          closeTime: parseTimeOrNull(w.closeTime),
          openTime2: parseTimeOrNull(w.openTime2),
          closeTime2: parseTimeOrNull(w.closeTime2),
          openingHoursRaw: w.openingHoursRaw || null,
          scheduleConflict: w.scheduleConflict || null,
          actualDelay: null
        });
        addWPMarker(S.waypoints[S.waypoints.length - 1]);
      });
      renderWPs();
    }

    // ── 3. Ruta (reconstruir itin desde waypoints, sin OSRM) ──
    if (d.route) {
      S.route = { ...d.route };
      rebuildItin();          // reconstruye itin desde plannedArrival/plannedDeparture
      renderRoute(S.route);   // renderiza resumen + itinerario (no-op si itin no disponible)
      if (S.route.itin) document.getElementById('trackBtn').style.display = 'flex';
    }

    // ── 4. Encuadrar mapa ──
    const pts = [d.home, d.work, ...(d.waypoints||[])].filter(Boolean);
    if (pts.length > 1)       S.map.fitBounds(L.latLngBounds(pts.map(p=>[p.lat,p.lng])), { padding:[40,40] });
    else if (pts.length === 1) S.map.setView([pts[0].lat, pts[0].lng], 13);

    // ── 5. Seguimiento ──
    const trk = d.trk;
    if (trk?.active && S.waypoints.length) {
      S.trk.active     = true;
      S.trk.startedAt  = trk.startedAt  || Date.now();
      S.trk.currentIdx = Math.min(trk.currentIdx || 0, Math.max(0, (trk.wps?.length||1) - 1));
      S.trk.delay      = trk.delay      || 0;
      S.trk._prevDelay = trk._prevDelay || 0;
      S.trk.wps        = Array.isArray(trk.wps) ? trk.wps : [];

      document.getElementById('trackBtn').innerHTML = '<i class="fas fa-stop" style="color:#ef4444"></i> Parar';
      document.getElementById('trkTabBtn').style.display = '';
      renderTrkPanel();
      showTab('tracking');

      // Reiniciar timer si el usuario estaba en un cliente al recargar
      const curTw = S.trk.wps[S.trk.currentIdx];
      const curWp = curTw ? S.waypoints.find(w => w.id === curTw.id) : null;
      if (curTw?.status === 'at_client' && curTw.arrivedAt && curWp) {
        startClientTimer(curTw.arrivedAt, curWp.dwell);
      }
      notify('Seguimiento restaurado ✓', 'success');
    } else if (S.waypoints.length) {
      notify(`Sesión restaurada · ${S.waypoints.length} puntos`, 'success');
    }

  } catch(e) { console.error('loadStorage apply:', e); }
}

// ═══════════════════════════════════════════════
//  KEYBOARD / MISC
// ═══════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    S.addingPt = false; S.setLocFor = null; setCursor('');
    closeModal(); closeLocModal();
    document.getElementById('searchResults').style.display = 'none';
    clearSearchMarkers();
  }
});

document.getElementById('searchInput').addEventListener('keydown', e => { if(e.key==='Enter') searchPlace(); });
document.getElementById('urlInput').addEventListener('keydown', e => { if(e.key==='Enter') parseUrl(); });
document.getElementById('bizInput').addEventListener('keydown', e => { if(e.key==='Enter') searchBusiness(); });
document.getElementById('locInput').addEventListener('keydown', e => { if(e.key==='Enter') searchLoc(); });

window.addEventListener('DOMContentLoaded', initMap);
