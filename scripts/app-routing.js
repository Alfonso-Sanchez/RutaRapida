function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function nearestNeighbor(origin, wps) {
  const visited = new Array(wps.length).fill(false);
  const route = [];
  let cur = origin;
  for (let s = 0; s < wps.length; s++) {
    let best = -1;
    let bestD = Infinity;
    wps.forEach((w, j) => {
      if (visited[j]) return;
      const d = haversine(cur, w);
      if (d < bestD) { best = j; bestD = d; }
    });
    visited[best] = true;
    route.push(best);
    cur = wps[best];
  }
  return route;
}

function routeCost(order, origin, wps) {
  let c = 0, prev = origin;
  for (const i of order) { c += haversine(prev, wps[i]); prev = wps[i]; }
  return c;
}

function twoOpt(order, origin, wps) {
  let best = [...order], bestC = routeCost(best, origin, wps), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const nr = [...best.slice(0, i + 1), ...best.slice(i + 1, j + 1).reverse(), ...best.slice(j + 1)];
        const nc = routeCost(nr, origin, wps);
        if (nc < bestC - 0.001) { best = nr; bestC = nc; improved = true; }
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
  let c = 0, prev = -1;
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
  let fi = 0, li = 0;
  while (fi < fixed.length || li < optimized.length) {
    if (li < optimized.length && (fi >= fixed.length || li <= Math.floor(fi * optimized.length / Math.max(fixed.length, 1)))) merged.push(optimized[li++]);
    else if (fi < fixed.length) merged.push(fixed[fi++]);
  }
  return merged;
}

async function optimizeOrder() {
  if (S.waypoints.length < 2) { notify('Necesitas al menos 2 puntos', 'error'); return; }
  const origin = S.startPt === 'home' ? S.home : S.work;
  if (!origin) { notify('Establece el punto de partida primero', 'error'); return; }

  notify('Optimizando orden…');
  S.waypoints = await getOptimizedWaypoints(origin, S.waypoints);
  invalidateRoute();
  renderWPs();
  saveStorage();
  notify('¡Orden optimizado!', 'success');
}

async function getOsrmRoute(pts) {
  if (pts.length < 2) return null;
  const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
  try {
    const d = await fetchJsonWithRetry(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`,
      { signal: AbortSignal.timeout(10000) }
    );
    return d.code === 'Ok' ? d.routes[0] : null;
  } catch {
    return null;
  }
}

function getRouteEndpoints() {
  return {
    origin: getBasePoint(S.startPt),
    destination: getBasePoint(S.endPt),
    startLabel: getBaseLabel(S.startPt),
    endLabel: getBaseLabel(S.endPt)
  };
}

async function calcRoute() {
  if (!S.waypoints.length) { notify('Añade al menos un punto', 'error'); return; }
  const { origin, destination, startLabel, endLabel } = getRouteEndpoints();
  if (!origin) { notify(`Establece ${S.startPt === 'home' ? 'la casa' : 'el trabajo'} primero`, 'error'); showTab('setup'); return; }
  if (!destination) { notify(`Establece ${S.endPt === 'home' ? 'la casa' : 'el trabajo'} para el final`, 'error'); showTab('setup'); return; }

  const btn = document.getElementById('calcBtn');
  btn.innerHTML = '<span class="spin"></span> Calculando…';
  btn.disabled = true;

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
    const allPts = [origin, ...optimizedWaypoints, destination];

    notify('Obteniendo ruta real (OSRM)…');
    const osrm = await getOsrmRoute(allPts);
    if (!osrm) notify('Sin conexión a OSRM. Usando estimación lineal.', 'error');

    const result = buildSchedule(optimizedWaypoints, origin, sc, osrm, { destination, startLabel, endLabel });
    S.route = result;
    S.routeData = { origin, destination, osrm, startLabel, endLabel };

    renderRoute(result);
    if (osrm) drawRoute(osrm.geometry);
    else drawLines(allPts);

    showRecommendation(result, sc);
    resetBusinessSearchUI();
    renderWPs();
    showTab('route');
    document.getElementById('trackBtn').style.display = 'flex';
    saveStorage();
  } finally {
    btn.innerHTML = '<i class="fas fa-route"></i> Calcular ruta óptima';
    btn.disabled = false;
  }
}

function buildSchedule(wps, origin, sc, osrm, opts = {}) {
  const destination = opts.destination || origin;
  const startLabel = opts.startLabel || getBaseLabel(S.startPt);
  const endLabel = opts.endLabel || getBaseLabel(S.endPt);
  let mode = sc.mode;
  const now = Number.isFinite(opts.startMinOverride) ? opts.startMinOverride : nowMin();
  const totalDwell = wps.reduce((s, w) => s + w.dwell, 0);

  const allPts = [origin, ...wps, destination];
  let segDur = [], segDist = [];
  if (osrm?.legs) {
    segDur = osrm.legs.map(l => Math.round(l.duration / 60));
    segDist = osrm.legs.map(l => l.distance / 1000);
  } else {
    for (let i = 0; i < allPts.length - 1; i++) {
      const d = haversine(allPts[i], allPts[i + 1]);
      segDist.push(d);
      segDur.push(Math.round(d / 0.55));
    }
  }

  const totalTravel = segDur.reduce((s, d) => s + d, 0);
  const totalWork = totalDwell + totalTravel;

  if (mode === 'auto') {
    const morningLeft = now < sc.mE ? Math.max(0, sc.mE - Math.max(now, sc.mS)) : 0;
    const contLeft = getRemainingAvailability(sc, 'cont', now);
    if (morningLeft > 0 && totalWork <= morningLeft) mode = 'morning';
    else if (contLeft > 0 && totalWork <= contLeft) mode = 'cont';
    else mode = 'split';
  }

  const effectiveStart = Number.isFinite(opts.startMinOverride) ? opts.startMinOverride : getEffectiveStartMin(sc, mode, now);
  const itin = [];
  let cur = effectiveStart;
  itin.push({ type: 'start', name: startLabel, time: m2t(cur), icon: S.startPt === 'home' ? '🏠' : '💼', color: '#2563eb' });

  let usedBreak = mode !== 'split' || cur >= sc.aS;

  for (let i = 0; i < wps.length; i++) {
    const wp = wps[i];
    const travel = segDur[i];
    let arrival = cur + travel;
    wp.scheduleConflict = null;

    if (wp.desiredArrival) {
      const desired = t2m(wp.desiredArrival);
      if (desired > arrival) arrival = desired;
    } else {
      const adjusted = adjustArrivalToCustomerHours(arrival, wp.dwell, wp);
      arrival = adjusted.arrival;
      wp.scheduleConflict = adjusted.conflict;
    }

    if ((mode === 'split' || mode === 'morning') && !usedBreak) {
      if (arrival >= sc.mE) {
        itin.push({ type: 'break', timeS: m2t(sc.mE), timeE: m2t(sc.aS) });
        cur = sc.aS;
        arrival = cur + travel;
        usedBreak = true;
      }
    }

    itin.push({ type: 'travel', from: i === 0 ? startLabel : wps[i - 1].name, to: wp.name, dur: travel, dist: segDist[i] });
    const depart = arrival + wp.dwell;

    if (!wp.desiredArrival && !wp.scheduleConflict) {
      const windows = getCustomerWindows(wp);
      const fitsWindow = windows.length ? windows.some(w => arrival >= w.start && depart <= w.end) : true;
      if (!fitsWindow) wp.scheduleConflict = `Fuera de horario (${formatCustomerHours(wp) || 'sin horario'})`;
    }

    wp.plannedArrival = m2t(arrival);
    wp.plannedDeparture = m2t(depart);
    itin.push({ type: 'wp', wp, arrival, depart, wpIdx: i + 1 });
    cur = depart;
  }

  const retDur = segDur[wps.length] || 0;
  const retDist = segDist[wps.length] || 0;
  if (retDur) itin.push({ type: 'travel', from: wps[wps.length - 1]?.name || startLabel, to: endLabel, dur: retDur, dist: retDist });
  const endT = cur + retDur;
  itin.push({ type: 'end', name: endLabel, time: m2t(endT), icon: S.endPt === 'home' ? '🏠' : '💼', color: '#16a34a' });

  const totalDist = segDist.reduce((s, d) => s + d, 0);
  return { itin, mode, totalDist, totalTravel, totalDwell, totalWork, startT: m2t(effectiveStart), endT: m2t(endT), effectiveStart, plannedFromNow: now, startLabel, endLabel, segDur: [...segDur], segDist: [...segDist] };
}

function showRecommendation(result, sc) {
  const box = document.getElementById('modeRec');
  const pct = Math.round(result.totalWork / (sc.mE - sc.mS + sc.aE - sc.aS) * 100);
  const conflicts = S.waypoints.filter(w => w.scheduleConflict).length;
  const msgs = {
    morning: `✅ Toda la ruta cabe en la <b>jornada de mañana</b> (${pct}% del tiempo). Tarde libre.`,
    split: `📅 Modo <b>partido</b> óptimo: ruta bien distribuida en mañana y tarde.`,
    cont: `⚡ Modo <b>seguido</b> recomendado: terminas ${result.endT} sin pausa de comida.`,
    auto: `🪄 Modo auto aplicado.`
  };
  box.innerHTML = (msgs[result.mode] || msgs.auto) + (conflicts ? ` <br><span style="color:#b45309;font-weight:700">Atención: ${conflicts} cliente(s) quedan fuera de horario.</span>` : '');
  box.style.display = 'block';
}

function refreshRouteTimingIfNeeded() {
  if (!S.route || !S.routeData || S.trk.active) return;
  const sc = getSched();
  if (validateSched(sc)) return;

  const refreshed = buildSchedule(S.waypoints, S.routeData.origin, sc, S.routeData.osrm, {
    destination: S.routeData.destination || S.routeData.origin,
    startLabel: S.routeData.startLabel || getBaseLabel(S.startPt),
    endLabel: S.routeData.endLabel || getBaseLabel(S.endPt)
  });
  if (refreshed.startT === S.route.startT && refreshed.endT === S.route.endT) return;

  S.route = refreshed;
  renderRoute(refreshed);
  showRecommendation(refreshed, sc);
  renderWPs();
}

function renderRoute(r) {
  if (!r?.itin) return;
  document.getElementById('routeEmpty').style.display = 'none';
  document.getElementById('routeResults').style.display = 'flex';
  document.getElementById('sDist').textContent = r.totalDist.toFixed(1) + ' km';
  document.getElementById('sTravel').textContent = fmtDur(r.totalTravel);
  document.getElementById('sDwell').textContent = fmtDur(r.totalDwell);
  document.getElementById('sTotal').textContent = fmtDur(r.totalWork);
  document.getElementById('sStart').textContent = r.startT;
  document.getElementById('sEnd').textContent = r.endT;

  const sc = getSched();
  const totalAvail = (sc.mE - sc.mS) + (sc.aE - sc.aS);
  const pct = Math.min(100, Math.round(r.totalWork / totalAvail * 100));
  document.getElementById('sProg').style.width = pct + '%';

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
    if (step.type === 'break') return `<div class="rsep">🍽️ Descanso ${step.timeS} – ${step.timeE}</div>`;

    const colors = { start: '#2563eb', end: '#16a34a', wp: '#ea580c' };
    const bgs = { start: '#dbeafe', end: '#dcfce7', wp: '#ffedd5' };
    const t = step.type === 'wp' ? 'wp' : step.type;
    const icon = step.type === 'wp' ? `<b>${step.wpIdx}</b>` : step.icon;
    const name = esc(step.type === 'wp' ? step.wp.name : step.name);
    const detail = step.type === 'wp'
      ? `⏱ ${fmtHM(step.wp.dwell)}${step.wp.desiredArrival ? ` · 🎯 ${esc(step.wp.desiredArrival)}` : ''}${formatCustomerHours(step.wp) ? ` · 🕘 ${esc(formatCustomerHours(step.wp))}` : ''}${step.wp.scheduleConflict ? ` · ${esc(step.wp.scheduleConflict)}` : ''}`
      : '';
    const time = step.type === 'wp'
      ? `<div style="font-weight:700;color:var(--blue)">${m2t(step.arrival)}</div><div style="font-size:.7rem;color:var(--gray)">${m2t(step.depart)}</div>`
      : `<div style="font-weight:700;color:${colors[t] || '#2563eb'}">${step.time}</div>`;

    return `<div class="rstep">
      <div class="rstep-icon" style="background:${bgs[t] || '#f1f5f9'};color:${colors[t] || '#374151'}">${icon}</div>
      <div class="rstep-info"><div class="rstep-name">${name}</div><div class="rstep-detail">${detail}</div></div>
      <div class="rstep-time">${time}</div>
    </div>`;
  }).join('');
}

function drawRoute(geo) {
  if (S.routeLayer) S.map.removeLayer(S.routeLayer);
  S.routeLayer = L.geoJSON(geo, { style: { color: '#2563eb', weight: 5, opacity: .72 } }).addTo(S.map);
  S.map.fitBounds(S.routeLayer.getBounds(), { padding: [20, 20] });
}

function drawLines(pts) {
  if (S.routeLayer) S.map.removeLayer(S.routeLayer);
  S.routeLayer = L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#2563eb', weight: 3, opacity: .6, dashArray: '8,8' }).addTo(S.map);
  S.map.fitBounds(S.routeLayer.getBounds(), { padding: [20, 20] });
}

async function recalcTrackingProjection(anchor, remainingWps, opts = {}) {
  const destination = opts.destination || getBasePoint(S.endPt) || anchor;
  const sc = getSched();
  if (validateSched(sc)) return null;

  const pts = [anchor, ...remainingWps, destination].filter(Boolean);
  const osrm = pts.length > 1 ? await getOsrmRoute(pts) : null;
  return buildSchedule(remainingWps, anchor, sc, osrm, {
    destination,
    startLabel: opts.startLabel || getBaseLabel(S.startPt),
    endLabel: opts.endLabel || getBaseLabel(S.endPt),
    startMinOverride: Number.isFinite(opts.startMinOverride) ? opts.startMinOverride : nowMin()
  });
}

function applyProjectionToRemaining(startIdx, projection) {
  if (!projection || !S.route) return;
  const steps = projection.itin.filter(step => step.type === 'wp');
  steps.forEach((step, offset) => {
    const wp = S.waypoints[startIdx + offset];
    if (!wp) return;
    wp.plannedArrival = m2t(step.arrival);
    wp.plannedDeparture = m2t(step.depart);
    wp.scheduleConflict = step.wp.scheduleConflict || null;
  });

  const completedDwell = S.waypoints.slice(0, startIdx).reduce((sum, wp) => sum + (parseDwell(wp.dwell, 0) || 0), 0);
  S.route.endT = projection.endT;
  S.route.totalDist = projection.totalDist;
  S.route.totalTravel = projection.totalTravel;
  S.route.totalDwell = completedDwell + steps.reduce((sum, step) => sum + step.wp.dwell, 0);
  S.route.totalWork = S.route.totalTravel + S.route.totalDwell;
  S.route.endLabel = projection.endLabel || getBaseLabel(S.endPt);
  rebuildItin();
}

function toggleTracking() {
  S.trk.active ? stopTracking() : startTracking();
}

async function startTracking() {
  if (!S.route) { notify('Calcula la ruta primero', 'error'); return; }
  const { origin, destination, startLabel, endLabel } = getRouteEndpoints();
  if (!origin || !destination) {
    notify('Revisa Casa y Trabajo antes de iniciar la ruta', 'error');
    showTab('setup');
    return;
  }

  const refreshed = await recalcTrackingProjection(origin, [...S.waypoints], {
    destination, startLabel, endLabel, startMinOverride: nowMin()
  });
  if (refreshed) {
    S.route = refreshed;
    S.routeData = { origin, destination, osrm: null, startLabel, endLabel };
    renderRoute(refreshed);
    renderWPs();
  }

  S.trk.active = true;
  S.trk.startedAt = Date.now();
  S.trk.delay = 0;
  S.trk.currentIdx = 0;
  S.trk.wps = S.waypoints.map(wp => ({
    id: wp.id,
    status: 'pending',
    arrivedAt: null,
    leftAt: null,
    actualDelay: null
  }));
  if (S.trk.wps.length) S.trk.wps[0].status = 'traveling';

  document.getElementById('trackBtn').innerHTML = '<i class="fas fa-stop" style="color:#ef4444"></i> Parar';
  document.getElementById('trkTabBtn').style.display = '';
  showTab('tracking');
  saveTrkState();
  saveStorage();
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

async function trkArrived() {
  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = S.waypoints.find(w => w.id === tw?.id);
  if (!tw || !wp || tw.status === 'at_client') return;

  tw.status = 'at_client';
  tw.arrivedAt = Date.now();

  const plannedMin = t2m(wp.plannedArrival || nowT());
  const actualMin = nowMin();
  tw.actualDelay = actualMin - plannedMin;
  S.trk.delay = tw.actualDelay;
  wp.plannedArrival = nowT();
  wp.plannedDeparture = m2t(actualMin + wp.dwell);

  const remaining = S.waypoints.slice(S.trk.currentIdx + 1);
  const projection = await recalcTrackingProjection(wp, remaining, {
    destination: getBasePoint(S.endPt),
    startLabel: wp.name,
    endLabel: getBaseLabel(S.endPt),
    startMinOverride: actualMin + wp.dwell
  });
  applyProjectionToRemaining(S.trk.currentIdx + 1, projection);

  startClientTimer(tw.arrivedAt, wp.dwell);
  saveTrkState();
  saveStorage();
  renderTrkPanel();
}

async function trkLeft() {
  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = S.waypoints.find(w => w.id === tw?.id);
  if (!tw || !wp || tw.status !== 'at_client') return;

  if (S.trk.timerInterval) { clearInterval(S.trk.timerInterval); S.trk.timerInterval = null; }
  tw.status = 'done';
  tw.leftAt = Date.now();

  const plannedDepMin = t2m(wp.plannedDeparture || nowT());
  const actualDepMin = nowMin();
  const newDelay = actualDepMin - plannedDepMin;
  S.trk.delay = newDelay;
  wp.plannedDeparture = nowT();

  S.trk.currentIdx++;
  if (S.trk.currentIdx < S.trk.wps.length) S.trk.wps[S.trk.currentIdx].status = 'traveling';

  const remaining = S.waypoints.slice(S.trk.currentIdx);
  const projection = await recalcTrackingProjection(wp, remaining, {
    destination: getBasePoint(S.endPt),
    startLabel: wp.name,
    endLabel: getBaseLabel(S.endPt),
    startMinOverride: actualDepMin
  });
  applyProjectionToRemaining(S.trk.currentIdx, projection);

  addWPMarker(wp);
  saveTrkState();
  saveStorage();
  renderTrkPanel();
  renderWPs();

  if (S.trk.currentIdx >= S.trk.wps.length) notify('🎉 ¡Has completado todas las paradas!', 'success');
}

async function trkReopen(idx) {
  if (!S.trk.active || idx < 0 || idx >= S.waypoints.length) return;
  if (S.trk.timerInterval) { clearInterval(S.trk.timerInterval); S.trk.timerInterval = null; }

  S.trk.currentIdx = idx;
  S.trk.wps.forEach((tw, i) => {
    if (i < idx && tw.status === 'done') return;
    tw.status = i === idx ? 'traveling' : 'pending';
    if (i >= idx) {
      tw.arrivedAt = null;
      tw.leftAt = null;
      tw.actualDelay = null;
    }
  });

  const anchor = idx > 0 ? S.waypoints[idx - 1] : getBasePoint(S.startPt);
  const projection = await recalcTrackingProjection(anchor, S.waypoints.slice(idx), {
    destination: getBasePoint(S.endPt),
    startLabel: idx > 0 ? S.waypoints[idx - 1].name : getBaseLabel(S.startPt),
    endLabel: getBaseLabel(S.endPt),
    startMinOverride: nowMin()
  });
  applyProjectionToRemaining(idx, projection);
  S.trk.delay = 0;
  S.trk._prevDelay = 0;
  S.waypoints.forEach(wp => addWPMarker(wp));
  renderWPs();
  renderTrkPanel();
  saveStorage();
  notify('Parada reactivada', 'success');
}

function startClientTimer(arrivedAt, dwellMin) {
  if (S.trk.timerInterval) clearInterval(S.trk.timerInterval);
  const planned = dwellMin * 60 * 1000;

  function tick() {
    const elapsed = Date.now() - arrivedAt;
    const elSec = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(elSec / 60)).padStart(2, '0');
    const ss = String(elSec % 60).padStart(2, '0');
    const el = document.getElementById('trkTimer');
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

function renderTrkPanel() {
  const total = S.trk.wps.length;
  const done = S.trk.wps.filter(w => w.status === 'done').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const delay = S.trk.delay;

  document.getElementById('trkProgText').textContent = `${done} / ${total} paradas`;
  document.getElementById('trkProgBar').style.width = pct + '%';
  document.getElementById('trkStartTime').textContent = S.route?.startT || '—';
  document.getElementById('trkEndTime').textContent = S.route?.endT || '—';

  const badge = document.getElementById('trkDelayBadge');
  if (delay > 5) { badge.textContent = `+${delay}min tarde`; badge.style.background = '#dc2626'; }
  else if (delay < -5) { badge.textContent = `${Math.abs(delay)}min antes`; badge.style.background = '#16a34a'; }
  else { badge.textContent = 'En hora'; badge.style.background = '#2563eb'; }

  const tw = S.trk.wps[S.trk.currentIdx];
  const wp = tw ? S.waypoints.find(w => w.id === tw.id) : null;
  const card = document.getElementById('trkCurrentCard');

  if (!wp) {
    card.style.borderColor = '#16a34a';
    document.getElementById('trkCurrentLabel').textContent = '✅ JORNADA COMPLETADA';
    document.getElementById('trkCurrentName').textContent = '¡Todas las paradas visitadas!';
    document.getElementById('trkCurrentAddr').textContent = `Fin: ${S.route?.endT || ''}`;
    document.getElementById('trkArrivedBtn').style.display = 'none';
    document.getElementById('trkLeftBtn').style.display = 'none';
    document.getElementById('trkTimerBlock').style.display = 'none';
    document.getElementById('trkMapsLink').href = '#';
    document.getElementById('trkWazeLink').href = '#';
  } else {
    const isAt = tw.status === 'at_client';
    card.style.borderColor = isAt ? '#16a34a' : '#2563eb';
    document.getElementById('trkCurrentLabel').textContent = isAt ? '🟢 EN CLIENTE' : '📍 PRÓXIMA PARADA';
    document.getElementById('trkCurrentName').textContent = wp.name;
    document.getElementById('trkCurrentAddr').textContent = `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
    document.getElementById('trkPlanned').textContent = wp.plannedArrival || '—';
    document.getElementById('trkEstimated').textContent = wp.plannedArrival || '—';
    document.getElementById('trkDwell').textContent = fmtHM(wp.dwell);

    document.getElementById('trkMapsLink').href = `https://www.google.com/maps/dir/?api=1&destination=${wp.lat},${wp.lng}&travelmode=driving`;
    document.getElementById('trkWazeLink').href = `https://waze.com/ul?ll=${wp.lat},${wp.lng}&navigate=yes`;
    document.getElementById('trkArrivedBtn').style.display = tw.status === 'traveling' ? '' : 'none';
    document.getElementById('trkLeftBtn').style.display = tw.status === 'at_client' ? '' : 'none';

    if (isAt && tw.arrivedAt) {
      document.getElementById('trkTimerBlock').style.display = '';
      startClientTimer(tw.arrivedAt, wp.dwell);
    } else {
      document.getElementById('trkTimerBlock').style.display = 'none';
    }
  }

  renderTrkItinerary();
}

function renderTrkItinerary() {
  const el = document.getElementById('trkItinerary');
  if (!el) return;

  el.innerHTML = S.waypoints.map((wp, i) => {
    const tw = S.trk.wps[i];
    const status = tw?.status || 'pending';
    const isDone = status === 'done';
    const isCur = status === 'traveling' || status === 'at_client';

    let leftTime = '';
    if (isDone && tw.leftAt) {
      const d = new Date(tw.leftAt);
      leftTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

    return `<div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start;opacity:${isDone ? '.55' : '1'};${isCur ? 'background:#eff6ff;margin:0 -12px;padding:8px 12px;border-radius:6px;' : ''}">
      <div style="width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:800;color:#fff;background:${isDone ? '#6b7280' : isCur ? '#2563eb' : '#e2e8f0'};color:${isCur || isDone ? '#fff' : '#6b7280'}">
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
      ${isCur ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${wp.lat},${wp.lng}&travelmode=driving" target="_blank" rel="noopener" style="font-size:.7rem;padding:4px 8px;background:#2563eb;color:#fff;border-radius:5px;text-decoration:none;white-space:nowrap;flex-shrink:0">Navegar</a>` : ''}
      ${status === 'done' ? `<button class="btn bg bi bsm" onclick="trkReopen(${i})" type="button" title="Reactivar parada">↺</button>` : ''}
    </div>`;
  }).join('');
}

function nowMin() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

function nowT() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
}
