import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchJson, loadCatalog, searchPlaces, resolvePlace, getRoutes, CAMERA_API} from '../assets/camera-api.mjs';
const reply = data => ({ok: true, json: async () => data});
const camera = {_id: 'id', name: 'Camera', loc: {coordinates: [106, 10]}, liveviewUrl: 'cameras/id/snapshot'};
test('JSON requests enforce HTTP and body validity', async () => {
  assert.deepEqual(await fetchJson('https://example.invalid', {fetchImpl: async () => reply({ok: true})}), {ok: true});
  await assert.rejects(fetchJson('x', {fetchImpl: async () => ({ok: false, status: 429})}), /429/);
  await assert.rejects(fetchJson('x', {fetchImpl: async () => ({ok: true, json: async () => {throw new Error('html');}})}), /không đọc/);
});
test('deadline bounds stalled network and stalled response body', async () => {
  const never = () => new Promise(() => {});
  for (const fetchImpl of [never, async () => ({ok: true, json: never})]) {
    await assert.rejects(fetchJson('x', {timeoutMs: 10, fetchImpl}), {name: 'TimeoutError'});
  }
});
test('caller cancellation aborts and already aborted work never sends a request', async () => {
  const controller = new AbortController(); let requests = 0;
  controller.abort();
  await assert.rejects(fetchJson('x', {signal: controller.signal, fetchImpl: async () => {requests++; return reply([]);}}), {name: 'AbortError'});
  assert.equal(requests, 0);
  const later = new AbortController();
  const pending = fetchJson('x', {signal: later.signal, fetchImpl: () => new Promise(() => {})});
  later.abort(); await assert.rejects(pending, {name: 'AbortError'});
});
test('live camera catalog is normalized with source and load time', async () => {
  const catalog = await loadCatalog({fetchImpl: async url => {assert.equal(url, CAMERA_API); return reply([camera]);}});
  assert.equal(catalog.source, 'live'); assert.equal(catalog.cameras.length, 1); assert.ok(catalog.loadedAt);
  assert.equal(catalog.city, 'hcm');
});
test('Hanoi catalog uses the local proxy then the bundled file, with local snapshot paths', async () => {
  const row = {camera_id: 'gm9SoV9AOg', name: 'Cầu Nhật Tân', ward_name: 'Phú Thượng', lng: 105.8, lat: 21.08, ptz: true};
  const live = await loadCatalog({city: 'hn', fetchImpl: async url => {
    assert.equal(url, './api/hanoi/cameras'); return reply([row]);
  }});
  assert.equal(live.city, 'hn'); assert.equal(live.cameras[0].id, 'hn-gm9SoV9AOg');
  assert.equal(live.cameras[0].snapshotUrl, './api/hanoi/snapshot/gm9SoV9AOg');
  const bundled = await loadCatalog({city: 'hn', fetchImpl: async url => {
    if (url === './api/hanoi/cameras') throw new Error('offline');
    assert.equal(url, './cameras_hanoi.json'); return reply([row]);
  }});
  assert.equal(bundled.source, 'bundled'); assert.match(bundled.warning, /VMS/);
});
test('camera failure can use bundled catalog without claiming a recent load or capture date', async () => {
  const catalog = await loadCatalog({fetchImpl: async url => {
    if (url === CAMERA_API) throw new Error('offline');
    assert.equal(url, './cameras_full.json'); return reply([camera]);
  }});
  assert.equal(catalog.source, 'bundled'); assert.equal(catalog.loadedAt, null); assert.match(catalog.warning, /chưa rõ ngày/);
});
test('invalid live schema triggers fallback; cancellation never triggers fallback', async () => {
  let count = 0;
  const catalog = await loadCatalog({fetchImpl: async () => reply(++count === 1 ? {} : [camera])});
  assert.equal(catalog.source, 'bundled'); assert.equal(count, 2);
  const controller = new AbortController(); controller.abort(); count = 0;
  await assert.rejects(loadCatalog({signal: controller.signal, fetchImpl: async () => {count++; return reply([camera]);}}));
  assert.equal(count, 0);
});
test('routing calls only OSRM, even when camera source is unavailable', async () => {
  const a = {lon: 106, lat: 10}, b = {lon: 107, lat: 11};
  const routes = await getRoutes(a, b, {fetchImpl: async url => {
    assert.ok(url.startsWith('https://router.project-osrm.org/route/v1/driving/106,10;107,11'));
    assert.equal(new URL(url).searchParams.get('alternatives'), '3');
    return reply({code: 'Ok', routes: [{distance: 100, duration: 60, geometry: {coordinates: [[106, 10], [107, 11]]}}]});
  }});
  assert.equal(routes.length, 1);
  await assert.rejects(loadCatalog({fetchImpl: async () => {throw new Error('offline');}}), /vẫn có thể tìm đường/);
});
test('geocoder uses only local proxy and encodes query without extra parameters', async () => {
  await searchPlaces('Bến Thành &limit=999', {fetchImpl: async input => {
    const url = new URL(input, 'http://localhost:8765');
    assert.equal(url.origin, 'http://localhost:8765'); assert.equal(url.pathname, '/api/places');
    assert.equal(url.searchParams.get('q'), 'Bến Thành &limit=999');
    assert.equal(url.searchParams.size, 1);
    return reply([]);
  }});
});
test('place coordinates load only through explicit detail call and are validated', async () => {
  const place = {lon: 106.7, lat: 10.7, label: 'A', address: 'B'};
  assert.deepEqual(await resolvePlace('nda_place-test', {fetchImpl: async input => {
    assert.equal(new URL(input, 'http://localhost:8765').searchParams.get('ref'), 'nda_place-test'); return reply(place);
  }}), place);
  await assert.rejects(resolvePlace('nda_place-test', {fetchImpl: async () => reply({...place, lat: 91})}), /Tọa độ/);
  await assert.rejects(searchPlaces('A'), /2 đến 200/);
  await assert.rejects(searchPlaces('Bến Thành', {fetchImpl: async () => ({ok: false, status: 503})}), /chưa được cấu hình/);
});
