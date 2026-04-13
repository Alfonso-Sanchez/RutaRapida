const S = {
  home: null, work: null,
  startPt: 'home',
  endPt: 'home',
  waypoints: [],
  schedMode: 'auto',
  route: null,
  routeData: null,
  trk: {
    active: false, delay: 0, _prevDelay: 0,
    startedAt: null, currentIdx: 0,
    wps: [],
    timerInterval: null
  },
  setLocFor: null,
  addingPt: false,
  pendingCoords: null,
  map: null, markers: {}, routeLayer: null,
  previewMk: null,
  searchMarkers: [],
  nid: 1,
  searchCache: {},
  pendingImportRoute: null,
  sortable: null
};

const SEARCH_CACHE_MAX = 100;
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function initMap() {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
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
    addWP({ lat, lng, name, dwell, priority: document.getElementById('npPriority').value, desiredArrival: arr, openTime, closeTime, openTime2, closeTime2 });
    S.addingPt = false;
    setCursor('');
    document.getElementById('npName').value = '';
    document.getElementById('npDwell').value = '';
    document.getElementById('npArrival').value = '';
    document.getElementById('npOpen').value = '';
    document.getElementById('npClose').value = '';
    document.getElementById('npOpen2').value = '';
    document.getElementById('npClose2').value = '';
    document.getElementById('npPriority').value = 'normal';
    notify('Punto añadido: ' + name, 'success');
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

function cleanPlaceText(raw) {
  if (raw == null) return '';
  const text = String(raw).replace(/\+/g, ' ').trim();
  try {
    return decodeURIComponent(text).replace(/\s+/g, ' ').trim();
  } catch {
    return text.replace(/\s+/g, ' ').trim();
  }
}

function normalizePriorityLevel(raw) {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return 'high';
  if (raw === 'force_first') return 'force_first';
  if (raw === 'high') return 'high';
  return 'normal';
}

function getPriorityMeta(raw) {
  const level = normalizePriorityLevel(raw);
  if (level === 'force_first') return { level, label: 'Forzar primero', badge: 'Primero', bg: '#fee2e2', color: '#b91c1c' };
  if (level === 'high') return { level, label: 'Alta', badge: 'Alta', bg: '#ffedd5', color: '#c2410c' };
  return { level, label: 'Normal', badge: '', bg: '', color: '' };
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
  if (wp.openTime && wp.closeTime) windows.push({ start: t2m(wp.openTime), end: t2m(wp.closeTime), label: `${wp.openTime}-${wp.closeTime}` });
  if (wp.openTime2 && wp.closeTime2) windows.push({ start: t2m(wp.openTime2), end: t2m(wp.closeTime2), label: `${wp.openTime2}-${wp.closeTime2}` });
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
    if (arrival <= w.start && (w.start + dwell) <= w.end) return { arrival: w.start, conflict: null };
    if (arrival >= w.start && arrival < w.end && (arrival + dwell) <= w.end) return { arrival, conflict: null };
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
  S._routeDrawErrorShown = false;
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

function getBasePoint(type) {
  return type === 'work' ? S.work : S.home;
}

function getBaseLabel(type) {
  return type === 'work' ? 'Trabajo' : 'Casa';
}

function setStart(type) {
  S.startPt = type;
  invalidateRoute();
  document.getElementById('sp-home').classList.toggle('on', type === 'home');
  document.getElementById('sp-work').classList.toggle('on', type === 'work');
  saveStorage();
}

function setEnd(type) {
  S.endPt = type;
  invalidateRoute();
  document.getElementById('ep-home').classList.toggle('on', type === 'home');
  document.getElementById('ep-work').classList.toggle('on', type === 'work');
  saveStorage();
}

function mkSearchIcon(num, highlight = false) {
  const bg = highlight ? '#7c3aed' : '#6d28d9';
  const size = highlight ? 28 : 24;
  return L.divIcon({
    html: `<div style="background:${bg};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff;transition:all .15s;">${num}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
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
    const sub = r.display_name?.split(',').slice(1, 3).join(',').trim() || '';

    const m = L.marker([lat, lng], { icon: mkSearchIcon(i + 1) })
      .addTo(S.map)
      .bindPopup(`
        <div style="min-width:160px;font-size:.82rem">
          <b>${esc(name)}</b>
          ${sub ? `<div style="color:#6b7280;font-size:.75rem;margin-top:2px">${esc(sub)}</div>` : ''}
          <button onclick="(${onAddFn.toString()})(${lat},${lng},${JSON.stringify(name).replace(/"/g, '&quot;')})"
            style="margin-top:7px;padding:4px 10px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:.75rem;width:100%">
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
    html: `<div style="background:${color};width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 7px rgba(0,0,0,.35);border:2px solid #fff">${inner}</div>`,
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
  if (S.markers[id]) {
    S.map.removeLayer(S.markers[id]);
    delete S.markers[id];
  }
}

function wpTrkStatus(id) {
  const tw = S.trk.wps.find(w => w.id === id);
  return tw?.status || 'pending';
}

function addWPMarker(wp) {
  const idx = S.waypoints.indexOf(wp) + 1;
  const trkSt = wpTrkStatus(wp.id);
  const priorityLevel = normalizePriorityLevel(wp.priority);
  let color = '#16a34a';
  if (priorityLevel === 'high') color = '#ea580c';
  if (priorityLevel === 'force_first') color = '#dc2626';
  if (trkSt === 'at_client') color = '#16a34a';
  if (trkSt === 'done') color = '#6b7280';
  const m = setMk('wp_' + wp.id, wp.lat, wp.lng, idx, color, false);
  const popContent = () => `
    <div style="min-width:160px;font-size:.82rem">
      <b>${esc(wp.name)}</b><br>
      <span style="color:#6b7280">Estancia: ${fmtHM(wp.dwell)}</span>
      ${priorityLevel === 'high' ? `<br><span style="color:#c2410c">Prioridad: Alta</span>` : ''}
      ${priorityLevel === 'force_first' ? `<br><span style="color:#b91c1c">Prioridad: Forzar primero</span>` : ''}
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
}

function mapViewbox() {
  if (!S.map) return '';
  const b = S.map.getBounds().pad(0.5);
  return `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
}

function countryHint() {
  const ref = S.home || S.work;
  if (!ref) return '';
  if (ref.lat >= 35 && ref.lat <= 44 && ref.lng >= -10 && ref.lng <= 5) return 'es';
  if (ref.lat >= 37 && ref.lat <= 42 && ref.lng >= -10 && ref.lng <= -6) return 'pt';
  if (ref.lat >= 42 && ref.lat <= 51 && ref.lng >= -5 && ref.lng <= 10) return 'fr';
  return '';
}

async function nominatim(q, opts = {}) {
  const vb = opts.viewbox !== undefined ? opts.viewbox : mapViewbox();
  const cc = opts.countrycodes !== undefined ? opts.countrycodes : countryHint();
  const vbParam = vb ? `&viewbox=${encodeURIComponent(vb)}` : '';
  const ccParam = cc ? `&countrycodes=${cc}` : '';
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
  } catch {
    return [];
  }
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
    const d = await fetchJsonWithRetry(url, {
      headers: { 'Accept-Language': 'es', 'User-Agent': 'RutaRapida/1.0' }
    });
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
  } catch {
    cb(`${lat.toFixed(4)},${lng.toFixed(4)}`);
  }
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
  showSearchResultsOnMap(res, addSearchResultAsPoint);
  box.innerHTML = res.slice(0, 6).map((r, i) =>
    `<div class="sres-item" onclick="pickSearch(${r.lat},${r.lon},${i})" onmouseenter="highlightSearchMk(${i})" onmouseleave="unhighlightSearchMk(${i})">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#6d28d9;color:#fff;font-size:10px;font-weight:800;margin-right:6px;flex-shrink:0">${i + 1}</span>
      <span>
        <div class="sres-main">${esc(r.display_name.split(',')[0])}</div>
        <div class="sres-sub">${esc(r.display_name.split(',').slice(1, 3).join(',').trim())}</div>
      </span>
    </div>`).join('');
  box._results = res;
}

function pickSearch(lat, lng, i) {
  document.getElementById('searchResults').style.display = 'none';
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
  document.getElementById('ePriority').value = 'normal';
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
    for (const q of queries) {
      const r = await nominatimBiz(q, 10, { bounded: true, useViewbox: true, zoom: 18 });
      found = dedupeBizResults(found.concat(r));
      if (found.length >= 10) break;
    }

    if (found.length < 6) {
      for (const q of queries) {
        const r = await nominatimBiz(q, 10, { bounded: false, useViewbox: false });
        found = dedupeBizResults(found.concat(r));
        if (found.length >= 12) break;
      }
    }

    if (found.length < 4 && type && BIZ_TYPE_ALIASES[type]) {
      for (const alias of BIZ_TYPE_ALIASES[type]) {
        const r = await nominatimBiz(alias, 8, { bounded: true, useViewbox: true });
        found = dedupeBizResults(found.concat(r));
        if (found.length >= 12) break;
      }
    }
  } else {
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
  showSearchResultsOnMap(sliced, addBizAsPoint);

  box.innerHTML = sliced.map((r, i) => {
    const main = esc(r.display_name.split(',')[0]);
    const sub = esc(r.display_name.split(',').slice(1, 3).join(',').trim());
    const hours = parseOpeningHoursRange(r?.extratags?.opening_hours || '');
    return `<div class="sres-item" onclick="pickBusiness(${r.lat},${r.lon},${i})" onmouseenter="highlightSearchMk(${i})" onmouseleave="unhighlightSearchMk(${i})">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#6d28d9;color:#fff;font-size:10px;font-weight:800;margin-right:6px;flex-shrink:0">${i + 1}</span>
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
  document.getElementById('ePriority').value = 'normal';
  document.getElementById('eOpen').value = S.pendingCoords.openTime || '';
  document.getElementById('eClose').value = S.pendingCoords.closeTime || '';
  document.getElementById('eOpen2').value = S.pendingCoords.openTime2 || '';
  document.getElementById('eClose2').value = S.pendingCoords.closeTime2 || '';
  document.getElementById('editModal').style.display = 'flex';
}

async function searchLoc() {
  const q = document.getElementById('locInput').value.trim();
  if (!q) return;
  const cc = countryHint();
  const res = await nominatim(q, { viewbox: '', countrycodes: cc });
  const box = document.getElementById('locResults');
  box.style.display = 'block';
  if (!res.length) {
    box.innerHTML = '<div class="sres-item" style="color:#6b7280">Sin resultados. Intenta con más detalle (ciudad, calle...)</div>';
    return;
  }
  box.innerHTML = res.slice(0, 6).map((r, i) =>
    `<div class="sres-item" onclick="pickLoc(${r.lat},${r.lon},${i})">
      <div class="sres-main">${esc(r.display_name.split(',')[0])}</div>
      <div class="sres-sub">${esc(r.display_name.split(',').slice(1, 3).join(',').trim())}</div>
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
