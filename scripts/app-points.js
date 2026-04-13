async function parseUrl() {
  const url = unwrapProxyUrl(document.getElementById('urlInput').value.trim());
  if (!url) { notify('Pega una URL primero', 'error'); return; }

  notify('Procesando URL…');
  let coords = extractCoords(url);

  if (!coords && isShortUrl(url)) {
    notify('URL corta detectada, intentando resolver…');
    coords = await resolveShort(url);
  }

  if (!coords?.lat) {
    if (coords?.q) {
      notify('Buscando por nombre…');
      const res = await nominatim(coords.q);
      if (res.length) {
        coords = { lat: parseFloat(res[0].lat), lng: parseFloat(res[0].lon), name: cleanPlaceText(res[0].display_name.split(',')[0]) };
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

function unwrapProxyUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (/api\.codetabs\.com$/i.test(u.hostname)) {
      const quest = u.searchParams.get('quest');
      if (quest) return decodeURIComponent(quest);
    }
  } catch {}
  return url;
}

function parseFreeCoords(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

  let m = s.match(/^\[?\s*(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)\s*\]?$/);
  if (m) {
    const lat = parseFloat(m[1].replace(',', '.'));
    const lng = parseFloat(m[2].replace(',', '.'));
    if (inRange(lat, lng)) return { lat, lng };
  }

  m = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
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

function parseEmbeddedCoordPair(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/(-?\d{1,2}\.\d{4,})[,\s/]+(-?\d{1,3}\.\d{4,})/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function extractCoords(url) {
  if (!url || typeof url !== 'string') return null;
  const free = parseFreeCoords(url);
  if (free) return free;
  let m;

  try {
    const u = new URL(url);
    const nested = u.searchParams.get('link') || u.searchParams.get('url') || u.searchParams.get('q');
    if (nested && /^https?:/i.test(nested)) {
      const dec = decodeURIComponent(nested);
      const fromNested = extractCoords(dec);
      if (fromNested) return fromNested;
    }
  } catch {}

  let name = '';
  const placeM = url.match(/\/place\/([^/@?]+)/);
  if (placeM) name = cleanPlaceText(placeM[1]).split(',')[0].trim();

  m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  m = url.match(/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (m) return { lat: +m[2], lng: +m[1], name };

  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&]destination=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/[?&](?:query|query_place|dest|daddr)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  m = url.match(/[?&]latlng=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };
  m = url.match(/navigate=yes&ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], name };

  if (name) return { q: name, name };

  m = url.match(/[?&]q=([^&]+)/);
  if (m && !/^\d/.test(m[1])) return { q: cleanPlaceText(m[1]) };

  const embedded = parseEmbeddedCoordPair(decodeURIComponent(url));
  if (embedded) return { ...embedded, name };
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
  const cleanUrl = unwrapProxyUrl(url);
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
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(`https://unshorten.me/s/${cleanUrl}`)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(cleanUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(cleanUrl)}`,
    `https://r.jina.ai/http://${cleanUrl.replace(/^https?:\/\//i, '')}`
  ];

  for (const p of proxies) {
    try {
      const r = await fetchTextWithRetry(p, { signal: AbortSignal.timeout(6000) }, 1);
      const coords = tryExtract(r.url, r.text);
      if (coords) return coords;
    } catch {}
  }

  try {
    const u = new URL(cleanUrl);
    const nested = u.searchParams.get('link') || u.searchParams.get('url') || u.searchParams.get('q');
    if (nested) {
      const dec = decodeURIComponent(nested);
      const coords = extractCoords(dec);
      if (coords) return coords;
    }
  } catch {}

  return null;
}

function buildRouteExportSnapshot() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    startPt: S.startPt,
    endPt: S.endPt,
    home: S.home ? { ...S.home } : null,
    work: S.work ? { ...S.work } : null,
    waypoints: S.waypoints.map(w => ({
      name: w.name,
      lat: w.lat,
      lng: w.lng,
      dwell: w.dwell,
      desiredArrival: w.desiredArrival || null,
      openTime: w.openTime || null,
      closeTime: w.closeTime || null,
      openTime2: w.openTime2 || null,
      closeTime2: w.closeTime2 || null,
      openingHoursRaw: w.openingHoursRaw || null
    }))
  };
}

function encodeRouteShareText(data) {
  return `RR1:${btoa(unescape(encodeURIComponent(JSON.stringify(data))))}`;
}

function decodeRouteShareText(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('empty');
  const text = raw.trim();
  const payload = text.startsWith('RR1:') ? text.slice(4) : text;
  return JSON.parse(decodeURIComponent(escape(atob(payload))));
}

async function copyRouteShareText() {
  if (!S.waypoints.length) { notify('No hay puntos para copiar', 'error'); return; }
  const text = encodeRouteShareText(buildRouteExportSnapshot());
  try {
    await navigator.clipboard.writeText(text);
    notify('Ruta copiada. Ya puedes pegarla en el móvil.', 'success');
  } catch {
    openImportRouteModal(text);
    notify('No se pudo copiar automáticamente. Copia el texto manualmente.', 'error');
  }
}

function openImportRouteModal(prefill = '') {
  const input = document.getElementById('importRouteText');
  if (input) input.value = prefill;
  document.getElementById('importSummary').innerHTML = 'Pega aquí el texto compartido de la ruta.';
  document.getElementById('importModal').style.display = 'flex';
}

function loadPendingImportedRoute(data) {
  if (!Array.isArray(data?.waypoints) || !data.waypoints.length) throw new Error('invalid-route');
  S.pendingImportRoute = data;
  document.getElementById('importStartPt').value = data.startPt === 'work' ? 'work' : 'home';
  document.getElementById('importEndPt').value = data.endPt === 'work' ? 'work' : 'home';
  document.getElementById('importSummary').innerHTML =
    `<b>${data.waypoints.length}</b> punto(s) listos para importar.<br>` +
    `Origen sugerido: <b>${esc(getBaseLabel(data.startPt))}</b> · ` +
    `Destino sugerido: <b>${esc(getBaseLabel(data.endPt))}</b>`;
}

function previewImportedRouteText() {
  const raw = document.getElementById('importRouteText')?.value || '';
  try {
    loadPendingImportedRoute(decodeRouteShareText(raw));
    notify('Ruta lista para importar', 'success');
  } catch (e) {
    console.error('previewImportedRouteText:', e);
    notify('El texto pegado no tiene un formato de ruta válido', 'error');
  }
}

async function pasteRouteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const input = document.getElementById('importRouteText');
    if (input) input.value = text || '';
    previewImportedRouteText();
  } catch (e) {
    console.error('pasteRouteFromClipboard:', e);
    notify('No se pudo leer el portapapeles. Pega el texto manualmente.', 'error');
  }
}

function closeImportModal() {
  document.getElementById('importModal').style.display = 'none';
  const input = document.getElementById('importRouteText');
  if (input) input.value = '';
  S.pendingImportRoute = null;
}

function applyImportedRoute() {
  let data = S.pendingImportRoute;
  if (!data) {
    try {
      data = decodeRouteShareText(document.getElementById('importRouteText')?.value || '');
      loadPendingImportedRoute(data);
    } catch {
      notify('Pega primero un texto de ruta válido', 'error');
      return;
    }
  }
  if (!data?.waypoints?.length) { notify('Pega primero un texto de ruta válido', 'error'); return; }

  const startPt = document.getElementById('importStartPt').value === 'work' ? 'work' : 'home';
  const endPt = document.getElementById('importEndPt').value === 'work' ? 'work' : 'home';
  if (S.waypoints.length && !confirm('Se sustituirá la ruta actual. ¿Continuar?')) return;

  if (!getBasePoint(startPt) && data[startPt]) setBaseLoc(startPt, data[startPt].lat, data[startPt].lng, data[startPt].name);
  if (!getBasePoint(endPt) && data[endPt]) setBaseLoc(endPt, data[endPt].lat, data[endPt].lng, data[endPt].name);
  if (!getBasePoint(startPt) || !getBasePoint(endPt)) {
    notify('Configura Casa y Trabajo antes de importar esta combinación de inicio y fin', 'error');
    return;
  }

  if (S.trk.active) stopTracking();
  S.waypoints.forEach(w => rmMk('wp_' + w.id));
  S.waypoints = [];
  S.pendingCoords = null;

  data.waypoints.forEach(w => addWP({
    lat: parseFloat(w.lat),
    lng: parseFloat(w.lng),
    name: w.name,
    dwell: w.dwell,
    desiredArrival: w.desiredArrival,
    openTime: w.openTime,
    closeTime: w.closeTime,
    openTime2: w.openTime2,
    closeTime2: w.closeTime2,
    openingHoursRaw: w.openingHoursRaw,
    silent: true
  }));

  setStart(startPt);
  setEnd(endPt);
  invalidateRoute();
  renderWPs();
  saveStorage();
  closeImportModal();
  S.pendingImportRoute = null;
  showTab('points');
  notify('Ruta importada. Ya puedes recalcular en este dispositivo.', 'success');
}

function addWP({ lat, lng, name, dwell, desiredArrival, openTime, closeTime, openTime2, closeTime2, openingHoursRaw, silent }) {
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
  if (!silent) {
    renderWPs();
    saveStorage();
    showTab('points');
  }
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
    const done = trkSt === 'done';
    const tw = S.trk.wps.find(w => w.id === wp.id);
    let status = '';
    if (S.trk.active && done && tw?.actualDelay !== null && tw?.actualDelay !== undefined) {
      const d = tw.actualDelay;
      status = d > 5 ? `<span class="wp-status s-late">+${d}min tarde</span>`
        : d < -5 ? `<span class="wp-status s-early">${Math.abs(d)}min antes</span>`
        : `<span class="wp-status s-ok">En hora</span>`;
    }
    const planned = wp.plannedArrival ? `<span class="badge bb">${esc(wp.plannedArrival)}</span>` : '';
    const fixed = wp.desiredArrival ? `<span class="badge" style="background:#fef9c3;color:#854d0e">🎯 ${esc(wp.desiredArrival)}</span>` : '';
    const hoursText = formatCustomerHours(wp);
    const hours = hoursText ? `<span class="badge" style="background:#ecfeff;color:#155e75">🕘 ${esc(hoursText)}</span>` : '';
    const conflict = wp.scheduleConflict ? `<span class="wp-status s-late">${esc(wp.scheduleConflict)}</span>` : '';
    const numBg = done ? '#6b7280' : trkSt === 'at_client' ? '#16a34a' : '#ea580c';

    return `<div class="wp-item ${done ? 'done' : ''}" data-id="${wp.id}">
      <div class="wp-num" style="background:${numBg};cursor:${S.trk.active ? 'default' : 'grab'}" title="${S.trk.active ? '' : 'Arrastrar para reordenar'}">${done ? '✓' : i + 1}</div>
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
        ${S.trk.active && done ? `<button class="btn bg bi bsm" onclick="trkReopen(${i})" title="Reactivar parada">↺</button>` : ''}
      </div>
    </div>`;
  }).join('');

  S.waypoints.forEach(wp => addWPMarker(wp));

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

function setMode(m) {
  S.schedMode = m;
  ['auto', 'split', 'cont'].forEach(x => document.getElementById('md-' + x).classList.toggle('on', x === m));
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
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
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
