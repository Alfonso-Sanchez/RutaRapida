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
  const colors = { success: '#15803d', error: '#dc2626', '': '#1e293b' };
  const n = document.createElement('div');
  n.className = 'notif';
  n.setAttribute('role', 'status');
  n.setAttribute('aria-live', 'polite');
  n.style.background = colors[type] || colors[''];
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

const LS_KEY = 'rr2';

function saveStorage() {
  try {
    const snap = {
      v: 3,
      ts: Date.now(),
      home: S.home,
      work: S.work,
      startPt: S.startPt,
      endPt: S.endPt,
      nid: S.nid,
      schedMode: S.schedMode,
      sched: {
        mStart: document.getElementById('mStart')?.value || '08:00',
        mEnd: document.getElementById('mEnd')?.value || '13:30',
        aStart: document.getElementById('aStart')?.value || '16:00',
        aEnd: document.getElementById('aEnd')?.value || '18:30',
        cStart: document.getElementById('cStart')?.value || '08:00',
        cHours: document.getElementById('cHours')?.value || '8'
      },
      waypoints: S.waypoints.map(w => ({
        id: w.id,
        lat: w.lat,
        lng: w.lng,
        name: w.name,
        dwell: w.dwell,
        openTime: w.openTime || null,
        closeTime: w.closeTime || null,
        openTime2: w.openTime2 || null,
        closeTime2: w.closeTime2 || null,
        openingHoursRaw: w.openingHoursRaw || null,
        desiredArrival: w.desiredArrival || null,
        plannedArrival: w.plannedArrival || null,
        plannedDeparture: w.plannedDeparture || null,
        scheduleConflict: w.scheduleConflict || null
      })),
      route: S.route ? {
        startT: S.route.startT,
        endT: S.route.endT,
        totalDist: S.route.totalDist || 0,
        totalTravel: S.route.totalTravel || 0,
        totalDwell: S.route.totalDwell || 0,
        totalWork: S.route.totalWork || 0,
        mode: S.route.mode || 'auto',
        startLabel: S.route.startLabel || getBaseLabel(S.startPt),
        endLabel: S.route.endLabel || getBaseLabel(S.endPt)
      } : null,
      trk: S.trk.active ? {
        active: true,
        startedAt: S.trk.startedAt,
        currentIdx: S.trk.currentIdx,
        delay: S.trk.delay || 0,
        _prevDelay: S.trk._prevDelay || 0,
        wps: S.trk.wps
      } : null
    };

    localStorage.setItem(LS_KEY, JSON.stringify(snap));
  } catch (e) {
    console.error('saveStorage:', e);
  }
}

function saveTrkState() { saveStorage(); }

function rebuildItin() {
  if (!S.route || !S.waypoints.length) return;
  const origin = getBasePoint(S.startPt);
  const destination = getBasePoint(S.endPt);
  if (!origin || !destination) return;
  const startLabel = S.route.startLabel || getBaseLabel(S.startPt);
  const endLabel = S.route.endLabel || getBaseLabel(S.endPt);

  const itin = [];
  itin.push({ type: 'start', name: startLabel, time: S.route.startT, icon: S.startPt === 'home' ? '🏠' : '💼', color: '#2563eb' });

  let prevDep = S.route.startT;
  S.waypoints.forEach((wp, i) => {
    if (!wp.plannedArrival) return;
    const travelMin = Math.max(0, t2m(wp.plannedArrival) - t2m(prevDep));
    itin.push({ type: 'travel', from: i === 0 ? startLabel : S.waypoints[i - 1].name, to: wp.name, dur: travelMin, dist: 0 });
    itin.push({ type: 'wp', wp, arrival: t2m(wp.plannedArrival), depart: t2m(wp.plannedDeparture || wp.plannedArrival), wpIdx: i + 1 });
    prevDep = wp.plannedDeparture || wp.plannedArrival;
  });

  const retMin = Math.max(0, t2m(S.route.endT) - t2m(prevDep));
  const last = S.waypoints.filter(w => w.plannedArrival).slice(-1)[0];
  if (last) itin.push({ type: 'travel', from: last.name, to: endLabel, dur: retMin, dist: 0 });
  itin.push({ type: 'end', name: endLabel, time: S.route.endT, icon: S.endPt === 'home' ? '🏠' : '💼', color: '#16a34a' });

  S.route.itin = itin;
}

function loadStorage() {
  let raw = localStorage.getItem(LS_KEY);
  if (!raw) raw = localStorage.getItem('rr');
  if (!raw) return;

  let d;
  try { d = JSON.parse(raw); } catch (e) { console.error('loadStorage parse:', e); return; }

  try {
    if (d.home) { S.home = d.home; updateBaseUI('home'); setMk('home', d.home.lat, d.home.lng, '🏠', '#2563eb'); }
    if (d.work) { S.work = d.work; updateBaseUI('work'); setMk('work', d.work.lat, d.work.lng, '💼', '#7c3aed'); }
    if (d.startPt) setStart(d.startPt);
    if (d.endPt) setEnd(d.endPt);
    if (d.nid) S.nid = d.nid;
    if (d.schedMode) setMode(d.schedMode);
    if (d.sched) {
      const f = id => document.getElementById(id);
      ['mStart', 'mEnd', 'aStart', 'aEnd', 'cStart', 'cHours'].forEach(k => {
        if (d.sched[k]) f(k).value = d.sched[k];
      });
    }

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

    if (d.route) {
      S.route = { ...d.route };
      S.routeData = {
        origin: getBasePoint(S.startPt),
        destination: getBasePoint(S.endPt),
        osrm: null,
        startLabel: d.route.startLabel || getBaseLabel(S.startPt),
        endLabel: d.route.endLabel || getBaseLabel(S.endPt)
      };
      rebuildItin();
      renderRoute(S.route);
      if (S.route.itin) document.getElementById('trackBtn').style.display = 'flex';
    }

    const pts = [d.home, d.work, ...(d.waypoints || [])].filter(Boolean);
    if (pts.length > 1) S.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [40, 40] });
    else if (pts.length === 1) S.map.setView([pts[0].lat, pts[0].lng], 13);

    const trk = d.trk;
    if (trk?.active && S.waypoints.length) {
      S.trk.active = true;
      S.trk.startedAt = trk.startedAt || Date.now();
      S.trk.currentIdx = Math.min(trk.currentIdx || 0, Math.max(0, (trk.wps?.length || 1) - 1));
      S.trk.delay = trk.delay || 0;
      S.trk._prevDelay = trk._prevDelay || 0;
      S.trk.wps = Array.isArray(trk.wps) ? trk.wps : [];

      document.getElementById('trackBtn').innerHTML = '<i class="fas fa-stop" style="color:#ef4444"></i> Parar';
      document.getElementById('trkTabBtn').style.display = '';
      renderTrkPanel();
      showTab('tracking');

      const curTw = S.trk.wps[S.trk.currentIdx];
      const curWp = curTw ? S.waypoints.find(w => w.id === curTw.id) : null;
      if (curTw?.status === 'at_client' && curTw.arrivedAt && curWp) startClientTimer(curTw.arrivedAt, curWp.dwell);
      notify('Seguimiento restaurado ✓', 'success');
    } else if (S.waypoints.length) {
      notify(`Sesión restaurada · ${S.waypoints.length} puntos`, 'success');
    }
  } catch (e) {
    console.error('loadStorage apply:', e);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    S.addingPt = false;
    S.setLocFor = null;
    setCursor('');
    closeModal();
    closeLocModal();
    document.getElementById('searchResults').style.display = 'none';
    clearSearchMarkers();
  }
});

document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlace(); });
document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') parseUrl(); });
document.getElementById('bizInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchBusiness(); });
document.getElementById('locInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchLoc(); });

window.addEventListener('DOMContentLoaded', initMap);
