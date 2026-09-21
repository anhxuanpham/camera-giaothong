import {normalizeCameras, normalizeHanoiCameras, normalizeRoutes, validCoordinates, validPlaceRef, normalizeCity} from './camera-core.mjs';

export const CAMERA_API = 'https://api.notis.vn/v4/cameras/bybbox?lat1=11.20&lng1=106.90&lat2=10.30&lng2=106.30';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

export async function fetchJson(url, {signal, timeoutMs = 12000, fetchImpl = globalThis.fetch, errors = {}} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, {once: true});
  const timeout = setTimeout(() => controller.abort(new DOMException('Dịch vụ phản hồi quá chậm. Hãy thử lại.', 'TimeoutError')), timeoutMs);
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([interrupted, (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetchImpl(url, {signal: controller.signal, headers: {Accept: 'application/json'}});
      if (!response.ok) throw new Error(errors[response.status] || `Dịch vụ tạm không khả dụng (HTTP ${response.status}).`);
      try { return await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new Error('Dịch vụ trả về dữ liệu không đọc được.', {cause: error});
      }
    })()]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function loadCatalog(options = {}) {
  const city = normalizeCity(options.city);
  const liveUrl = city === 'hn' ? './api/hanoi/cameras' : CAMERA_API;
  const bundledUrl = city === 'hn' ? './cameras_hanoi.json' : './cameras_full.json';
  const normalize = city === 'hn' ? normalizeHanoiCameras : normalizeCameras;
  try {
    return {...normalize(await fetchJson(liveUrl, options)), source: 'live', loadedAt: Date.now(), city};
  } catch (error) {
    if (options.signal?.aborted) throw error;
    try {
      return {...normalize(await fetchJson(bundledUrl, options)), source: 'bundled', loadedAt: null, city,
        warning: city === 'hn'
          ? 'Đang dùng danh mục Hà Nội lưu sẵn. Ảnh live vẫn lấy từ VMS; vị trí có thể đã đổi.'
          : 'Đang dùng danh mục lưu sẵn, chưa rõ ngày thu thập. Vị trí và camera có thể đã thay đổi.'};
    } catch (fallbackError) {
      if (options.signal?.aborted) throw fallbackError;
      throw new Error('Chưa tải được danh mục camera. Bạn vẫn có thể tìm đường; hãy thử tải camera lại.', {cause: error});
    }
  }
}

export async function searchPlaces(query, options = {}) {
  const value = query.trim();
  if (value.length < 2 || value.length > 200) throw new Error('Nhập địa điểm từ 2 đến 200 ký tự.');
  const places = await fetchJson(`./api/places?${new URLSearchParams({q: value})}`, {timeoutMs: 35000, ...options, errors: placeErrors});
  if (!Array.isArray(places) || places.some(p => !validPlaceRef(p?.ref) ||
    typeof p.label !== 'string' || !p.label.trim() || typeof p.address !== 'string')) throw new Error('Kết quả tìm địa điểm không hợp lệ.');
  return places;
}

const placeErrors = {
  503: 'Dịch vụ tìm địa điểm chưa được cấu hình.',
  502: 'Dịch vụ tìm địa điểm chưa phản hồi hợp lệ. Hãy thử lại.',
  429: 'Đã chạm giới hạn yêu cầu. Chờ một lúc rồi thử lại.'
};
export async function resolvePlace(ref, options = {}) {
  if (!validPlaceRef(ref)) throw new Error('Mã địa điểm không hợp lệ.');
  const place = await fetchJson(`./api/place?${new URLSearchParams({ref})}`, {timeoutMs: 35000, ...options, errors: placeErrors});
  if (!validCoordinates(place?.lon, place?.lat) || typeof place.label !== 'string' || !place.label.trim() || typeof place.address !== 'string') {
    throw new Error('Tọa độ địa điểm không hợp lệ.');
  }
  return place;
}

export async function getRoutes(a, b, options = {}) {
  return normalizeRoutes(await fetchJson(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=3`, options));
}
