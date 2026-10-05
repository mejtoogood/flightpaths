(() => {
  'use strict';

  const DATA_URL = './yscb-rwy35-raw/flightpaths.csv';
  const ALT_CUTOFF_FT = 2000 * 3.280839895;
  const RUNWAY_ELEVATION_M = 575;
  const RUNWAY_TRACK_DEG = 359;
  const CAPTURE_GAP_SECONDS = 6 * 60 * 60;
  const APPROACH_TRACK_TOLERANCE = 30;
  const EXIT_TURN_DEG = 20;

  const equipmentColours = {
    B738: Cesium.Color.fromCssColorString('#ff6b6b'),
    E190: Cesium.Color.fromCssColorString('#54d2d2'),
    DH8D: Cesium.Color.fromCssColorString('#ffd166'),
    BC3:  Cesium.Color.fromCssColorString('#8bd17c')
  };

  const viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: false,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    infoBox: true,
    selectionIndicator: true,
    fullscreenButton: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider()
  });

  viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/'
  }));
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.skyAtmosphere.show = true;

  const state = {
    flights: [],
    entities: [],
    equipmentEnabled: new Map(),
    selectedFlight: 'all',
    verticalExaggeration: 1
  };

  const el = id => document.getElementById(id);

  function angularDiff(a, b) {
    return Math.abs(((Number(a) - Number(b) + 180) % 360 + 360) % 360 - 180);
  }

  function circularMean(values) {
    if (!values.length) return NaN;
    let s = 0, c = 0;
    for (const v of values) {
      const r = Cesium.Math.toRadians(Number(v));
      s += Math.sin(r);
      c += Math.cos(r);
    }
    return (Cesium.Math.toDegrees(Math.atan2(s / values.length, c / values.length)) + 360) % 360;
  }

  function splitPosition(value) {
    const parts = String(value || '').split(',');
    return [Number(parts[0]), Number(parts[1])];
  }

  function normalizeRow(r) {
    const [lat, lon] = splitPosition(r.Position);
    return {
      timestamp: Number(r.Timestamp),
      utc: r.UTC,
      callsign: r.Callsign,
      lat,
      lon,
      altitude: Number(r.Altitude),
      speed: Number(r.Speed),
      direction: Number(r.Direction),
      flightNr: r.FlightNr,
      equipment: r.Equipment
    };
  }

  function segmentCaptures(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.flightNr}|${row.equipment}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const captures = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.timestamp - b.timestamp);
      let current = [];
      for (const row of group) {
        if (current.length && row.timestamp - current[current.length - 1].timestamp > CAPTURE_GAP_SECONDS) {
          captures.push(current);
          current = [];
        }
        current.push(row);
      }
      if (current.length) captures.push(current);
    }
    return captures;
  }

  function classifyCapture(rows, sequence) {
    let touchdown = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].altitude > 0 && rows[i].altitude === 0) touchdown = i;
    }
    if (touchdown < 0) return null;

    const pre = rows.slice(Math.max(0, touchdown - 10), touchdown).filter(r => r.speed > 50);
    if (!pre.length) return null;
    const approachTrack = circularMean(pre.map(r => r.direction));
    if (angularDiff(approachTrack, 0) >= APPROACH_TRACK_TOLERANCE) return null;

    let start = 0;
    for (let i = 0; i < touchdown; i++) {
      if (rows[i].altitude > ALT_CUTOFF_FT) start = i + 1;
    }

    let end = rows.length - 1;
    for (let i = touchdown + 1; i < rows.length; i++) {
      if (angularDiff(rows[i].direction, RUNWAY_TRACK_DEG) > EXIT_TURN_DEG) {
        end = i;
        break;
      }
    }

    const date = new Date(rows[touchdown].timestamp * 1000);
    const dateText = new Intl.DateTimeFormat('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', hour12: false
    }).format(date) + ' UTC';

    return {
      id: `flight-${sequence}`,
      flightNr: rows[0].flightNr,
      equipment: rows[0].equipment,
      callsign: rows[touchdown].callsign,
      dateText,
      approachTrack,
      approach: rows.slice(start, touchdown + 1),
      rollout: rows.slice(touchdown, end + 1),
      touchdown: rows[touchdown],
      exit: rows[end]
    };
  }

  function displayHeight(row) {
    const rawM = row.altitude > 0 ? row.altitude * 0.3048 : RUNWAY_ELEVATION_M;
    return RUNWAY_ELEVATION_M + Math.max(0, rawM - RUNWAY_ELEVATION_M) * state.verticalExaggeration;
  }

  function positions(rows) {
    return rows.map(r => Cesium.Cartesian3.fromDegrees(r.lon, r.lat, displayHeight(r)));
  }

  function colourFor(equipment) {
    return equipmentColours[equipment] || Cesium.Color.WHITE;
  }

  function descriptionFor(f) {
    const td = f.touchdown;
    return `
      <table class="cesium-infoBox-defaultTable"><tbody>
        <tr><th>Flight</th><td>${f.flightNr}</td></tr>
        <tr><th>Callsign</th><td>${f.callsign}</td></tr>
        <tr><th>Equipment</th><td>${f.equipment}</td></tr>
        <tr><th>Touchdown</th><td>${f.dateText}</td></tr>
        <tr><th>Approach track</th><td>${f.approachTrack.toFixed(1)}°</td></tr>
        <tr><th>Touchdown speed</th><td>${td.speed.toFixed(0)}</td></tr>
      </tbody></table>`;
  }

  function addFlightEntities(f) {
    const colour = colourFor(f.equipment);
    const description = descriptionFor(f);

    const approach = viewer.entities.add({
      id: `${f.id}-approach`, name: `${f.flightNr} · ${f.equipment} · Approach`, description,
      polyline: { positions: positions(f.approach), width: 2.2, material: colour.withAlpha(0.82), arcType: Cesium.ArcType.NONE }
    });
    approach.flightId = f.id; approach.phase = 'approach'; approach.equipmentCode = f.equipment;

    const rollout = viewer.entities.add({
      id: `${f.id}-rollout`, name: `${f.flightNr} · ${f.equipment} · Rollout`, description,
      polyline: { positions: positions(f.rollout), width: 4.0, material: Cesium.Color.WHITE.withAlpha(0.95), arcType: Cesium.ArcType.NONE }
    });
    rollout.flightId = f.id; rollout.phase = 'rollout'; rollout.equipmentCode = f.equipment;

    const td = viewer.entities.add({
      id: `${f.id}-touchdown`, name: `${f.flightNr} · Touchdown`, description,
      position: Cesium.Cartesian3.fromDegrees(f.touchdown.lon, f.touchdown.lat, displayHeight(f.touchdown)),
      point: { pixelSize: 7, color: colour, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY }
    });
    td.flightId = f.id; td.phase = 'touchdown'; td.equipmentCode = f.equipment;

    state.entities.push(approach, rollout, td);
  }

  function rebuildHeights() {
    for (const f of state.flights) {
      viewer.entities.getById(`${f.id}-approach`).polyline.positions = positions(f.approach);
      viewer.entities.getById(`${f.id}-rollout`).polyline.positions = positions(f.rollout);
      viewer.entities.getById(`${f.id}-touchdown`).position = Cesium.Cartesian3.fromDegrees(
        f.touchdown.lon, f.touchdown.lat, displayHeight(f.touchdown)
      );
    }
    viewer.scene.requestRender();
  }

  function applyFilters() {
    const selected = state.selectedFlight;
    let visibleFlights = new Set();
    let visiblePoints = 0;

    for (const f of state.flights) {
      const visible = state.equipmentEnabled.get(f.equipment) !== false && (selected === 'all' || selected === f.id);
      if (visible) {
        visibleFlights.add(f.id);
        visiblePoints += f.approach.length + Math.max(0, f.rollout.length - 1);
      }
    }

    for (const entity of state.entities) {
      const flightVisible = visibleFlights.has(entity.flightId);
      const phaseVisible = entity.phase === 'approach' ? el('showApproach').checked
        : entity.phase === 'rollout' ? el('showRollout').checked
        : el('showTouchdown').checked;
      entity.show = flightVisible && phaseVisible;
    }

    el('flightCount').textContent = visibleFlights.size;
    el('pointCount').textContent = visiblePoints.toLocaleString('en-AU');
    viewer.scene.requestRender();
  }

  function populateControls() {
    const equipment = [...new Set(state.flights.map(f => f.equipment))].sort();
    const equipmentBox = el('equipmentFilters');
    for (const eq of equipment) {
      state.equipmentEnabled.set(eq, true);
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = true; input.dataset.equipment = eq;
      input.addEventListener('change', () => { state.equipmentEnabled.set(eq, input.checked); applyFilters(); });
      const swatch = document.createElement('span');
      swatch.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${colourFor(eq).toCssColorString()}`;
      label.append(input, swatch, document.createTextNode(eq));
      equipmentBox.appendChild(label);
    }

    const flightSelect = el('flightSelect');
    const ordered = [...state.flights].sort((a, b) => a.touchdown.timestamp - b.touchdown.timestamp);
    for (const f of ordered) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.flightNr} · ${f.equipment} · ${f.dateText}`;
      flightSelect.appendChild(opt);
    }
    flightSelect.addEventListener('change', () => { state.selectedFlight = flightSelect.value; applyFilters(); zoomVisible(); });

    for (const id of ['showApproach', 'showRollout', 'showTouchdown']) el(id).addEventListener('change', applyFilters);

    el('exaggeration').addEventListener('input', event => {
      state.verticalExaggeration = Number(event.target.value);
      el('exaggerationValue').textContent = `${state.verticalExaggeration}×`;
      rebuildHeights();
    });

    el('overviewBtn').addEventListener('click', zoomVisible);
    el('runwayBtn').addEventListener('click', flyToRunway);
    el('terrainBtn').addEventListener('click', () => enableTerrain(el('ionToken').value));
  }

  function visibleEntities() {
    return state.entities.filter(e => e.show);
  }

  function zoomVisible() {
    const entities = visibleEntities();
    if (entities.length) viewer.zoomTo(entities, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), 0));
  }

  function flyToRunway() {
    const flights = state.flights.filter(f => state.equipmentEnabled.get(f.equipment) !== false && (state.selectedFlight === 'all' || state.selectedFlight === f.id));
    if (!flights.length) return;
    const lat = flights.reduce((s, f) => s + f.touchdown.lat, 0) / flights.length;
    const lon = flights.reduce((s, f) => s + f.touchdown.lon, 0) / flights.length;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 3200),
      orientation: { heading: Cesium.Math.toRadians(350), pitch: Cesium.Math.toRadians(-42), roll: 0 },
      duration: 1.2
    });
  }

  async function enableTerrain(token) {
    const status = el('terrainStatus');
    const trimmed = String(token || '').trim();
    if (!trimmed) { status.textContent = 'Enter a Cesium ion public token first.'; return; }
    status.textContent = 'Loading world terrain…';
    try {
      Cesium.Ion.defaultAccessToken = trimmed;
      viewer.scene.globe.terrainProvider = await Cesium.createWorldTerrainAsync();
      localStorage.setItem('cesiumIonToken', trimmed);
      status.textContent = 'Cesium World Terrain enabled';
      viewer.scene.requestRender();
    } catch (err) {
      console.error(err);
      status.textContent = 'Terrain failed to load. Check the token and browser console.';
    }
  }

  async function loadData() {
    try {
      el('loadStatus').textContent = 'Downloading flight data…';
      const response = await fetch(DATA_URL + '?v=6', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const csvText = await response.text();
      el('loadStatus').textContent = 'Parsing flight data…';

      const results = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true
      });

      if (results.errors && results.errors.length) {
        console.warn('CSV parse warnings:', results.errors.slice(0, 10));
      }

      const rows = results.data.map(normalizeRow).filter(r =>
        Number.isFinite(r.timestamp) &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon)
      );

      const captures = segmentCaptures(rows);
      state.flights = captures.map((c, i) => classifyCapture(c, i + 1)).filter(Boolean);

      for (const f of state.flights) addFlightEntities(f);
      populateControls();
      applyFilters();
      zoomVisible();

      el('loadStatus').textContent =
        `${captures.length} captures recovered · ${state.flights.length} classified as RWY 35 landings · source cutoff ${ALT_CUTOFF_FT.toFixed(0)} ft (2,000 m)`;

      const savedToken = localStorage.getItem('cesiumIonToken');
      if (savedToken) {
        el('ionToken').value = savedToken;
        enableTerrain(savedToken);
      }
    } catch (err) {
      console.error(err);
      el('loadStatus').textContent = `Flight data load failed: ${err.message || err}`;
    }
  }

  loadData();
})();