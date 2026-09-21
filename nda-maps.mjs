import {setTimeout as delay} from 'node:timers/promises';
import {normalizePlaceSuggestions, normalizePlaceDetail} from './assets/camera-core.mjs';
import {isAllowedPublicOrigin} from './public-origin.mjs';

const tileOrigin = 'https://maptiles.ndamaps.vn';
export const NDA_STYLE_PATH = '/api/map/styles/day-v2/style.json';

export function validMapPath(path, templates = false) {
  if (path === '/styles/day-v2/style.json' || path === '/data/base.json' ||
    /^\/styles\/day-v2\/sprite(?:@2x)?\.(json|png)$/.test(path)) return true;
  if (templates && ['/styles/day-v2/sprite', '/fonts/{fontstack}/{range}.pbf',
    '/data/base/{z}/{x}/{y}..pbf', '/data/base/{z}/{x}/{y}.pbf'].includes(path)) return true;
  const tile = path.match(/^\/data\/base\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.{1,2}pbf$/);
  if (tile) return +tile[1] <= 14 && +tile[2] < 2 ** +tile[1] && +tile[3] < 2 ** +tile[1];
  const font = path.match(/^\/fonts\/([\p{L}\p{N} ,_-]{1,200})\/(\d{1,5})-(\d{1,5})\.pbf$/u);
  return Boolean(font && +font[2] % 256 === 0 && +font[3] === +font[2] + 255 && +font[3] <= 65535);
}

function localResource(value, origin) {
  const url = new URL(value);
  const path = decodeURIComponent(url.pathname);
  if (url.origin !== tileOrigin || url.username || url.password || url.hash || !validMapPath(path, true) ||
    [...url.searchParams.keys()].some(key => key !== 'apikey')) throw new Error('Unsupported map resource');
  // MapLibre sprites and worker requests require absolute URLs. Keep templates intact.
  // The browser only contacts the local proxy and never receives the provider key.
  return origin + '/api/map' + path;
}

export function rewriteMapDocument(data, style = false, origin, env = process.env) {
  if (!isAllowedPublicOrigin(origin, env)) throw new Error('Invalid local map origin');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid map document');
  if (style) {
    if (data.version !== 8 || !Array.isArray(data.layers) || !data.sources || data.imports) throw new Error('Invalid style');
    const sources = {};
    for (const [name, source] of Object.entries(data.sources)) {
      if (source?.type !== 'vector' || typeof source.url !== 'string' || source.tiles) throw new Error('Invalid map source');
      sources[name] = {...source, url: localResource(source.url, origin)};
    }
    return {...data, sources, glyphs: localResource(data.glyphs, origin), sprite: localResource(data.sprite, origin)};
  }
  if (!Array.isArray(data.tiles) || !data.tiles.length) throw new Error('Invalid tile metadata');
  return {...data, tiles: data.tiles.map(value => localResource(value, origin))};
}

export class NdaMapsError extends Error {
  constructor(status = 502) { super('NDA Maps request unavailable'); this.status = status; }
}

export function createNdaMaps({apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 30000, intervalMs = 250, env = process.env} = {}) {
  let nextRequest = 0, queue = Promise.resolve(), queued = 0;
  async function reserve(signal) {
    if (queued >= 120) throw new NdaMapsError(429);
    queued++;
    const turn = queue.then(async () => {
      signal.throwIfAborted();
      const wait = nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, {signal});
      signal.throwIfAborted();
      nextRequest = Date.now() + intervalMs;
    }).finally(() => { queued--; });
    queue = turn.catch(() => {});
    await turn;
  }
  async function request(url, signal, json) {
    if (!apiKey) throw new NdaMapsError(503);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, timeoutMs);
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new NdaMapsError());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    try {
      return await Promise.race([interrupted, (async () => {
        await reserve(controller.signal);
        url.searchParams.set('apikey', apiKey);
        const response = await fetchImpl(url.href, {signal: controller.signal, redirect: 'error', headers: {Accept: json ? 'application/json' : '*/*'}});
        if (!response.ok) throw new NdaMapsError(response.status === 429 ? 429 : 502);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 8 * 1024 * 1024) throw new NdaMapsError();
        return {body: json ? JSON.parse(body.toString('utf8')) : body, cache: response.headers.get('cache-control')};
      })()]);
    } catch (error) {
      // Do not propagate fetch errors, URLs or upstream bodies containing credentials.
      throw error instanceof NdaMapsError ? error : new NdaMapsError();
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    configured: Boolean(apiKey),
    async places(value, detail, signal) {
      const url = new URL(`https://mapapis.ndamaps.vn/v1/${detail ? 'place' : 'autocomplete'}`);
      url.searchParams.set(detail ? 'ids' : 'text', value);
      url.searchParams.set('admin_v2', 'true');
      if (!detail) url.searchParams.set('size', '10');
      const {body} = await request(url, signal, true);
      try { return detail ? normalizePlaceDetail(body) : normalizePlaceSuggestions(body); }
      catch { throw new NdaMapsError(); }
    },
    async map(path, signal, origin) {
      if (!validMapPath(path)) throw new NdaMapsError(404);
      const json = path.endsWith('.json');
      const {body, cache} = await request(new URL(path, tileOrigin), signal, json);
      let result = body;
      if (path.endsWith('/style.json') || path === '/data/base.json') {
        try { result = rewriteMapDocument(body, path.endsWith('/style.json'), origin, env); }
        catch { throw new NdaMapsError(); }
      }
      const output = json ? Buffer.from(JSON.stringify(result)) : result;
      if (output.includes(Buffer.from(apiKey))) throw new NdaMapsError();
      const type = json ? 'application/json' : path.endsWith('.png') ? 'image/png' : 'application/x-protobuf';
      // Respect no-store/no-cache upstream; otherwise only allow a short private browser cache.
      const seconds = Number(cache?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] || 0);
      const cacheControl = /no-store/i.test(cache || '') ? 'no-store' : /no-cache/i.test(cache || '') || !seconds ? 'no-cache' : `private, max-age=${Math.min(seconds, 300)}`;
      return {body: output, type, cacheControl};
    }
  };
}
