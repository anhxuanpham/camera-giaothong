import test from 'node:test';
import assert from 'node:assert/strict';
import {basemapStyle, VietnamBasemap} from '../assets/vietnam-basemap.mjs';
const config = {provider: 'ndamaps', style: 'day-v2', styleUrl: '/api/map/styles/day-v2/style.json', configured: true};
function setup(options = {}) {
  const events = new Map(), states = [], layers = new Set(), credits = new Set();
  const map = {removeLayer: layer => layers.delete(layer), attributionControl: {addAttribution: credit => credits.add(credit), removeAttribution: credit => credits.delete(credit)}};
  const gl = {on: (name, callback) => events.set(name, callback), off: name => events.delete(name), loaded: () => false};
  const layer = {addTo: () => layers.add(layer), getMaplibreMap: () => gl};
  const basemap = new VietnamBasemap(map, state => states.push(state), {getConfig: async () => config, prepare: async () => {}, createLayer: () => layer, ...options});
  return {basemap, events, states, layers, credits};
}
test('basemap config is restricted to the selected provider and style', () => {
  assert.equal(basemapStyle(config), '/api/map/styles/day-v2/style.json');
  for (const candidate of [null, {...config, provider: 'osm'}, {...config, style: 'foreign'}, {...config, configured: false},
    {...config, styleUrl: 'https://evil.example/style.json'}]) assert.throws(() => basemapStyle(candidate));
});
test('missing configuration does not load SDK or an alternate map source', async () => {
  const probe = setup({getConfig: async () => ({...config, configured: false}), prepare: async () => assert.fail('must not load')});
  await probe.basemap.start();
  assert.match(probe.states.at(-1).message, /chưa được cấu hình/); assert.equal(probe.layers.size, 0);
});
test('load success, later errors and disposal clean layers, attribution and listeners', async () => {
  const probe = setup(); await probe.basemap.start();
  assert.equal(probe.states.at(-1).ready, false);
  probe.events.get('load')(); assert.equal(probe.states.at(-1).ready, true); assert.equal(probe.credits.size, 1);
  probe.events.get('error')({error: new Error('key-bearing URL')});
  assert.equal(probe.layers.size, 0); assert.equal(probe.credits.size, 0); assert.equal(probe.events.size, 0);
  assert.equal(probe.states.at(-1).message.includes('key-bearing'), false);
  await probe.basemap.start(); probe.basemap.dispose(); assert.equal(probe.events.size, 0); assert.equal(probe.layers.size, 0);
});
test('retry supersedes older pending initialization', async () => {
  let release, calls = 0;
  const probe = setup({getConfig: () => ++calls === 1 ? new Promise(resolve => {release = resolve;}) : Promise.resolve(config)});
  const old = probe.basemap.start(); await probe.basemap.start(); probe.events.get('load')();
  release({...config, configured: false}); await old;
  assert.equal(probe.states.at(-1).ready, true); assert.equal(probe.layers.size, 1); probe.basemap.dispose();
});
test('basemap initial loading has a deadline', async () => {
  const probe = setup({timeoutMs: 5}); await probe.basemap.start();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(probe.states.at(-1).loading, false); assert.equal(probe.states.at(-1).ready, false);
  assert.equal(probe.layers.size, 0); assert.equal(probe.events.size, 0);
});
