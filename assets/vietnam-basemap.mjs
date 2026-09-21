import {fetchJson} from './camera-api.mjs';

// MapLibre is the renderer; geographic tiles and labels come from NDA Maps.
const renderer = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const stylesheet = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
const bridge = 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js';
const attribution = '© <a href="https://ndamaps.vn/">NDA Maps</a> © <a href="https://44plus.vn/">44+ Technologies</a>';

export function basemapStyle(config) {
  if (config?.provider !== 'ndamaps' || config.style !== 'day-v2' || config.styleUrl !== '/api/map/styles/day-v2/style.json') throw new Error('Cấu hình nguồn bản đồ không hợp lệ.');
  if (config.configured !== true) throw new Error('Bản đồ nền chưa được cấu hình. Bạn vẫn có thể mở ảnh camera và lộ trình đã lưu.');
  return config.styleUrl;
}

function loadAsset(url, css = false) {
  return new Promise((resolve, reject) => {
    const node = document.createElement(css ? 'link' : 'script');
    if (css) { node.rel = 'stylesheet'; node.href = url; } else node.src = url;
    const timer = setTimeout(() => finish(false), 12000);
    const finish = ok => {
      clearTimeout(timer); node.onload = node.onerror = null;
      if (ok) resolve();
      else { node.remove(); reject(new Error('Chưa tải được thư viện bản đồ.')); }
    };
    node.onload = () => finish(true); node.onerror = () => finish(false);
    document.head.append(node);
  });
}
let sdk;
function loadSdk() {
  sdk ??= Promise.all([loadAsset(stylesheet, true), loadAsset(renderer)])
    .then(() => loadAsset(bridge)).catch(error => { sdk = null; throw error; });
  return sdk;
}

export class VietnamBasemap {
  constructor(map, onState, {getConfig = () => fetchJson('./api/map-config'), prepare = loadSdk,
    createLayer = style => L.maplibreGL({style}), timeoutMs = 45000} = {}) {
    Object.assign(this, {map, onState, getConfig, prepare, createLayer, timeoutMs});
    this.generation = 0; this.layer = null; this.cleanup = null;
  }
  clear() {
    this.cleanup?.(); this.cleanup = null;
    if (this.layer) this.map.removeLayer(this.layer);
    this.layer = null;
    if (this.hasAttribution) this.map.attributionControl?.removeAttribution(attribution);
    this.hasAttribution = false;
  }
  dispose() { this.generation++; this.clear(); }
  async start() {
    const generation = ++this.generation;
    this.clear(); this.onState({ready: false, loading: true, message: 'Đang tải bản đồ NDA Maps…'});
    try {
      const style = basemapStyle(await this.getConfig());
      if (generation !== this.generation) return;
      await this.prepare();
      if (generation !== this.generation) return;
      this.layer = this.createLayer(style);
      this.layer.addTo(this.map);
      const gl = this.layer.getMaplibreMap();
      const error = () => {
        if (generation !== this.generation) return;
        this.clear();
        this.onState({ready: false, loading: false, message: 'Không tải được bản đồ NDA Maps. Kiểm tra kết nối, hạn mức hoặc cấu hình rồi thử lại.'});
      };
      const timer = setTimeout(error, this.timeoutMs);
      const loaded = () => {
        if (generation !== this.generation) return;
        clearTimeout(timer);
        if (!this.hasAttribution) this.map.attributionControl?.addAttribution(attribution);
        this.hasAttribution = true;
        this.onState({ready: true, loading: false, message: 'Bản đồ nền: NDA Maps.'});
      };
      gl.on('load', loaded); gl.on('error', error);
      this.cleanup = () => { clearTimeout(timer); gl.off('load', loaded); gl.off('error', error); };
      if (gl.loaded()) loaded();
    } catch (error) {
      if (generation !== this.generation) return;
      this.clear();
      const message = error.message?.includes('chưa được cấu hình') ? error.message : 'Chưa tải được bản đồ NDA Maps. Kiểm tra máy chủ và kết nối rồi thử lại.';
      this.onState({ready: false, loading: false, message});
    }
  }
}
