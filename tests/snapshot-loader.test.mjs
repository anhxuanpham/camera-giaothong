import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotLoader, SnapshotRefresh} from '../assets/snapshot-loader.mjs';
function harness() {
  const images = [], states = [], timers = new Map(); let clock = 100, timerId = 0;
  const loader = new SnapshotLoader({url: 'https://api.notis.vn/v4/cameras/id/snapshot', now: () => clock++, onState: state => states.push(state),
    imageFactory: () => {const image = {naturalWidth: 512, removeAttribute() {this.src = '';}}; images.push(image); return image;},
    schedule: callback => {timers.set(++timerId, callback); return timerId;}, unschedule: id => timers.delete(id)});
  return {loader, images, states, timers};
}
test('success time only advances when a real image load completes, not on refresh', () => {
  const {loader, images} = harness(); loader.start();
  assert.equal(loader.state.loadedAt, null); assert.equal(loader.state.status, 'loading');
  images[0].onload(); const first = loader.state;
  assert.equal(first.status, 'ready'); assert.equal(first.image, images[0]); assert.ok(first.loadedAt);
  loader.refresh(); assert.equal(loader.state.loadedAt, first.loadedAt); assert.equal(loader.state.src, first.src);
  images[1].onerror(); assert.equal(loader.state.loadedAt, first.loadedAt); assert.equal(loader.state.image, first.image);
  assert.equal(loader.state.status, 'error'); loader.stop();
});
test('closed views never load and overlapping refresh requests are suppressed', () => {
  const {loader, images} = harness(); loader.refresh(); assert.equal(images.length, 0);
  loader.start(); loader.refresh(); loader.refresh(); assert.equal(images.length, 1);
  const lateLoad = images[0].onload; loader.stop(); lateLoad();
  assert.equal(loader.state.loadedAt, null); assert.equal(loader.pending, null);
  loader.refresh(); assert.equal(images.length, 1);
  loader.start(); assert.equal(images.length, 2); loader.stop();
});
test('image timeout retains last success and allows retry', () => {
  const {loader, images, timers} = harness(); loader.start(); images[0].onload();
  const first = loader.state.src; loader.refresh(); [...timers.values()][0]();
  assert.equal(loader.state.status, 'error'); assert.equal(loader.state.src, first); assert.equal(timers.size, 0);
  loader.refresh(); assert.equal(images.length, 3); loader.stop();
});
test('relative Hanoi snapshot paths resolve against the page origin', () => {
  const images = [];
  const loader = new SnapshotLoader({
    url: './api/hanoi/snapshot/gm9SoV9AOg', now: () => 7,
    onState() {}, imageFactory: () => { const image = {naturalWidth: 1, removeAttribute() {}}; images.push(image); return image; },
    schedule: () => 1, unschedule() {}
  });
  const href = globalThis.location?.href;
  globalThis.location = {href: 'http://127.0.0.1:8765/camera-traffic.html'};
  try {
    loader.start();
    assert.equal(images[0].src, 'http://127.0.0.1:8765/api/hanoi/snapshot/gm9SoV9AOg?t=7');
  } finally {
    if (href) globalThis.location.href = href; else delete globalThis.location;
    loader.stop();
  }
});
test('invalid or empty snapshots never claim a successful frame', () => {
  const {loader, images} = harness(); loader.start(); images[0].naturalWidth = 0; images[0].onload();
  assert.equal(loader.state.status, 'error'); assert.equal(loader.state.loadedAt, null);
  loader.url = null; loader.refresh(); assert.equal(images.length, 1); assert.match(loader.state.error, /đường dẫn/);
});
test('refresh coordinator includes popup and dialog loaders, only while open and visible', () => {
  let callback, activeTimers = 0;
  const coordinator = new SnapshotRefresh({schedule: fn => {callback = fn; activeTimers++; return 1;}, unschedule: () => {activeTimers--;}});
  const popup = {starts: 0, stops: 0, ticks: 0, start() {this.starts++;}, stop() {this.stops++;}, refresh() {this.ticks++;}};
  const sidebar = {...popup};
  coordinator.setEnabled(true); assert.equal(activeTimers, 0);
  coordinator.add(popup); coordinator.add(sidebar); assert.equal(activeTimers, 1);
  callback(); assert.equal(popup.ticks, 1); assert.equal(sidebar.ticks, 1);
  coordinator.remove(popup); callback(); assert.equal(popup.ticks, 1); assert.equal(sidebar.ticks, 2);
  coordinator.setVisible(false); assert.equal(activeTimers, 0); assert.equal(sidebar.stops, 1);
  coordinator.setVisible(true); assert.equal(activeTimers, 1); assert.equal(sidebar.starts, 2);
  coordinator.setEnabled(false); assert.equal(activeTimers, 0);
  coordinator.dispose(); assert.equal(coordinator.loaders.size, 0);
});

test('default timer adapters invoke browser timers with the correct receiver', () => {
  const original = {setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval};
  let calls = 0;
  try {
    for (const key of Object.keys(original)) globalThis[key] = function () {
      assert.ok(this === undefined || this === globalThis, `${key} must not receive a controller instance`);
      calls++; return 1;
    };
    const image = {naturalWidth: 1, removeAttribute() {}};
    const loader = new SnapshotLoader({url: 'https://example.invalid/image', imageFactory: () => image, onState() {}});
    const coordinator = new SnapshotRefresh();
    coordinator.setEnabled(true); coordinator.add(loader); image.onload(); coordinator.remove(loader);
    assert.equal(calls, 4);
  } finally { Object.assign(globalThis, original); }
});
