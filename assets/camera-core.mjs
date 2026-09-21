export const CAMERA_RADIUS_METERS = 500;
export const FAVORITES_KEY = 'camtraffic_fav_routes';
export const PINS_KEY = 'camtraffic_pinned_cameras';
export const CITY_KEY = 'camtraffic_city';
export const CITIES = {
  hcm: {id: 'hcm', label: 'TP.HCM', center: [10.78, 106.70], zoom: 12,
    fromPlaceholder: 'Chợ Bến Thành', toPlaceholder: 'Nhà thờ Đức Bà Sài Gòn'},
  hn: {id: 'hn', label: 'Hà Nội', center: [21.0285, 105.8542], zoom: 12,
    fromPlaceholder: 'Hồ Hoàn Kiếm', toPlaceholder: 'Ga Hà Nội'}
};
export const normalizeCity = value => value === 'hn' ? 'hn' : 'hcm';

const text = value => typeof value === 'string' ? value.trim().slice(0, 1000) : '';
export const normalizeText = value => text(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
export const validCoordinates = (lon, lat) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
export const validPlaceRef = value => typeof value === 'string' && /^[\w-]{1,2000}$/.test(value);

export function safeSnapshotUrl(path, id) {
  if (typeof path !== 'string' || !/^[\w-]+$/.test(id)) return null;
  try {
    const url = new URL(path, 'https://api.notis.vn/v4/');
    return url.origin === 'https://api.notis.vn' && !url.username && !url.password &&
      url.pathname === `/v4/cameras/${id}/snapshot` && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function safeHanoiSnapshotUrl(cameraId) {
  return /^[\w-]{1,64}$/.test(cameraId) ? `./api/hanoi/snapshot/${cameraId}` : null;
}

export function safeHanoiLiveUrl(cameraId) {
  return /^[\w-]{1,64}$/.test(cameraId) ? `./api/hanoi/live/${cameraId}` : null;
}

export function hanoiCameraId(camera) {
  return camera?.city === 'hn' && typeof camera.id === 'string' && camera.id.startsWith('hn-') ? camera.id.slice(3) : '';
}

export function normalizeCameras(data) {
  if (!Array.isArray(data)) throw new Error('Danh mục camera không đúng định dạng.');
  const unique = new Map();
  let rejected = 0;
  for (const raw of data) {
    const id = text(raw?._id);
    const [lon, lat] = Array.isArray(raw?.loc?.coordinates) ? raw.loc.coordinates : [];
    if (!/^[\w-]+$/.test(id) || !validCoordinates(lon, lat) || unique.has(id)) { rejected++; continue; }
    unique.set(id, {id, city: 'hcm', name: text(raw.name) || 'Camera chưa có tên', district: text(raw.dist),
      lon, lat, ptz: raw.ptz === true, snapshotUrl: safeSnapshotUrl(raw.liveviewUrl, id)});
  }
  if (data.length && !unique.size) throw new Error('Danh mục không có tọa độ camera hợp lệ.');
  return {cameras: [...unique.values()], rejected};
}

export function normalizeHanoiCameras(data) {
  if (!Array.isArray(data)) throw new Error('Danh mục camera Hà Nội không đúng định dạng.');
  const unique = new Map();
  let rejected = 0;
  for (const raw of data) {
    const cameraId = text(raw?.camera_id);
    const lon = raw?.lng, lat = raw?.lat;
    const id = `hn-${cameraId}`;
    if (!/^[\w-]{1,64}$/.test(cameraId) || typeof lon !== 'number' || typeof lat !== 'number' ||
      !validCoordinates(lon, lat) || unique.has(id)) { rejected++; continue; }
    unique.set(id, {id, city: 'hn', name: text(raw.name) || 'Camera chưa có tên',
      district: text(raw.ward_name), lon, lat, ptz: raw.ptz === true || /\bPTZ\b/i.test(raw?.name || ''),
      snapshotUrl: safeHanoiSnapshotUrl(cameraId)});
  }
  if (data.length && !unique.size) throw new Error('Danh mục không có tọa độ camera hợp lệ.');
  return {cameras: [...unique.values()], rejected};
}

export function normalizePlaceSuggestions(data) {
  if (data?.type !== 'FeatureCollection' || data.errors != null || !Array.isArray(data.features)) throw new Error('Kết quả tìm địa điểm không đúng định dạng.');
  const seen = new Set();
  const result = data.features.flatMap(feature => {
    const place = feature?.properties;
    const ref = place?.id;
    const label = text(place?.name) || text(place?.label);
    if (feature?.type !== 'Feature' || !validPlaceRef(ref) || !label || seen.has(ref)) return [];
    seen.add(ref);
    return [{ref, label, address: text(place.label) || text(place.short_address)}];
  });
  if (data.features.length && !result.length) throw new Error('Không có địa điểm hợp lệ trong phản hồi.');
  return result.slice(0, 10);
}

export function normalizePlaceDetail(data) {
  if (data?.type !== 'FeatureCollection' || data.errors != null || !Array.isArray(data.features) || data.features.length !== 1) throw new Error('Tọa độ địa điểm không hợp lệ.');
  const feature = data.features[0], place = feature?.properties;
  const [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const label = text(place?.name) || text(place?.label);
  if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point' || !label || !validCoordinates(lon, lat)) throw new Error('Tọa độ địa điểm không hợp lệ.');
  return {lon, lat, label, address: text(place.label) || text(place.short_address)};
}

export function normalizeRoutes(data) {
  if (data?.code !== 'Ok' || !Array.isArray(data.routes)) throw new Error('Không tìm được tuyến ô tô giữa hai điểm này.');
  const routes = data.routes.flatMap((route, index) => {
    const coords = route?.geometry?.coordinates;
    if (!Number.isFinite(route?.distance) || route.distance < 0 || !Number.isFinite(route?.duration) || route.duration < 0 ||
      !Array.isArray(coords) || coords.length < 2 || coords.some(c => !Array.isArray(c) || !validCoordinates(c[0], c[1]))) return [];
    return [{id: index, distance: route.distance, duration: route.duration, coords: coords.map(c => [c[0], c[1]])}];
  });
  if (!routes.length) throw new Error('Dịch vụ trả về tuyến không hợp lệ.');
  return routes;
}

// A local metric projection is accurate enough for the 500m city camera corridor.
// Check every segment so ordering uses the closest point, not the first nearby one.
export function camerasAlongRoute(cameras, coords, radius = CAMERA_RADIUS_METERS) {
  if (coords.length < 2) return [];
  const lat0 = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  const yScale = Math.PI * 6371000 / 180;
  const xScale = yScale * Math.cos(lat0 * Math.PI / 180);
  const project = ([lon, lat]) => [lon * xScale, lat * yScale];
  const points = coords.map(project);
  let total = 0;
  const segments = points.slice(1).map((b, i) => {
    const a = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy), start = total;
    total += length;
    return {a, dx, dy, length, start};
  });
  return cameras.flatMap(camera => {
    const [x, y] = project([camera.lon, camera.lat]);
    let distance = Infinity, progress = 0;
    for (const s of segments) {
      const t = s.length ? Math.max(0, Math.min(1, ((x - s.a[0]) * s.dx + (y - s.a[1]) * s.dy) / (s.length ** 2))) : 0;
      const d = Math.hypot(x - s.a[0] - t * s.dx, y - s.a[1] - t * s.dy);
      if (d < distance) { distance = d; progress = s.start + t * s.length; }
    }
    return distance <= radius ? [{camera, distance, progress}] : [];
  }).sort((a, b) => a.progress - b.progress || a.distance - b.distance || a.camera.id.localeCompare(b.camera.id));
}

export function filterCameraRows(cameras, {mode = 'all', district = '', query = '', pins = [], along = []} = {}) {
  const needle = normalizeText(query);
  const matches = camera => normalizeText(`${camera.name} ${camera.district}`).includes(needle);
  if (mode === 'route') return along.filter(row => matches(row.camera));
  return cameras.filter(c => (mode === 'pinned' ? pins.includes(c.id) : !district || c.district === district) && matches(c))
    .sort((a, b) => a.district.localeCompare(b.district, 'vi') || a.name.localeCompare(b.name, 'vi'))
    .map(camera => ({camera}));
}

function normalizePlace(place) {
  return place && validCoordinates(place.lon, place.lat) && text(place.label) ?
    {lon: place.lon, lat: place.lat, label: text(place.label), address: text(place.address)} : null;
}

export function normalizeFavorites(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(f => {
    if (!text(f?.from) || !text(f?.to)) return [];
    return [{from: text(f.from), to: text(f.to), aLabel: text(f.aLabel) || text(f.from), bLabel: text(f.bLabel) || text(f.to),
      a: normalizePlace(f.a), b: normalizePlace(f.b)}];
  });
}

export function favoriteKey(f) {
  return f.a && f.b ? `${f.a.lon},${f.a.lat};${f.b.lon},${f.b.lat}` : `${normalizeText(f.from)};${normalizeText(f.to)}`;
}

export const normalizePins = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && /^[\w-]+$/.test(id)))] : [];

export function readStored(storage, key, normalize) {
  try {
    const raw = storage.getItem(key);
    return {value: normalize(raw === null ? [] : JSON.parse(raw)), error: null};
  } catch { return {value: [], error: 'Không đọc được dữ liệu đã lưu trên thiết bị này.'}; }
}

export function writeStored(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return null; }
  catch { return 'Không lưu được trên thiết bị. Kiểm tra dung lượng hoặc quyền lưu trữ của trình duyệt.'; }
}

export class LatestRequest {
  sequence = 0;
  controller = null;
  cancel() { this.sequence++; this.controller?.abort(); this.controller = null; }
  begin() {
    this.cancel();
    this.controller = new AbortController();
    const sequence = this.sequence;
    return {signal: this.controller.signal, current: () => sequence === this.sequence};
  }
}
