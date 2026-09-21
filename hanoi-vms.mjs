import {spawn} from 'node:child_process';
import {validCoordinates} from './assets/camera-core.mjs';

export const HANOI_CATALOG = 'https://cds.hanoi.gov.vn/api/1.0/public/video-wall-cameras-v2';
const NALU_START = Buffer.from([0, 0, 0, 1]);
const LIVE_HOST = /^rec0[123]ihanoi\.vtscloud\.vn$/;
const TOKEN = /^[\w-]{1,64}$/;

function parseWssSource(source) {
  let url;
  try { url = new URL(source); } catch { return null; }
  if (url.protocol !== 'wss:' || !LIVE_HOST.test(url.hostname) || (url.port && url.port !== '443')) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'evup' || !TOKEN.test(parts[1]) || !TOKEN.test(parts[2])) return null;
  return {url: `wss://${url.hostname}/evup/${parts[1]}/${parts[2]}`, token: parts[1], channel: parts[2]};
}

export function parseHanoiLive(raw) {
  let best = null, bestPixels = -1;
  for (const profile of Array.isArray(raw?.profile) ? raw.profile : []) {
    const [width, height] = String(profile?.resolution || '0x0').split('x').map(Number);
    const pixels = (Number.isFinite(width) ? width : 0) * (Number.isFinite(height) ? height : 0);
    const wss = (Array.isArray(profile?.streams) ? profile.streams : []).find(stream => stream?.protocol === 'WSS' && typeof stream.source === 'string');
    const live = wss ? parseWssSource(wss.source) : null;
    if (live && pixels >= bestPixels) { best = live; bestPixels = pixels; }
  }
  return best;
}

export function publicHanoiCamera(row) {
  const {live, ...pub} = row;
  return pub;
}

export async function fetchHanoiCatalog({fetchImpl = fetch, signal} = {}) {
  const rows = [];
  let page = 1, last = 1;
  while (page <= last && page <= 20) {
    const response = await fetchImpl(`${HANOI_CATALOG}?page=${page}&refresh=0`, {
      signal, headers: {Accept: 'application/json'}
    });
    if (!response.ok) throw Object.assign(new Error('cds'), {status: response.status});
    const json = await response.json();
    if (!Array.isArray(json?.data)) throw new Error('schema');
    last = Number.isFinite(json.last_page) && json.last_page > 0 ? Math.min(json.last_page, 20) : 1;
    rows.push(...json.data);
    page += 1;
  }
  const unique = new Map();
  for (const raw of rows) {
    const cameraId = typeof raw?.camera_id === 'string' ? raw.camera_id.trim() : '';
    const lon = Number(raw?.lng), lat = Number(raw?.lat);
    if (!TOKEN.test(cameraId) || !validCoordinates(lon, lat) || unique.has(cameraId)) continue;
    unique.set(cameraId, {
      camera_id: cameraId,
      name: String(raw.name || '').slice(0, 200),
      ward_name: String(raw.ward_name || '').slice(0, 120),
      lng: lon,
      lat,
      ptz: /\bPTZ\b/i.test(String(raw.name || '')),
      live: parseHanoiLive(raw)
    });
  }
  if (!unique.size) throw new Error('empty');
  return [...unique.values()];
}

export async function fetchHanoiCameras(options) {
  return (await fetchHanoiCatalog(options)).map(publicHanoiCamera);
}

export function extractNal(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 13) return null;
  const codec = packet[1];
  if (codec !== 1 && codec !== 2) return null;
  const nal = packet.subarray(12);
  const type = codec === 1 ? nal[0] & 31 : (nal[0] >> 1) & 63;
  return {codec, type, annex: Buffer.concat([NALU_START, nal])};
}

export class KeyframeCollector {
  codec = null;
  parts = new Map();
  push(packet) {
    const nal = extractNal(packet);
    if (!nal) return null;
    if (this.codec == null) this.codec = nal.codec;
    if (nal.codec !== this.codec) return null;
    const avc = this.codec === 1;
    const isParam = avc ? nal.type === 7 || nal.type === 8 : nal.type === 32 || nal.type === 33 || nal.type === 34;
    const isIdr = avc ? nal.type === 5 : nal.type === 19 || nal.type === 20;
    if (isParam) this.parts.set(nal.type, nal.annex);
    if (isIdr) this.parts.set('idr', nal.annex);
    const ready = avc
      ? this.parts.has(7) && this.parts.has(8) && this.parts.has('idr')
      : this.parts.has(32) && this.parts.has(33) && this.parts.has(34) && this.parts.has('idr');
    if (!ready) return null;
    const order = avc ? [7, 8, 'idr'] : [32, 33, 34, 'idr'];
    return {codec: this.codec, annex: Buffer.concat(order.map(key => this.parts.get(key)))};
  }
}

async function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return null;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data?.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer());
  return null;
}

export async function grabAnnexB({url, token, webSocket = WebSocket, signal, timeoutMs = 7000} = {}) {
  if (!url || !TOKEN.test(token)) throw Object.assign(new Error('live'), {code: 'live'});
  const collector = new KeyframeCollector();
  const ws = new webSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(value);
      };
      const onAbort = () => finish(Object.assign(new Error('aborted'), {code: 'aborted'}));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, {once: true});
      const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), {code: 'timeout'})), timeoutMs);
      ws.addEventListener('open', () => {
        try { ws.send(`mobile:${token}`); }
        catch (error) { finish(error); }
      });
      ws.addEventListener('message', async event => {
        try {
          const packet = await asBuffer(event.data);
          if (!packet) return;
          const keyframe = collector.push(packet);
          if (keyframe) finish(null, keyframe);
        } catch (error) { finish(error); }
      });
      ws.addEventListener('error', () => finish(Object.assign(new Error('ws'), {code: 'ws'})));
      ws.addEventListener('close', () => finish(Object.assign(new Error('closed'), {code: 'closed'})));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

export function ffmpegLiveArgs(codec) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay',
    '-f', codec === 1 ? 'h264' : 'hevc', '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.1',
    '-g', '30', '-keyint_min', '30', '-bf', '0', '-sc_threshold', '0',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1', 'pipe:1'
  ];
}

export function jpegFromAnnex({annex, codec, spawnImpl = spawn, ffmpegPath = 'ffmpeg', timeoutMs = 6000} = {}) {
  if (!Buffer.isBuffer(annex) || annex.length < 8 || annex[0] !== 0 || annex[3] !== 1 || (codec !== 1 && codec !== 2)) {
    return Promise.reject(Object.assign(new Error('annex'), {code: 'annex'}));
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', codec === 1 ? 'h264' : 'hevc', '-i', 'pipe:0',
      '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ], {stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('ffmpeg-timeout'), {code: 'ffmpeg-timeout'}));
    }, timeoutMs);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', error => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? Object.assign(new Error('ffmpeg-missing'), {code: 'ffmpeg-missing'}) : error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (code === 0 && jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8) resolve(jpeg);
      else reject(Object.assign(new Error('ffmpeg'), {code: 'ffmpeg'}));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(annex);
  });
}

export function createHanoiLive(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  let catalogAt = 0, catalog = new Map(), jpegCache = new Map(), inflight = new Map(), currentLive = null;
  const catalogTtl = options.catalogTtlMs ?? 45000;
  const jpegTtl = options.jpegTtlMs ?? 8000;
  async function refresh(signal) {
    if (Date.now() - catalogAt < catalogTtl && catalog.size) return catalog;
    const rows = await fetchHanoiCatalog({fetchImpl, signal});
    catalog = new Map(rows.map(row => [row.camera_id, row]));
    catalogAt = Date.now();
    return catalog;
  }
  function stopLive() {
    const session = currentLive;
    currentLive = null;
    session?.stop();
  }
  return {
    async cameras(signal) {
      return [...(await refresh(signal)).values()].map(publicHanoiCamera);
    },
    async snapshot(cameraId, signal) {
      if (!TOKEN.test(cameraId)) throw Object.assign(new Error('id'), {code: 'id', status: 400});
      const cached = jpegCache.get(cameraId);
      if (cached && Date.now() - cached.at < jpegTtl) return cached.jpeg;
      if (inflight.has(cameraId)) return inflight.get(cameraId);
      const work = (async () => {
        const rows = await refresh(signal);
        const camera = rows.get(cameraId);
        if (!camera?.live) throw Object.assign(new Error('offline'), {code: 'offline', status: 404});
        const keyframe = await grabAnnexB({
          url: camera.live.url, token: camera.live.token, signal,
          webSocket: options.webSocket || WebSocket
        });
        const jpeg = await jpegFromAnnex({
          annex: keyframe.annex, codec: keyframe.codec,
          spawnImpl: options.spawnImpl || spawn, ffmpegPath: options.ffmpegPath || 'ffmpeg'
        });
        jpegCache.set(cameraId, {at: Date.now(), jpeg});
        return jpeg;
      })().finally(() => inflight.delete(cameraId));
      inflight.set(cameraId, work);
      return work;
    },
    stopLive,
    async startLiveView(cameraId, {signal, onChunk} = {}) {
      if (!TOKEN.test(cameraId)) throw Object.assign(new Error('id'), {code: 'id', status: 400});
      const rows = await refresh(signal);
      const camera = rows.get(cameraId);
      if (!camera?.live) throw Object.assign(new Error('offline'), {code: 'offline', status: 404});
      stopLive();
      const collector = new KeyframeCollector();
      const WebSock = options.webSocket || WebSocket;
      const ws = new WebSock(camera.live.url);
      let child = null, settled = false;
      const stop = () => {
        try { ws.close(); } catch {}
        if (child) {
          try { child.stdin.end(); } catch {}
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800);
        }
      };
      currentLive = {stop};
      const onAbort = () => stop();
      if (signal?.aborted) { stop(); throw Object.assign(new Error('aborted'), {code: 'aborted'}); }
      signal?.addEventListener('abort', onAbort, {once: true});
      return await new Promise((resolve, reject) => {
        const fail = error => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          stop();
          reject(error);
        };
        const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), {code: 'timeout'})), 12000);
        ws.addEventListener('open', () => {
          try { ws.send(`mobile:${camera.live.token}`); }
          catch (error) { fail(error); }
        });
        ws.addEventListener('message', async event => {
          try {
            const packet = await asBuffer(event.data);
            if (!packet) return;
            if (!child) {
              const keyframe = collector.push(packet);
              if (!keyframe) return;
              child = (options.spawnImpl || spawn)(options.ffmpegPath || 'ffmpeg', ffmpegLiveArgs(keyframe.codec), {stdio: ['pipe', 'pipe', 'pipe']});
              child.stdout.on('data', chunk => onChunk?.(chunk));
              child.stderr.resume();
              child.stdin.on('error', () => {});
              child.on('error', error => fail(error.code === 'ENOENT'
                ? Object.assign(new Error('ffmpeg-missing'), {code: 'ffmpeg-missing'}) : error));
              child.stdin.write(keyframe.annex);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({stop});
              }
              return;
            }
            const nal = extractNal(packet);
            if (nal) child.stdin.write(nal.annex);
          } catch (error) { fail(error); }
        });
        ws.addEventListener('error', () => fail(Object.assign(new Error('ws'), {code: 'ws'})));
        ws.addEventListener('close', () => {
          try { child?.stdin.end(); } catch {}
        });
      });
    }
  };
}
