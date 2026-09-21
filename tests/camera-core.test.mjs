import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeText, safeSnapshotUrl, safeHanoiSnapshotUrl, safeHanoiLiveUrl, hanoiCameraId, normalizeCameras, normalizeHanoiCameras, normalizeCity, normalizePlaceSuggestions, normalizePlaceDetail, normalizeRoutes, camerasAlongRoute,
  filterCameraRows, normalizeFavorites, normalizePins, readStored, writeStored, favoriteKey, LatestRequest} from '../assets/camera-core.mjs';

const rawCamera = {_id: 'camera-1', name: 'Nguyễn Hữu Thọ', dist: 'Nhà Bè', loc: {coordinates: [106.7, 10.7]}, liveviewUrl: 'cameras/camera-1/snapshot'};
test('Vietnamese search folds accents, uppercase and đ without changing names', () => {
  assert.equal(normalizeText('  Đường NGUYỄN Hữu Thọ '), 'duong nguyen huu tho');
  const {cameras} = normalizeCameras([rawCamera]);
  assert.equal(filterCameraRows(cameras, {query: 'nguyen huu tho'})[0].camera.name, 'Nguyễn Hữu Thọ');
  assert.equal(filterCameraRows(cameras, {query: 'nhA Be'}).length, 1);
});
test('bundled catalog retains every valid record and safe snapshot path', async () => {
  const raw = JSON.parse(await readFile(new URL('../cameras_full.json', import.meta.url)));
  const {cameras, rejected} = normalizeCameras(raw);
  assert.equal(cameras.length, 692); assert.equal(rejected, 0);
  assert.ok(cameras.every(c => c.snapshotUrl?.startsWith('https://api.notis.vn/v4/cameras/')));
});
test('camera schema skips invalid coordinates and duplicate IDs, never coerces strings', () => {
  const result = normalizeCameras([rawCamera, rawCamera, {...rawCamera, _id: 'bad', loc: {coordinates: ['106.7', 10.7]}}, null]);
  assert.equal(result.cameras.length, 1); assert.equal(result.rejected, 3);
  assert.throws(() => normalizeCameras({cameras: []}), /định dạng/);
  assert.throws(() => normalizeCameras([null]), /hợp lệ/);
  assert.deepEqual(normalizeCameras([]).cameras, []);
});
test('Hanoi catalog prefixes IDs, uses ward as district and only local snapshot paths', async () => {
  const raw = JSON.parse(await readFile(new URL('../cameras_hanoi.json', import.meta.url)));
  const {cameras, rejected} = normalizeHanoiCameras(raw);
  assert.equal(cameras.length, 86); assert.equal(rejected, 0);
  assert.ok(cameras.every(c => c.city === 'hn' && c.id.startsWith('hn-') && c.snapshotUrl === `./api/hanoi/snapshot/${c.id.slice(3)}` && c.lat > 20 && c.lon > 105));
  assert.equal(safeHanoiSnapshotUrl('gm9SoV9AOg'), './api/hanoi/snapshot/gm9SoV9AOg');
  assert.equal(safeHanoiLiveUrl('gm9SoV9AOg'), './api/hanoi/live/gm9SoV9AOg');
  assert.equal(safeHanoiSnapshotUrl('../x'), null);
  assert.equal(safeHanoiLiveUrl('../x'), null);
  assert.equal(hanoiCameraId({city: 'hn', id: 'hn-gm9SoV9AOg'}), 'gm9SoV9AOg');
  assert.equal(hanoiCameraId({city: 'hcm', id: 'gm9SoV9AOg'}), '');
  const one = normalizeHanoiCameras([{camera_id: 'gm9SoV9AOg', name: 'A PTZ', ward_name: 'Phú Thượng', lng: 105.8, lat: 21.0}]);
  assert.equal(one.cameras[0].id, 'hn-gm9SoV9AOg'); assert.equal(one.cameras[0].ptz, true);
  assert.equal(one.cameras[0].snapshotUrl, './api/hanoi/snapshot/gm9SoV9AOg');
  assert.equal(one.cameras[0].district, 'Phú Thượng');
  const mixed = normalizeHanoiCameras([
    {camera_id: 'okCam', name: 'Ok', ward_name: 'A', lng: 105.8, lat: 21.0},
    null,
    {camera_id: 'x', lng: '105', lat: 21}
  ]);
  assert.equal(mixed.cameras.length, 1); assert.equal(mixed.rejected, 2);
  assert.throws(() => normalizeHanoiCameras({}), /định dạng/);
  assert.throws(() => normalizeHanoiCameras([null]), /hợp lệ/);
  assert.equal(normalizeCity('hn'), 'hn'); assert.equal(normalizeCity('hue'), 'hcm');
});
test('snapshot URL rejects foreign origins, paths, credentials and attribute injection', () => {
  assert.ok(safeSnapshotUrl('cameras/camera-1/snapshot', 'camera-1'));
  for (const path of ['//evil.example/snapshot', 'javascript:alert(1)', 'cameras/other/snapshot', '../admin',
    'https://user:pass@api.notis.vn/v4/cameras/camera-1/snapshot', 'cameras/camera-1/snapshot?redirect=evil',
    'cameras/camera-1/snapshot" onerror="alert(1)']) assert.equal(safeSnapshotUrl(path, 'camera-1'), null);
});
test('NDA place suggestions preserve opaque IDs, deduplicate and require a successful feature collection', () => {
  const a = {type: 'Feature', properties: {id: 'place_one', name: 'A', label: 'A, Phường 1'}};
  const b = {type: 'Feature', properties: {id: 'place-two', name: 'B', label: 'B, Đà Nẵng'}};
  const collection = features => ({type: 'FeatureCollection', errors: null, features});
  const places = normalizePlaceSuggestions(collection([a, b, a, null, {...a, properties: {...a.properties, id: 'bad/id'}}]));
  assert.deepEqual(places.map(p => p.label), ['A', 'B']); assert.match(places[0].address, /Phường 1/);
  assert.equal(places[0].ref, 'place_one'); assert.equal('lon' in places[0], false);
  assert.deepEqual(normalizePlaceSuggestions(collection([])), []);
  for (const data of [{error: 'bad'}, collection([null]), {...collection([]), errors: ['denied']}, {features: []}]) {
    assert.throws(() => normalizePlaceSuggestions(data));
  }
});
test('NDA place detail requires exactly one Point with numeric coordinates', () => {
  const feature = {type: 'Feature', properties: {name: '', label: '197 Trần Phú'}, geometry: {type: 'Point', coordinates: [106, 10]}};
  const collection = features => ({type: 'FeatureCollection', errors: null, features});
  assert.deepEqual(normalizePlaceDetail(collection([feature])), {label: '197 Trần Phú', address: '197 Trần Phú', lon: 106, lat: 10});
  for (const features of [[], [feature, feature], [null], [{...feature, geometry: {type: 'Point', coordinates: ['106', 10]}}],
    [{...feature, geometry: {type: 'LineString', coordinates: [106, 10]}}]]) assert.throws(() => normalizePlaceDetail(collection(features)));
  assert.throws(() => normalizePlaceDetail({...collection([feature]), errors: ['error']}));
});
test('routing rejects no-route and corrupt geometries while retaining all valid alternatives', () => {
  const route = {distance: 200, duration: 60, geometry: {coordinates: [[106.7, 10.7], [106.71, 10.71]]}};
  assert.equal(normalizeRoutes({code: 'Ok', routes: [route, {...route, distance: 300}]}).length, 2);
  assert.throws(() => normalizeRoutes({code: 'NoRoute', routes: []}));
  assert.throws(() => normalizeRoutes({code: 'Ok', routes: [{...route, duration: -1}]}));
  assert.throws(() => normalizeRoutes({code: 'Ok', routes: [{...route, geometry: {coordinates: [[0, 0], [0, 91]]}}]}));
});
test('route camera corridor is in meters and ordered by closest position from A to B', () => {
  const cameras = [{id: 'end', name: 'End', district: '', lon: .009, lat: .001},
    {id: 'start', name: 'Start', district: '', lon: .001, lat: .002},
    {id: 'outside', name: 'Outside', district: '', lon: .005, lat: .005}];
  const rows = camerasAlongRoute(cameras, [[0, 0], [.01, 0]]);
  assert.deepEqual(rows.map(r => r.camera.id), ['start', 'end']);
  assert.ok(Math.abs(rows[0].distance - 222.39) < 1);
  assert.ok(Math.abs(rows[0].progress - 111.19) < 1);
  assert.deepEqual(camerasAlongRoute(cameras, [[.01, 0], [0, 0]]).map(r => r.camera.id), ['end', 'start']);
});
test('nearest segment is evaluated beyond the first within-radius segment', () => {
  const rows = camerasAlongRoute([{id: 'x', lon: .008, lat: .002}], [[0, 0], [.01, 0], [.01, .002], [0, .002]]);
  assert.ok(rows[0].distance < .001); assert.ok(rows[0].progress > 1300);
  assert.equal(camerasAlongRoute([{id: 'x', lon: 0, lat: 0}], [[0, 0], [0, 0]])[0].progress, 0);
});
test('district applies to browse mode, not the ordered route or pinned modes', () => {
  const cameras = [{id: '1', name: 'B', district: 'Q1'}, {id: '2', name: 'A', district: 'Q2'}];
  const along = [{camera: cameras[0], distance: 10, progress: 0}, {camera: cameras[1], distance: 5, progress: 100}];
  assert.equal(filterCameraRows(cameras, {district: 'Q1'}).length, 1);
  assert.deepEqual(filterCameraRows(cameras, {mode: 'route', district: 'Q2', along}), along);
  assert.deepEqual(filterCameraRows(cameras, {mode: 'pinned', district: 'Q1', pins: ['2']}).map(r => r.camera.id), ['2']);
});
test('legacy favorites remain readable and new favorites retain validated coordinates', () => {
  const legacy = {from: 'Ben Thanh', to: 'Duc Ba', aLabel: 'Market', bLabel: 'Church'};
  const newer = {...legacy, a: {lon: 106.7, lat: 10.7, label: 'Market'}, b: {lon: 106.8, lat: 10.8, label: 'Church'}};
  assert.equal(normalizeFavorites([legacy])[0].a, null);
  assert.equal(normalizeFavorites([newer])[0].a.lon, 106.7);
  assert.equal(favoriteKey(newer), favoriteKey({...newer, from: 'different label'}));
  assert.equal(normalizeFavorites([{...newer, a: {...newer.a, lat: 100}}])[0].a, null);
});
test('malformed stored payloads fail safely without throwing or deleting storage', () => {
  for (const payload of ['null', '{}', '{"length":1}', '[null, {}, {"from":123,"to":true}]']) {
    assert.deepEqual(readStored({getItem: () => payload}, 'key', normalizeFavorites).value, []);
  }
  assert.ok(readStored({getItem: () => 'not JSON'}, 'key', normalizeFavorites).error);
  assert.ok(readStored({getItem: () => {throw new Error('denied');}}, 'key', normalizeFavorites).error);
  assert.match(writeStored({setItem: () => {throw new Error('quota');}}, 'key', []), /Không lưu/);
  assert.deepEqual(normalizePins(['1', '1', null, {}, 'bad id', 'unavailable-id']), ['1', 'unavailable-id']);
});
test('latest route request wins even if older work ignores its abort signal', async () => {
  const gate = new LatestRequest(); let releaseOld, currentRoute;
  const old = gate.begin();
  const oldResponse = new Promise(resolve => {releaseOld = resolve;}).then(value => {if (old.current()) currentRoute = value;});
  const newer = gate.begin();
  assert.ok(old.signal.aborted);
  if (newer.current()) currentRoute = 'new';
  releaseOld('old'); await oldResponse;
  assert.equal(currentRoute, 'new');
  gate.cancel(); assert.equal(newer.current(), false); assert.ok(newer.signal.aborted);
});
