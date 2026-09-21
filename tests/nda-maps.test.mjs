import test from 'node:test';
import assert from 'node:assert/strict';
import {createNdaMaps, validMapPath, rewriteMapDocument} from '../nda-maps.mjs';

const tile = path => `https://maptiles.ndamaps.vn${path}?apikey=unit-private`;
const localOrigin = 'http://127.0.0.1:8765';
const style = {version: 8, name: 'Provider style', layers: [{id: 'island-labels', type: 'symbol'}],
  glyphs: tile('/fonts/{fontstack}/{range}.pbf'), sprite: tile('/styles/day-v2/sprite'),
  sources: {basemap: {type: 'vector', url: tile('/data/base.json')}}};
const tilejson = {tilejson: '3.0.0', tiles: [tile('/data/base/{z}/{x}/{y}..pbf')],
  attribution: '© NDA Maps', maxzoom: 14};
const json = (body, headers = {}) => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json', ...headers}});

test('map resource allowlist permits actual provider paths and rejects arbitrary destinations and coordinates', () => {
  for (const path of ['/styles/day-v2/style.json', '/styles/day-v2/sprite@2x.json', '/styles/day-v2/sprite.png',
    '/data/base.json', '/data/base/0/0/0..pbf', '/data/base/14/16383/16383.pbf', '/fonts/Noto Sans Regular/0-255.pbf']) assert.equal(validMapPath(path), true, path);
  for (const path of ['/data/base/15/0/0..pbf', '/data/base/2/4/0.pbf', '/styles/other/style.json',
    '/fonts/../../admin/0-255.pbf', '/fonts/font/0-256.pbf', '/fonts/font/65280-65791.pbf',
    '/data/base/{z}/{x}/{y}..pbf', '//evil.example/a', '/api/route', '/data/base.json?url=evil']) assert.equal(validMapPath(path), false, path);
});

test('style and TileJSON rewrite every resource URL without altering geography or attribution', () => {
  const rewritten = rewriteMapDocument(style, true, localOrigin);
  assert.deepEqual(rewritten.layers, style.layers);
  assert.equal(rewritten.glyphs, localOrigin + '/api/map/fonts/{fontstack}/{range}.pbf');
  assert.equal(rewritten.sprite, localOrigin + '/api/map/styles/day-v2/sprite');
  assert.equal(rewritten.sources.basemap.url, localOrigin + '/api/map/data/base.json');
  assert.equal(JSON.stringify(rewritten).includes('unit-private'), false);
  const tiles = rewriteMapDocument(tilejson, false, localOrigin);
  assert.equal(tiles.tiles[0], localOrigin + '/api/map/data/base/{z}/{x}/{y}..pbf');
  assert.equal(tiles.attribution, tilejson.attribution);
  assert.equal(tiles.maxzoom, 14);
  for (const candidate of [{...style, glyphs: 'https://evil.example/font.pbf'}, {...style, imports: []},
    {...style, sprite: tile('/styles/night/sprite')}, {...style, sources: {bad: {type: 'raster', url: tile('/data/base.json')}}}]) {
    assert.throws(() => rewriteMapDocument(candidate, true, localOrigin));
  }
  for (const origin of [undefined, 'https://evil.example', 'http://127.0.0.1:8765/evil', 'http://localhost:8765@evil.example', 'http://localhost:99999']) {
    assert.throws(() => rewriteMapDocument(style, true, origin));
  }
  assert.equal(rewriteMapDocument(style, true, 'http://localhost:8765').sprite, 'http://localhost:8765/api/map/styles/day-v2/sprite');
  const vercelEnv = {VERCEL: '1', VERCEL_URL: 'cam.vercel.app'};
  assert.equal(rewriteMapDocument(style, true, 'https://cam.vercel.app', vercelEnv).sprite,
    'https://cam.vercel.app/api/map/styles/day-v2/sprite');
  assert.throws(() => rewriteMapDocument(style, true, 'https://evil.vercel.app', vercelEnv));
  assert.throws(() => rewriteMapDocument(style, true, 'https://cam.vercel.app'));
});

test('provider requests use fixed origin, no redirects, private key and preserve binary bytes and cache restrictions', async () => {
  const bytes = new Uint8Array([26, 8, 120, 255, 0, 29]); let requests = 0;
  const provider = createNdaMaps({apiKey: 'unit-private', intervalMs: 0, fetchImpl: async (input, options) => {
    requests++;
    const url = new URL(input);
    assert.equal(url.origin, 'https://maptiles.ndamaps.vn');
    assert.equal(url.searchParams.get('apikey'), 'unit-private');
    assert.equal(url.searchParams.size, 1); assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/style.json')) return json(style, {'Cache-Control': 'public, max-age=3600'});
    if (url.pathname.endsWith('/base.json')) return json(tilejson, {'Cache-Control': 'no-store'});
    return new Response(bytes, {headers: {'Cache-Control': 'no-cache'}});
  }});
  const result = await provider.map('/styles/day-v2/style.json', undefined, localOrigin);
  assert.equal(result.cacheControl, 'private, max-age=300');
  assert.equal(result.body.includes(Buffer.from('unit-private')), false);
  assert.equal((await provider.map('/data/base.json', undefined, localOrigin)).cacheControl, 'no-store');
  const binary = await provider.map('/data/base/0/0/0..pbf');
  assert.deepEqual(binary.body, Buffer.from(bytes)); assert.equal(binary.cacheControl, 'no-cache');
  await assert.rejects(provider.map('/styles/evil/style.json'), {status: 404});
  assert.equal(requests, 3);
});

test('shared provider rate gate paces map and place calls and cancelled queued work never fetches', async () => {
  const starts = [];
  const provider = createNdaMaps({apiKey: 'unit-private', intervalMs: 30, fetchImpl: async url => {
    starts.push(performance.now());
    return json(url.includes('/autocomplete') ? {type: 'FeatureCollection', errors: null, features: []} : style);
  }});
  const controller = new AbortController();
  const first = provider.map('/styles/day-v2/style.json', undefined, localOrigin);
  const cancelled = provider.map('/styles/day-v2/style.json', controller.signal, localOrigin);
  controller.abort();
  const second = provider.places('Sài Gòn', false);
  await assert.rejects(cancelled);
  await Promise.all([first, second]);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 25);
});

test('missing credentials, rate rejection, embedded keys and stalled bodies fail without leaking upstream details', async () => {
  await assert.rejects(createNdaMaps().map('/styles/day-v2/style.json'), {status: 503});
  for (const fetchImpl of [async () => new Response('unit-private', {status: 401}),
    async () => json({...style, name: 'unit-private'}), async () => json({...style, glyphs: 'https://evil.example/font'}),
    async () => ({ok: true, arrayBuffer: () => new Promise(() => {})})]) {
    const provider = createNdaMaps({apiKey: 'unit-private', fetchImpl, timeoutMs: 10, intervalMs: 0});
    await assert.rejects(provider.map('/styles/day-v2/style.json', undefined, localOrigin), error => error.status === 502 && !String(error).includes('unit-private'));
  }
  const limited = createNdaMaps({apiKey: 'unit-private', fetchImpl: async () => new Response('unit-private', {status: 429})});
  await assert.rejects(limited.map('/styles/day-v2/style.json'), {status: 429});
});
