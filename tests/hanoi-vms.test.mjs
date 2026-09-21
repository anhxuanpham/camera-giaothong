import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {parseHanoiLive, extractNal, KeyframeCollector, grabAnnexB, jpegFromAnnex, ffmpegLiveArgs, createHanoiLive, fetchHanoiCameras} from '../hanoi-vms.mjs';
import {createAppServer} from '../server.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, ...Buffer.alloc(120, 1), 0xff, 0xd9]);
const packet = (codec, nal) => Buffer.concat([Buffer.from([0, codec, ...Buffer.alloc(10)]), nal]);
const hevc = {
  vps: packet(2, Buffer.from([0x40, 1])),
  sps: packet(2, Buffer.from([0x42, 1])),
  pps: packet(2, Buffer.from([0x44, 1])),
  idr: packet(2, Buffer.from([0x26, 1, 0xaf])),
  p: packet(2, Buffer.from([0x02, 1]))
};

test('parseHanoiLive accepts rec01-03 wss evup URLs and rejects anything else', () => {
  const ok = parseHanoiLive({profile: [{streams: [
    {protocol: 'HTTPS', source: 'https://rec01ihanoi.vtscloud.vn/playback/view/ch'},
    {protocol: 'WSS', source: 'wss://rec02ihanoi.vtscloud.vn:443/evup/1789978802abcXYZ/a02212a31011xyzKX2lpWcY1a'}
  ]}]});
  assert.equal(ok.token, '1789978802abcXYZ');
  assert.equal(ok.channel, 'a02212a31011xyzKX2lpWcY1a');
  assert.equal(ok.url, 'wss://rec02ihanoi.vtscloud.vn/evup/1789978802abcXYZ/a02212a31011xyzKX2lpWcY1a');
  const hd = parseHanoiLive({profile: [
    {resolution: '384x216', streams: [{protocol: 'WSS', source: 'wss://rec01ihanoi.vtscloud.vn/evup/loTok/loChan'}]},
    {resolution: '1920x1080', streams: [{protocol: 'WSS', source: 'wss://rec01ihanoi.vtscloud.vn/evup/hiTok/hiChan'}]}
  ]});
  assert.equal(hd.channel, 'hiChan');
  assert.equal(parseHanoiLive({profile: [{streams: [{protocol: 'WSS', source: 'wss://evil.example/evup/a/b'}]}]}), null);
  assert.equal(parseHanoiLive({profile: [{streams: [{protocol: 'WSS', source: 'wss://rec01ihanoi.vtscloud.vn/evup/a/b?x=1'}]}]}), null);
  assert.equal(parseHanoiLive({}), null);
});

test('keyframe collector waits for HEVC VPS/SPS/PPS plus IDR and ignores P-frames first', () => {
  const collector = new KeyframeCollector();
  assert.equal(collector.push(hevc.p), null);
  assert.equal(collector.push(hevc.vps), null);
  assert.equal(collector.push(hevc.sps), null);
  assert.equal(collector.push(hevc.pps), null);
  const frame = collector.push(hevc.idr);
  assert.equal(frame.codec, 2);
  assert.equal(frame.annex[3], 1);
  assert.equal(extractNal(hevc.idr).type, 19);
});

test('grabAnnexB sends mobile:token then returns annex-B from binary frames', async () => {
  const sent = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.handlers = {}; queueMicrotask(() => this.emit('open')); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    send(text) {
      sent.push(text);
      for (const pkt of [hevc.p, hevc.vps, hevc.sps, hevc.pps, hevc.idr]) this.emit('message', {data: pkt});
    }
    close() {}
    emit(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
  }
  const frame = await grabAnnexB({url: 'wss://rec01ihanoi.vtscloud.vn/evup/tok/ch', token: 'tok', webSocket: FakeSocket});
  assert.deepEqual(sent, ['mobile:tok']);
  assert.equal(frame.codec, 2);
  assert.ok(frame.annex.includes(0x40));
});

test('jpegFromAnnex rejects non-JPEG ffmpeg output and missing binary', async () => {
  await assert.rejects(jpegFromAnnex({annex: Buffer.alloc(8), codec: 2}), {code: 'annex'});
  const spawnImpl = () => {
    const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
    const child = {stdout, stdin, stderr, kill() {}, on(ev, fn) { if (ev === 'close') queueMicrotask(() => fn(1)); if (ev === 'error') {} }};
    stdin.end = () => {};
    return child;
  };
  await assert.rejects(jpegFromAnnex({annex: Buffer.from([0, 0, 0, 1, 0x40, 1, 0, 0, 0, 1, 0x26, 1]), codec: 2, spawnImpl}), {code: 'ffmpeg'});
});

const cdsRow = (id, extra = {}) => ({
  camera_id: id, name: 'Cam PTZ', ward_name: 'A', lng: 105.8, lat: 21.0, created_user: 'secret',
  profile: [{streams: [{protocol: 'WSS', source: `wss://rec01ihanoi.vtscloud.vn:443/evup/tok${id}/${id}xyzCH`},
    {protocol: 'HTTPS', source: `https://rec01ihanoi.vtscloud.vn/playback/view/${id}xyzCH`}]}],
  ...extra
});
const reply = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});

test('ffmpeg live args transcode to baseline fragmented MP4 on stdout', () => {
  const args = ffmpegLiveArgs(2);
  assert.ok(args.includes('hevc'));
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('pipe:1'));
  assert.equal(ffmpegLiveArgs(1).includes('h264'), true);
});

test('HTTP catalog strips live URLs; snapshot uses ffmpeg jpeg without leaking tokens', async () => {
  const fetchImpl = async () => reply({current_page: 1, last_page: 1, data: [cdsRow('cam-a')]});
  const cameras = await fetchHanoiCameras({fetchImpl});
  assert.equal('live' in cameras[0], false);
  assert.equal(JSON.stringify(cameras).includes('wss://'), false);
  class FakeSocket {
    constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open')); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    send() { for (const pkt of [hevc.vps, hevc.sps, hevc.pps, hevc.idr]) this.emit('message', {data: pkt}); }
    close() {}
    emit(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
  }
  const spawnImpl = () => {
    const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
    const child = {stdout, stdin, stderr, kill() {}, on(ev, fn) {
      if (ev === 'close') queueMicrotask(() => { stdout.write(jpeg); stdout.end(); fn(0); });
    }};
    stdin.on('error', () => {});
    return child;
  };
  const hanoi = createHanoiLive({fetchImpl, webSocket: FakeSocket, spawnImpl, catalogTtlMs: 60_000, jpegTtlMs: 60_000});
  const server = createAppServer({intervalMs: 0, fetchImpl, hanoiLive: hanoi});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + '/api/hanoi/cameras')).json();
    assert.equal(list.length, 1);
    assert.equal(JSON.stringify(list).includes('tok'), false);
    const image = await fetch(base + '/api/hanoi/snapshot/cam-a');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    const body = Buffer.from(await image.arrayBuffer());
    assert.equal(body[0], 0xff); assert.equal(body[1], 0xd8);
    assert.equal((await fetch(base + '/api/hanoi/snapshot/missing')).status, 404);
    assert.equal((await fetch(base + '/hanoi-vms.mjs')).status, 404);
    class LiveSocket {
      constructor() { this.handlers = {}; queueMicrotask(() => this.emit('open')); }
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
      send() { for (const pkt of [hevc.vps, hevc.sps, hevc.pps, hevc.idr]) this.emit('message', {data: pkt}); }
      close() {}
      emit(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
    }
    const liveSpawn = (bin, args) => {
      assert.ok(args.includes('libx264'));
      const stdout = new PassThrough(), stdin = new PassThrough(), stderr = new PassThrough();
      stdin.on('data', () => stdout.write(Buffer.from('ftypmoovmoofmdat-live')));
      return {stdout, stdin, stderr, kill() { stdout.end(); stdin.end(); }, on() {}};
    };
    const liveHanoi = createHanoiLive({fetchImpl, webSocket: LiveSocket, spawnImpl: liveSpawn, catalogTtlMs: 60_000});
    const liveServer = createAppServer({intervalMs: 0, fetchImpl, hanoiLive: liveHanoi});
    await new Promise(resolve => liveServer.listen(0, '127.0.0.1', resolve));
    const liveBase = `http://127.0.0.1:${liveServer.address().port}`;
    try {
      const abort = new AbortController();
      const live = await fetch(liveBase + '/api/hanoi/live/cam-a', {signal: abort.signal});
      assert.equal(live.status, 200);
      assert.equal(live.headers.get('content-type'), 'video/mp4');
      const first = await live.body.getReader().read();
      abort.abort();
      assert.ok(first.value?.byteLength > 0);
      assert.equal((await fetch(liveBase + '/api/hanoi/live/missing')).status, 404);
      assert.equal((await fetch(liveBase + '/api/hanoi/live/cam-a', {method: 'POST'})).status, 405);
    } finally {
      liveServer.closeAllConnections();
      await new Promise(resolve => liveServer.close(resolve));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
