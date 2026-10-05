(() => {
  'use strict';

  const app = window.flightpathsApp;
  if (!app) throw new Error('flightpathsApp was not initialised');

  const { viewer, state, el } = app;
  const AVIATION_URL = './data/yscb-aviation.json';
  const FT_TO_M = 0.3048;
  let aviation = null;
  let googleTileset = null;
  let overlayOpacity = 0.75;
  const groups = {
    runway: [],
    touchdownZone: [],
    glideLine: [],
    glideRibbon: [],
    glideCorridor: [],
    marker: []
  };

  function clearGroup(name) {
    for (const entity of groups[name]) viewer.entities.remove(entity);
    groups[name] = [];
  }

  function clearAll() {
    for (const name of Object.keys(groups)) clearGroup(name);
  }

  function threshold() {
    return aviation.runway35.threshold;
  }

  function thresholdElevationFt() {
    return aviation.runway35.threshold.elevationFtAmsl;
  }

  function renderHeightFromAboveThreshold(metres) {
    return state.renderAnchorM + metres * state.verticalExaggeration;
  }

  function cartesian(coord, aboveThresholdM = 0) {
    return Cesium.Cartesian3.fromDegrees(coord[0], coord[1], renderHeightFromAboveThreshold(aboveThresholdM));
  }

  function closed(coords) {
    return [...coords, coords[0]];
  }

  function colour(css, alpha = 1) {
    return Cesium.Color.fromCssColorString(css).withAlpha(alpha * overlayOpacity);
  }

  function geodesicPoint(startCoord, endCoord, metres) {
    const start = Cesium.Cartographic.fromDegrees(startCoord[0], startCoord[1]);
    const end = Cesium.Cartographic.fromDegrees(endCoord[0], endCoord[1]);
    const geodesic = new Cesium.EllipsoidGeodesic(start, end);
    const p = geodesic.interpolateUsingSurfaceDistance(metres);
    return [Cesium.Math.toDegrees(p.longitude), Cesium.Math.toDegrees(p.latitude)];
  }

  function offsetPoint(centerCoord, bearingDeg, metres) {
    const earthRadius = 6378137;
    const d = metres / earthRadius;
    const brng = Cesium.Math.toRadians(bearingDeg);
    const lat1 = Cesium.Math.toRadians(centerCoord[1]);
    const lon1 = Cesium.Math.toRadians(centerCoord[0]);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [Cesium.Math.toDegrees(lon2), Cesium.Math.toDegrees(lat2)];
  }

  function pathSamples() {
    const gp = aviation.glidepath;
    const samples = [];
    for (let d = 0; d <= gp.rangeM; d += 250) {
      const center = geodesicPoint(
        [gp.nominalGroundIntercept.lon, gp.nominalGroundIntercept.lat],
        [gp.approachEnd.lon, gp.approachEnd.lat],
        d
      );
      const nominalAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg)) * d;
      const lowerAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg - gp.beamHalfWidthDeg)) * d;
      const upperAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg + gp.beamHalfWidthDeg)) * d;
      const left = offsetPoint(center, aviation.runway35.trueBearingDeg - 90, gp.visualWidthM / 2);
      const right = offsetPoint(center, aviation.runway35.trueBearingDeg + 90, gp.visualWidthM / 2);
      samples.push({ d, center, left, right, nominalAboveM, lowerAboveM, upperAboveM });
    }
    if (samples.at(-1).d !== gp.rangeM) {
      const d = gp.rangeM;
      const center = [gp.approachEnd.lon, gp.approachEnd.lat];
      const nominalAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg)) * d;
      const lowerAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg - gp.beamHalfWidthDeg)) * d;
      const upperAboveM = Math.tan(Cesium.Math.toRadians(gp.angleDeg + gp.beamHalfWidthDeg)) * d;
      const left = offsetPoint(center, aviation.runway35.trueBearingDeg - 90, gp.visualWidthM / 2);
      const right = offsetPoint(center, aviation.runway35.trueBearingDeg + 90, gp.visualWidthM / 2);
      samples.push({ d, center, left, right, nominalAboveM, lowerAboveM, upperAboveM });
    }
    return samples;
  }

  function polygonEntity(id, coords, heights, css, alpha) {
    const positions = coords.map((coord, i) => Cesium.Cartesian3.fromDegrees(coord[0], coord[1], heights[i]));
    return viewer.entities.add({
      id,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        perPositionHeight: true,
        material: colour(css, alpha),
        outline: false
      }
    });
  }

  function rebuildOverlays() {
    if (!aviation) return;
    clearAll();

    const base = state.renderAnchorM;
    const rw = aviation.runway35;
    const samples = pathSamples();

    groups.runway.push(viewer.entities.add({
      id: 'aviation-runway-outline',
      name: 'RWY 35 landing runway outline',
      polyline: {
        positions: closed(rw.outline).map(coord => cartesian(coord, 0.6)),
        width: 3,
        material: colour('#ffe082', 1),
        arcType: Cesium.ArcType.NONE
      }
    }));

    groups.touchdownZone.push(polygonEntity(
      'aviation-touchdown-zone',
      rw.touchdownZone.outline,
      rw.touchdownZone.outline.map(() => base + 0.8),
      '#4dd0e1',
      0.26
    ));
    groups.touchdownZone.push(viewer.entities.add({
      id: 'aviation-touchdown-zone-outline',
      polyline: {
        positions: closed(rw.touchdownZone.outline).map(coord => cartesian(coord, 1)),
        width: 2,
        material: colour('#4dd0e1', 0.95),
        arcType: Cesium.ArcType.NONE
      }
    }));

    groups.glideLine.push(viewer.entities.add({
      id: 'aviation-glidepath-line',
      name: 'RWY 35 nominal 3° glidepath',
      polyline: {
        positions: samples.map(s => cartesian(s.center, s.nominalAboveM)),
        width: 3,
        material: colour('#80cbc4', 1),
        arcType: Cesium.ArcType.NONE
      }
    }));

    const ribbonCoords = [...samples.map(s => s.left), ...[...samples].reverse().map(s => s.right)];
    const ribbonHeights = [...samples.map(s => renderHeightFromAboveThreshold(s.nominalAboveM)), ...[...samples].reverse().map(s => renderHeightFromAboveThreshold(s.nominalAboveM))];
    groups.glideRibbon.push(polygonEntity('aviation-glidepath-ribbon', ribbonCoords, ribbonHeights, '#80cbc4', 0.25));

    const lowerCoords = [...samples.map(s => s.left), ...[...samples].reverse().map(s => s.right)];
    const lowerHeights = [...samples.map(s => renderHeightFromAboveThreshold(s.lowerAboveM)), ...[...samples].reverse().map(s => renderHeightFromAboveThreshold(s.lowerAboveM))];
    const upperCoords = lowerCoords;
    const upperHeights = [...samples.map(s => renderHeightFromAboveThreshold(s.upperAboveM)), ...[...samples].reverse().map(s => renderHeightFromAboveThreshold(s.upperAboveM))];
    const sideLeftCoords = [...samples.map(s => s.left), ...[...samples].reverse().map(s => s.left)];
    const sideLeftHeights = [...samples.map(s => renderHeightFromAboveThreshold(s.lowerAboveM)), ...[...samples].reverse().map(s => renderHeightFromAboveThreshold(s.upperAboveM))];
    const sideRightCoords = [...samples.map(s => s.right), ...[...samples].reverse().map(s => s.right)];
    const sideRightHeights = [...samples.map(s => renderHeightFromAboveThreshold(s.lowerAboveM)), ...[...samples].reverse().map(s => renderHeightFromAboveThreshold(s.upperAboveM))];

    for (const [id, coords, heights] of [
      ['aviation-gp-corridor-floor', lowerCoords, lowerHeights],
      ['aviation-gp-corridor-ceiling', upperCoords, upperHeights],
      ['aviation-gp-corridor-left', sideLeftCoords, sideLeftHeights],
      ['aviation-gp-corridor-right', sideRightCoords, sideRightHeights]
    ]) {
      groups.glideCorridor.push(polygonEntity(id, coords, heights, '#9575cd', 0.14));
    }

    const marker = viewer.entities.add({
      id: 'aviation-glidepath-marker',
      name: 'Glidepath marker',
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#ffca28'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: '',
        font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.72),
        pixelOffset: new Cesium.Cartesian2(14, -18),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    const drop = viewer.entities.add({
      id: 'aviation-glidepath-marker-drop',
      polyline: {
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: 1,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#ffca28').withAlpha(0.75),
          dashLength: 12
        }),
        arcType: Cesium.ArcType.NONE
      }
    });
    groups.marker.push(marker, drop);

    updateGlideMarker(state.markerDistanceM ?? 4250);
    applyOverlayVisibility();
  }

  function updateGlideMarker(distanceM) {
    if (!aviation || !groups.marker.length) return;
    const gp = aviation.glidepath;
    const d = Math.min(gp.rangeM, Math.max(0, Number(distanceM) || 0));
    state.markerDistanceM = d;

    const coord = geodesicPoint(
      [gp.nominalGroundIntercept.lon, gp.nominalGroundIntercept.lat],
      [gp.approachEnd.lon, gp.approachEnd.lat],
      d
    );
    const aboveThrM = Math.tan(Cesium.Math.toRadians(gp.angleDeg)) * d;
    const aboveThrFt = aboveThrM / FT_TO_M;
    const amslFt = thresholdElevationFt() + aboveThrFt;
    const markerHeight = renderHeightFromAboveThreshold(aboveThrM);

    groups.marker[0].position = Cesium.Cartesian3.fromDegrees(coord[0], coord[1], markerHeight);
    groups.marker[0].label.text =
      `${Math.round(d).toLocaleString('en-AU')} m horiz · ${Math.round(amslFt).toLocaleString('en-AU')} ft AMSL · ${Math.round(aboveThrFt).toLocaleString('en-AU')} ft above THR\n` +
      `${coord[1].toFixed(6)}°, ${coord[0].toFixed(6)}°`;
    groups.marker[1].polyline.positions = [
      Cesium.Cartesian3.fromDegrees(coord[0], coord[1], state.renderAnchorM),
      Cesium.Cartesian3.fromDegrees(coord[0], coord[1], markerHeight)
    ];

    el('glideMarkerRange').value = String(Math.round(d));
    el('glideMarkerInput').value = String(Math.round(d));
    viewer.scene.requestRender();
  }

  function setGroupShow(name, show) {
    for (const entity of groups[name]) entity.show = show;
  }

  function applyOverlayVisibility() {
    if (!aviation) return;
    setGroupShow('runway', el('showRunwayOutline').checked);
    setGroupShow('touchdownZone', el('showTouchdownZone').checked);

    const glideShow = el('showGlidepath').checked;
    const style = el('glidepathStyle').value;
    setGroupShow('glideLine', glideShow && style === 'line');
    setGroupShow('glideRibbon', glideShow && style === 'ribbon');
    setGroupShow('glideCorridor', glideShow && style === 'corridor');
    setGroupShow('marker', el('showGlideMarker').checked);
    viewer.scene.requestRender();
  }

  async function sampleGoogleThresholdHeight() {
    try {
      const thr = threshold();
      const cartographic = Cesium.Cartographic.fromDegrees(thr.lon, thr.lat);
      const samples = await viewer.scene.sampleHeightMostDetailed([cartographic]);
      const h = samples?.[0]?.height;
      if (Number.isFinite(h)) return h;
    } catch (err) {
      console.warn('Google 3D threshold height sampling failed', err);
    }
    return state.standardRenderAnchorM;
  }

  async function setSceneMode(mode) {
    const previous = state.sceneMode || 'standard';
    const status = el('sceneStatus');
    try {
      if (mode === 'google3d') {
        const token = app.ionToken();
        if (!token) throw new Error('Enter a Cesium ion token first.');
        Cesium.Ion.defaultAccessToken = token;

        status.textContent = 'Loading Google Photorealistic 3D…';
        if (!googleTileset) {
          googleTileset = await Cesium.createGooglePhotorealistic3DTileset();
          viewer.scene.primitives.add(googleTileset);
        }
        googleTileset.show = true;
        viewer.scene.globe.show = false;
        if (state.baseLayer) state.baseLayer.show = false;
        state.sceneMode = 'google3d';
        el('sceneSelect').value = 'google3d';

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(threshold().lon, threshold().lat, 4000),
          orientation: { heading: Cesium.Math.toRadians(350), pitch: Cesium.Math.toRadians(-40), roll: 0 },
          duration: 0.8
        });

        await new Promise(resolve => setTimeout(resolve, 700));
        state.renderAnchorM = await sampleGoogleThresholdHeight();
        app.rebuildHeights();
        rebuildOverlays();
        el('basemapSelect').disabled = true;
        for (const id of ['mapBrightness','mapContrast','mapSaturation','mapOpacity','resetMapAppearance']) el(id).disabled = true;
        status.textContent = 'Google Photorealistic 3D · Cesium ion';
      } else {
        if (googleTileset) googleTileset.show = false;
        viewer.scene.globe.show = true;
        if (state.baseLayer) state.baseLayer.show = true;
        state.sceneMode = 'standard';
        state.renderAnchorM = state.standardRenderAnchorM;
        app.rebuildHeights();
        rebuildOverlays();
        el('sceneSelect').value = 'standard';
        el('basemapSelect').disabled = false;
        for (const id of ['mapBrightness','mapContrast','mapSaturation','mapOpacity','resetMapAppearance']) el(id).disabled = false;
        status.textContent = 'Standard globe';
      }
      localStorage.setItem('flightpathsSceneMode', state.sceneMode);
    } catch (err) {
      console.error(err);
      state.sceneMode = previous;
      el('sceneSelect').value = previous;
      status.textContent = `Scene failed: ${err.message || err}`;
    }
  }

  function wireControls() {
    el('sceneSelect').addEventListener('change', e => setSceneMode(e.target.value));
    for (const id of ['showRunwayOutline','showTouchdownZone','showGlidepath','showGlideMarker']) {
      el(id).addEventListener('change', applyOverlayVisibility);
    }
    el('glidepathStyle').addEventListener('change', applyOverlayVisibility);

    const markerChanged = value => updateGlideMarker(Math.round(Math.min(10000, Math.max(0, Number(value) || 0))));
    el('glideMarkerRange').addEventListener('input', e => markerChanged(e.target.value));
    el('glideMarkerInput').addEventListener('input', e => markerChanged(e.target.value));

    el('overlayOpacity').addEventListener('input', e => {
      overlayOpacity = Number(e.target.value);
      el('overlayOpacityValue').textContent = overlayOpacity.toFixed(2);
      rebuildOverlays();
    });

    el('exaggeration').addEventListener('input', () => setTimeout(rebuildOverlays, 0));
  }

  async function loadAviation() {
    try {
      const response = await fetch(AVIATION_URL + '?v=10', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      aviation = await response.json();
      state.aviation = aviation;
      state.thresholdElevationFt = aviation.runway35.threshold.elevationFtAmsl;
      state.standardRenderAnchorM = state.thresholdElevationFt * FT_TO_M;
      if ((state.sceneMode || 'standard') === 'standard') state.renderAnchorM = state.standardRenderAnchorM;

      rebuildOverlays();
      el('aviationStatus').textContent =
        `Authoritative geometry loaded · effective ${aviation.effectiveFrom}–${aviation.effectiveTo}`;

      const saved = localStorage.getItem('flightpathsSceneMode') || 'standard';
      if (saved === 'google3d') await setSceneMode('google3d');
    } catch (err) {
      console.error(err);
      el('aviationStatus').textContent = `Aviation overlay load failed: ${err.message || err}`;
    }
  }

  wireControls();
  loadAviation();
})();