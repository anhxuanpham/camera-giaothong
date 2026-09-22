import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {createAppServer, resolveMapKey, fetchHanoiCameras, isAllowedHost, publicOrigin} from '../server.mjs';

test('macOS startup restores the stored key without a terminal environment variable', async () => {
  assert.equal(await resolveMapKey({env: {}, platform: 'darwin', readStoredKey: async () => ' unit-stored\n'}), 'unit-stored');
  assert.equal(await resolveMapKey({env: {NDAMAPS_API_KEY: ' unit-env '}, platform: 'darwin',
    readStoredKey: async () => assert.fail('environment must take precedence')}), 'unit-env');
});
test('missing Keychain item and other platforms keep the explicit unconfigured mode', async () => {
  assert.equal(await resolveMapKey({env: {}, platform: 'darwin', readStoredKey: async () => {throw Object.assign(new Error('not found'), {code: 44});}}), '');
  assert.equal(await resolveMapKey({env: {}, platform: 'linux', readStoredKey: async () => assert.fail('macOS only')}), '');
});
test('Keychain access failures do not expose captured secret output', async () => {
  await assert.rejects(resolveMapKey({env: {}, platform: 'darwin', readStoredKey: async () => {
    throw Object.assign(new Error('unit-sensitive'), {code: 1, stdout: 'unit-sensitive', stderr: 'unit-sensitive'});
  }}), error => /Keychain/.test(error.message) && !String(error).includes('unit-sensitive') && !error.cause);
});

async function withServer(options, fn) {
  const server = createAppServer({intervalMs: 0, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const reply = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
test('Hanoi camera proxy paginates CDS, strips operator fields and rejects empty catalogs', async () => {
  const pages = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://cds.hanoi.gov.vn');
    assert.equal(url.pathname, '/api/1.0/public/video-wall-cameras-v2');
    pages.push(url.searchParams.get('page'));
    const page = Number(url.searchParams.get('page'));
    const row = (id, extra = {}) => ({camera_id: id, name: 'Cam PTZ', ward_name: 'A', lng: 105.8, lat: 21.0, created_user: 'secret', ...extra});
    return reply({current_page: page, last_page: 2, data: page === 1 ? [row('cam-a'), row('bad', {lat: 91})] : [row('cam-b')]});
  };
  const cameras = await fetchHanoiCameras({fetchImpl});
  assert.deepEqual(pages, ['1', '2']);
  assert.deepEqual(cameras.map(c => c.camera_id), ['cam-a', 'cam-b']);
  assert.ok(cameras.every(c => !('created_user' in c) && c.ptz === true));
  await withServer({fetchImpl}, async base => {
    const body = await (await fetch(base + '/api/hanoi/cameras')).json();
    assert.equal(body.length, 2); assert.equal(JSON.stringify(body).includes('secret'), false);
  });
  await assert.rejects(fetchHanoiCameras({fetchImpl: async () => reply({data: []})}));
});
const collection = features => ({type: 'FeatureCollection', errors: null, features});
test('only app assets and key-free map configuration are exposed', async () => {
  await withServer({apiKey: 'unit-private'}, async base => {
    const response = await fetch(`${base}/api/map-config`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.equal(config.configured, true); assert.equal(config.searchConfigured, true);
    assert.equal(config.styleUrl, '/api/map/styles/day-v2/style.json');
    assert.equal(JSON.stringify(config).includes('unit-private'), false);
    for (const path of ['/server.mjs', '/nda-maps.mjs', '/package.json', '/plans/', '/assets/../server.mjs', '/api/proxy?url=https://example.invalid']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal((await fetch(base + '/cameras_hanoi.json')).status, 200);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /Camera Giao Thông/);
    assert.match(html, />William</);
    assert.match(html, /https:\/\/will\.id\.vn/);
    assert.match(html, /id="pickHere"/);
    assert.match(html, /id="wallToggle"/);
    assert.match(html, /id="wallDialog"/);
    assert.equal(html.includes('soi lỗ hổng'), false);
    assert.match((await fetch(base + '/assets/camera-app.mjs')).headers.get('content-type'), /javascript/);
  });
});
test('missing key, foreign origin and invalid query make no upstream calls', async () => {
  let calls = 0;
  await withServer({fetchImpl: async () => { calls++; throw new Error('unexpected'); }}, async base => {
    assert.equal((await fetch(base + '/api/places?q=Saigon')).status, 503);
    assert.equal((await fetch(base + '/api/places?q=x')).status, 400);
    assert.equal((await fetch(base + '/api/place?ref=https://evil.example')).status, 400);
    assert.equal((await fetch(base + '/api/places?q=Saigon', {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await fetch(base + '/api/places?q=Saigon', {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
    // Fetch owns the Host header; use an actual HTTP request to exercise rebinding.
    const foreignHostStatus = await new Promise((resolve, reject) => {
      get(base + '/api/places?q=Saigon', {headers: {Host: 'evil.example:8765'}}, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(base + '/api/places?q=Saigon', {method: 'POST'})).status, 405);
  });
  assert.equal(calls, 0);
});
test('suggestions and selected place use fixed provider endpoints, isolated key and validated payloads', async () => {
  const requests = [];
  await withServer({apiKey: 'unit-private', fetchImpl: async input => {
    const url = new URL(input); requests.push(url);
    assert.equal(url.origin, 'https://mapapis.ndamaps.vn'); assert.equal(url.searchParams.get('apikey'), 'unit-private');
    return reply(collection([{type: 'Feature', properties: {id: 'nda_one', name: 'A', label: 'Address'},
      geometry: url.pathname.includes('autocomplete') ? null : {type: 'Point', coordinates: [106, 10]}}]));
  }}, async base => {
    const choices = await (await fetch(base + '/api/places?q=A%26apikey%3Devil')).json();
    assert.equal(choices[0].ref, 'nda_one'); assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('text'), 'A&apikey=evil');
    assert.equal(requests[0].searchParams.get('admin_v2'), 'true');
    const selected = await (await fetch(base + '/api/place?ref=nda_one')).json();
    assert.equal(selected.lon, 106); assert.equal(requests[1].pathname, '/v1/place');
    assert.equal(requests[1].searchParams.get('ids'), 'nda_one');
    assert.equal(JSON.stringify(selected).includes('unit-private'), false);
  });
});
test('upstream errors, invalid data and deadlines return sanitized failures without fallback', async () => {
  for (const fetchImpl of [async () => { throw new Error('unit-private'); }, async () => reply({error: 'unit-private'}), () => new Promise(() => {})]) {
    await withServer({apiKey: 'unit-private', fetchImpl, timeoutMs: 10}, async base => {
      const response = await fetch(base + '/api/places?q=Saigon');
      assert.equal(response.status, 502); assert.equal((await response.text()).includes('unit-private'), false);
    });
  }
});
test('local API limits paid requests per minute', async () => {
  let calls = 0;
  await withServer({apiKey: 'unit-private', fetchImpl: async () => { calls++; return reply(collection([])); }}, async base => {
    for (let n = 0; n < 60; n++) assert.equal((await fetch(base + '/api/places?q=Saigon')).status, 200);
    assert.equal((await fetch(base + '/api/places?q=Saigon')).status, 429);
  });
  assert.equal(calls, 60);
});
test('map HTTP route rejects arbitrary paths and query parameters before contacting provider', async () => {
  let calls = 0;
  await withServer({apiKey: 'unit-private', fetchImpl: async () => {calls++; throw new Error('unexpected');}}, async base => {
    for (const path of ['/api/map/proxy', '/api/map/data/base/20/0/0..pbf', '/api/map/styles/other/style.json']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal((await fetch(base + '/api/map/styles/day-v2/style.json?apikey=override')).status, 400);
    assert.equal((await fetch(base + '/api/map/styles/day-v2/style.json', {headers: {Origin: 'https://evil.example'}})).status, 403);
  });
  assert.equal(calls, 0);
});

test('host allowlist stays loopback unless Vercel names the deployment', () => {
  assert.equal(isAllowedHost('127.0.0.1:8765'), true);
  assert.equal(isAllowedHost('localhost:8765'), true);
  assert.equal(isAllowedHost('cam.vercel.app'), false);
  assert.equal(isAllowedHost('cam.vercel.app', {VERCEL: '1', VERCEL_URL: 'cam.vercel.app'}), true);
  assert.equal(isAllowedHost('evil.vercel.app', {VERCEL: '1', VERCEL_URL: 'cam.vercel.app'}), false);
  assert.equal(isAllowedHost('maps.example.test', {VERCEL: '1', ALLOWED_HOST: 'maps.example.test'}), true);
  assert.equal(publicOrigin('127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(publicOrigin('cam.vercel.app', {VERCEL: '1', VERCEL_URL: 'cam.vercel.app'}), 'https://cam.vercel.app');
});

test('Vercel runtime serves the named host over https origin and still rejects others', async () => {
  const env = {VERCEL: '1', VERCEL_URL: 'cam.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'cam.vercel.app'};
  await withServer({env}, async base => {
    const hit = (headers) => new Promise((resolve, reject) => {
      get(base + '/api/map-config', {headers}, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(await hit({Host: 'cam.vercel.app', Origin: 'https://cam.vercel.app'}), 200);
    assert.equal(await hit({Host: 'cam.vercel.app'}), 200);
    assert.equal(await hit({Host: 'evil.vercel.app', Origin: 'https://evil.vercel.app'}), 403);
    assert.equal(await hit({Host: 'cam.vercel.app', Origin: 'https://evil.vercel.app'}), 403);
  });
});

test('map documents provide absolute same-origin sprite and worker URLs with intact templates', async () => {
  const upstream = path => `https://maptiles.ndamaps.vn${path}?apikey=unit-private`;
  const style = {version: 8, layers: [], sources: {base: {type: 'vector', url: upstream('/data/base.json')}},
    sprite: upstream('/styles/day-v2/sprite'), glyphs: upstream('/fonts/{fontstack}/{range}.pbf')};
  await withServer({apiKey: 'unit-private', fetchImpl: async input => reply(new URL(input).pathname.endsWith('/style.json')
    ? style : {tiles: [upstream('/data/base/{z}/{x}/{y}..pbf')], maxzoom: 14})}, async base => {
    const document = await (await fetch(base + '/api/map/styles/day-v2/style.json')).json();
    // MapLibre normalizes sprites using new URL(url) with no base, before transformRequest.
    for (const ratio of ['', '@2x']) {
      const sprite = new URL(document.sprite);
      sprite.pathname += `${ratio}.json`;
      assert.equal(sprite.href, base + `/api/map/styles/day-v2/sprite${ratio}.json`);
    }
    assert.equal(document.sources.base.url, base + '/api/map/data/base.json');
    assert.equal(document.glyphs, base + '/api/map/fonts/{fontstack}/{range}.pbf');
    const metadata = await (await fetch(document.sources.base.url)).json();
    assert.equal(metadata.tiles[0], base + '/api/map/data/base/{z}/{x}/{y}..pbf');
    for (const url of [document.glyphs.replace('{fontstack}', 'Arial Unicode MS Bold').replace('{range}', '0-255'),
      metadata.tiles[0].replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')]) {
      assert.equal(new URL(new Request(url).url).origin, base);
    }
    assert.equal(JSON.stringify([document, metadata]).includes('unit-private'), false);
  });
});
