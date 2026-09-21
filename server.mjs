import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validPlaceRef, validCoordinates} from './assets/camera-core.mjs';
import {createNdaMaps, NDA_STYLE_PATH} from './nda-maps.mjs';
import {fetchHanoiCameras, createHanoiLive} from './hanoi-vms.mjs';
import {isAllowedHost, isVercelRuntime, publicOrigin} from './public-origin.mjs';

export {fetchHanoiCameras, isAllowedHost, publicOrigin};

const moduleRoot = fileURLToPath(new URL('./', import.meta.url));
const staticRoot = env => isVercelRuntime(env) ? process.cwd() : moduleRoot;
const publicFiles = new Map([
  ['/camera-traffic.html', 'text/html; charset=utf-8'],
  ['/cameras_full.json', 'application/json'],
  ['/cameras_hanoi.json', 'application/json'],
  ...['camera-app', 'camera-api', 'camera-core', 'snapshot-loader', 'vietnam-basemap', 'hanoi-live'].map(name => [`/assets/${name}.mjs`, 'text/javascript; charset=utf-8']),
  ['/assets/camera-traffic.css', 'text/css; charset=utf-8']
]);
const message = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(data));
};

async function readKeychain() {
  const {stdout} = await promisify(execFile)('/usr/bin/security', [
    'find-generic-password', '-s', 'camera-giaothong.ndamaps', '-a', 'NDAMAPS_API_KEY', '-w'
  ], {timeout: 5000, maxBuffer: 4096});
  return stdout;
}

export async function resolveMapKey({env = process.env, platform = process.platform, readStoredKey = readKeychain} = {}) {
  if (env.NDAMAPS_API_KEY?.trim()) return env.NDAMAPS_API_KEY.trim();
  if (platform !== 'darwin') return '';
  try { return (await readStoredKey()).trim(); }
  catch (error) {
    if (error.code === 44) return ''; // The app-specific Keychain item has not been configured.
    // Never expose child-process output: it can contain the secret.
    throw new Error('Không đọc được khóa NDA Maps trong macOS Keychain. Mở khóa Keychain hoặc đặt NDAMAPS_API_KEY rồi chạy lại.');
  }
}

export function createRequestListener(options = {}) {
  const env = options.env || process.env;
  const provider = createNdaMaps(options);
  const fetchImpl = options.fetchImpl || fetch;
  const hanoi = options.hanoiLive || createHanoiLive({fetchImpl, webSocket: options.webSocket, spawnImpl: options.spawnImpl, ffmpegPath: options.ffmpegPath});
  let rateWindow = 0, requests = 0, snapshotWindow = 0, snapshots = 0, liveWindow = 0, lives = 0;
  return async (req, res) => {
    try {
      // Restrict this service so another website cannot use the paid API.
      const host = req.headers.host || '';
      if (!isAllowedHost(host, env)) return message(res, 403, {error: 'Máy chủ không chấp nhận truy cập từ máy chủ này.'});
      const origin = publicOrigin(host, env);
      if (!origin || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        return message(res, 403, {error: 'Không chấp nhận yêu cầu từ trang khác.'});
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return message(res, 405, {error: 'Phương thức không được hỗ trợ.'});
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/map-config') {
        return message(res, 200, {provider: 'ndamaps', style: 'day-v2', styleUrl: NDA_STYLE_PATH, configured: provider.configured, searchConfigured: provider.configured});
      }
      if (url.pathname === '/api/hanoi/cameras') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        try {
          const cameras = await hanoi.cameras(controller.signal);
          if (!res.destroyed) {
            if (cameras.some(row => 'live' in row || JSON.stringify(row).includes('wss://'))) throw new Error('leak');
            message(res, 200, cameras);
          }
        } catch {
          if (!res.destroyed) message(res, 502, {error: 'Chưa tải được danh mục camera Hà Nội. Hãy thử lại.'});
        } finally { res.removeListener('close', abort); }
        return;
      }
      const liveMatch = url.pathname.match(/^\/api\/hanoi\/live\/([\w-]{1,64})$/);
      if (liveMatch) {
        if (req.method !== 'GET') return message(res, 405, {error: 'Live chỉ nhận GET.'});
        if (Date.now() - liveWindow >= 60000) { liveWindow = Date.now(); lives = 0; }
        if (++lives > 8) return message(res, 429, {error: 'Đã mở quá nhiều live Hà Nội. Chờ một phút rồi thử lại.'});
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        let headersSent = false;
        try {
          const session = await hanoi.startLiveView(liveMatch[1], {
            signal: controller.signal,
            onChunk(chunk) {
              if (res.destroyed) return;
              if (!headersSent) {
                headersSent = true;
                res.writeHead(200, {
                  'Content-Type': 'video/mp4',
                  'Cache-Control': 'no-store',
                  'X-Content-Type-Options': 'nosniff'
                });
              }
              res.write(chunk);
            }
          });
          const firstByte = setTimeout(() => {
            if (!headersSent && !res.destroyed) {
              session.stop();
              message(res, 502, {error: 'Chưa lấy được live Hà Nội. Hãy thử lại.'});
            }
          }, 10000);
          res.once('close', () => { clearTimeout(firstByte); session.stop(); });
        } catch (error) {
          if (!res.destroyed && !headersSent) {
            const status = error.status === 404 ? 404 : error.code === 'ffmpeg-missing' ? 503 : error.code === 'id' ? 400 : 502;
            message(res, status, {error: status === 503
              ? 'Máy chủ chưa có ffmpeg để phát live.'
              : status === 404 ? 'Không có camera Hà Nội này.'
              : 'Chưa lấy được live Hà Nội. Hãy thử lại.'});
          }
        } finally { res.removeListener('close', abort); }
        return;
      }
      const snapshotMatch = url.pathname.match(/^\/api\/hanoi\/snapshot\/([\w-]{1,64})$/);
      if (snapshotMatch) {
        if (Date.now() - snapshotWindow >= 60000) { snapshotWindow = Date.now(); snapshots = 0; }
        if (++snapshots > 40) return message(res, 429, {error: 'Đã tải quá nhiều ảnh Hà Nội. Chờ một phút rồi thử lại.'});
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        try {
          const jpeg = await hanoi.snapshot(snapshotMatch[1], controller.signal);
          if (!res.destroyed) {
            res.writeHead(200, {'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
            res.end(req.method === 'HEAD' ? undefined : jpeg);
          }
        } catch (error) {
          if (!res.destroyed) {
            const status = error.status === 404 ? 404 : error.code === 'ffmpeg-missing' ? 503 : error.code === 'id' ? 400 : 502;
            message(res, status, {error: status === 503
              ? 'Máy chủ chưa có ffmpeg để giải mã luồng Hà Nội.'
              : status === 404 ? 'Không có camera Hà Nội này.'
              : 'Chưa lấy được ảnh live Hà Nội. Hãy thử lại.'});
          }
        } finally { res.removeListener('close', abort); }
        return;
      }
      const mapResource = url.pathname.startsWith('/api/map/');
      if (mapResource || ['/api/places', '/api/place'].includes(url.pathname)) {
        if (req.method !== 'GET') return message(res, 405, {error: 'Tìm địa điểm cần GET.'});
        const detail = url.pathname === '/api/place';
        const value = url.searchParams.get(detail ? 'ref' : 'q')?.trim() || '';
        if (!mapResource && (detail ? !validPlaceRef(value) : value.length < 2 || value.length > 200)) {
          return message(res, 400, {error: 'Địa điểm cần tìm không hợp lệ.'});
        }
        if (!provider.configured) return message(res, 503, {error: 'Chưa cấu hình NDA Maps.'});
        if (!mapResource) {
          if (Date.now() - rateWindow >= 60000) { rateWindow = Date.now(); requests = 0; }
          if (++requests > 60) return message(res, 429, {error: 'Đã tìm quá nhiều lần. Chờ một phút rồi thử lại.'});
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        try {
          if (mapResource) {
            if (url.search) return message(res, 400, {error: 'Tài nguyên bản đồ không hợp lệ.'});
            const result = await provider.map(decodeURIComponent(url.pathname.slice('/api/map'.length)), controller.signal, origin);
            if (!res.destroyed) {
              res.writeHead(200, {'Content-Type': result.type, 'Cache-Control': result.cacheControl, 'X-Content-Type-Options': 'nosniff'});
              res.end(result.body);
            }
          } else {
            const result = await provider.places(value, detail, controller.signal);
            if (!res.destroyed) message(res, 200, result);
          }
        } catch (error) {
          // Upstream errors may include the key-bearing URL. Never echo or log them.
          if (!res.destroyed) message(res, [404, 429, 503].includes(error.status) ? error.status : 502, {error: 'Dịch vụ NDA Maps chưa khả dụng. Hãy thử lại.'});
        } finally { res.removeListener('close', abort); }
        return;
      }
      const path = url.pathname === '/' ? '/camera-traffic.html' : url.pathname;
      const type = publicFiles.get(path);
      if (!type) return message(res, 404, {error: 'Không tìm thấy tài nguyên.'});
      const body = await readFile(join(staticRoot(env), path.slice(1)));
      res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { if (!res.destroyed) message(res, 500, {error: 'Không tải được tài nguyên.'}); }
  };
}

export function createAppServer(options = {}) {
  return createServer(createRequestListener(options));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let apiKey;
  try { apiKey = await resolveMapKey(); }
  catch (error) { console.error(error.message); process.exit(1); }
  const server = createAppServer({apiKey});
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Cổng 8765 đang được sử dụng. Kiểm tra tiến trình hiện có.' : 'Không khởi động được máy chủ.'); process.exitCode = 1; });
  server.listen(8765, '127.0.0.1', () => {
    console.log('Camera: http://127.0.0.1:8765/camera-traffic.html');
    if (!apiKey) console.log('Chưa cấu hình khóa NDA Maps trong Keychain hoặc NDAMAPS_API_KEY. Bản đồ nền và tìm địa điểm chưa khả dụng.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
