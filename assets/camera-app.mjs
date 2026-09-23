import {CAMERA_RADIUS_METERS, CITY_NEAR_KM, FAVORITES_KEY, PINS_KEY, CITY_KEY, CITIES, normalizeCity, normalizeText, nearestCity, geolocationMessage, validCoordinates, normalizeFavorites, normalizePins, favoriteKey,
  readStored, writeStored, camerasAlongRoute, filterCameraRows, LatestRequest, safeHanoiLiveUrl, hanoiCameraId} from './camera-core.mjs';
import {loadCatalog, searchPlaces, resolvePlace, getRoutes} from './camera-api.mjs';
import {SnapshotLoader, SnapshotRefresh} from './snapshot-loader.mjs';
import {VietnamBasemap} from './vietnam-basemap.mjs';
import {attachHanoiLive} from './hanoi-live.mjs';

const $ = id => document.getElementById(id);
const element = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const button = (text, action, className = '') => {
  const node = element('button', className, text);
  node.type = 'button'; node.addEventListener('click', action);
  return node;
};
const time = value => new Date(value).toLocaleTimeString('vi-VN');
const km = meters => (meters / 1000).toLocaleString('vi-VN', {maximumFractionDigits: 1, minimumFractionDigits: 1});
const smallScreen = matchMedia('(max-width: 760px), (max-height: 560px)');
const storage = {getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value)};
const storedFavs = readStored(storage, FAVORITES_KEY, normalizeFavorites);
const storedPins = readStored(storage, PINS_KEY, normalizePins);
const storedCity = (() => { try { return normalizeCity(JSON.parse(storage.getItem(CITY_KEY))); } catch { return 'hcm'; } })();
const state = {city: storedCity, cameras: [], catalog: null, catalogLoading: true, catalogError: '', routes: [], selectedRoute: 0,
  places: {from: null, to: null}, endpoints: null, favorites: storedFavs.value, pins: storedPins.value, listLimit: 40};
const routeRequest = new LatestRequest(), catalogRequest = new LatestRequest();
const placeRequests = {from: new LatestRequest(), to: new LatestRequest()};
const refresh = new SnapshotRefresh();
refresh.setVisible(!document.hidden);
const popupViews = new WeakMap();
let map, routeLayers, endpointLayers, alongLayers, cameraLayer, temporaryMarker, dialogView, dialogCamera, noticeTimer, picking, liveSession, hereMarker, locating;
let currentPopup = null, basemap, basemapReady = false;

function routeStatus(message, error = false) {
  $('routeStatus').textContent = message;
  $('routeStatus').classList.toggle('error', error);
}
function notice(message) {
  clearTimeout(noticeTimer);
  $('mapNotice').textContent = message;
  $('mapNotice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => { $('mapNotice').hidden = true; }, 8000);
}
function storageError(message) {
  $('storageStatus').textContent = message || '';
  document.querySelectorAll('.storage-message').forEach(n => { n.textContent = message || ''; });
  if (message) notice(message);
}
function setPanel(id, open, focus = false) {
  if (open) map?.closePopup();
  if (open && smallScreen.matches) {
    const other = id === 'panel' ? 'sidebar' : 'panel';
    $(other).hidden = true;
    $(other === 'panel' ? 'panelToggle' : 'listToggle').setAttribute('aria-expanded', 'false');
  }
  $(id).hidden = !open;
  document.body.classList.toggle('camera-panel-open', !$('sidebar').hidden);
  $(id === 'panel' ? 'panelToggle' : 'listToggle').setAttribute('aria-expanded', String(open));
  if (open && id === 'sidebar') renderSidebar();
  if (focus) $(open ? (id === 'panel' ? 'from' : 'cameraSearch') : (id === 'panel' ? 'panelToggle' : 'listToggle')).focus();
}
function collapsePanels() { setPanel('panel', false); setPanel('sidebar', false); }

function initMap() {
  if (!globalThis.L) { notice('Chưa tải được thư viện bản đồ. Kiểm tra mạng rồi tải lại trang.'); return; }
  map = L.map('map', {zoomControl: false, minZoom: 1, maxZoom: 19,
    maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1}).setView(CITIES[state.city].center, CITIES[state.city].zoom);
  L.control.zoom({position: 'topright'}).addTo(map);
  map.addControl(new (L.Control.extend({
    options: {position: 'topright'},
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control locate-bar');
      const btn = L.DomUtil.create('button', 'locate-control', bar);
      btn.type = 'button'; btn.id = 'locateMe'; btn.textContent = 'Vị trí';
      btn.setAttribute('aria-label', 'Hiện vị trí của tôi trên bản đồ');
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(btn, 'click', event => { L.DomEvent.stop(event); void showHere(Boolean(picking)); });
      return bar;
    }
  }))());
  basemap = new VietnamBasemap(map, status => {
    basemapReady = status.ready;
    $('basemapStatus').textContent = status.message;
    $('basemapStatus').classList.toggle('error', !status.ready && !status.loading);
    $('retryBasemap').hidden = status.ready;
    $('retryBasemap').disabled = status.loading;
    $('fromMap').disabled = $('toMap').disabled = !status.ready;
    if (!status.ready && picking) cancelMapPick();
  });
  void basemap.start();
  routeLayers = L.layerGroup().addTo(map);
  endpointLayers = L.layerGroup().addTo(map);
  alongLayers = L.layerGroup().addTo(map);
  cameraLayer = (L.markerClusterGroup ? L.markerClusterGroup({maxClusterRadius: 50, disableClusteringAtZoom: 16, showCoverageOnHover: false}) : L.layerGroup()).addTo(map);
  map.on('popupopen', event => {
    currentPopup = event.popup;
    collapsePanels();
    const view = popupViews.get(event.popup);
    if (view) refresh.add(view.loader);
  });
  map.on('popupclose', event => {
    const view = popupViews.get(event.popup);
    if (view) refresh.remove(view.loader);
    if (currentPopup === event.popup) currentPopup = null;
    if (!$('imageDialog').open && document.activeElement?.closest('.leaflet-popup')) $('map').focus();
  });
  map.on('click', event => { if (picking) completeMapPick(event.latlng); });
  map.on('resize', () => { if (currentPopup?.isOpen()) currentPopup.update(); });
}

function makePinButton(camera) {
  const node = button('', () => togglePin(camera.id), 'pin-button');
  node.dataset.pin = camera.id; node.dataset.cameraName = camera.name;
  updatePinButton(node);
  return node;
}
function updatePinButton(node) {
  const pinned = state.pins.includes(node.dataset.pin);
  node.textContent = pinned ? 'Bỏ ghim' : 'Ghim';
  node.setAttribute('aria-pressed', String(pinned));
  node.setAttribute('aria-label', `${pinned ? 'Bỏ ghim' : 'Ghim'} ${node.dataset.cameraName}`);
}
function togglePin(id) {
  const next = state.pins.includes(id) ? state.pins.filter(x => x !== id) : [...state.pins, id];
  const error = writeStored(storage, PINS_KEY, next);
  storageError(error);
  if (error) return;
  const focusedPin = document.activeElement?.dataset.pin;
  state.pins = next;
  renderSidebar(); renderCameraLayer();
  document.querySelectorAll('[data-pin]').forEach(updatePinButton);
  if (focusedPin && !$('imageDialog').open && !document.activeElement?.dataset.pin) {
    const replacement = [...document.querySelectorAll('#sbList [data-pin]')].find(n => n.dataset.pin === focusedPin);
    (replacement || $('cameraSearch')).focus();
  }
}

function cameraView(camera, large = false) {
  const root = element('article', 'camera-view');
  const title = element('h3', '', camera.name);
  const district = element('p', 'muted', camera.district || 'Chưa rõ khu vực');
  const frame = element('div', 'snapshot-frame');
  let image = element('img'); image.alt = `Ảnh giao thông: ${camera.name}`; image.hidden = true;
  const placeholder = element('p', 'empty', camera.snapshotUrl
    ? 'Đang tải ảnh camera…'
    : 'Camera này chưa có đường dẫn ảnh hợp lệ.');
  frame.append(image, placeholder);
  const status = element('p', 'status'); status.setAttribute('role', 'status');
  const note = element('p', 'muted capture-note', 'Chưa xác định giờ chụp từ nguồn. Ảnh có thể trễ.');
  const storageMessage = element('p', 'status error storage-message'); storageMessage.setAttribute('role', 'status');
  let displayedSrc;
  const onSnapshotState = next => {
    if (next.src && next.src !== displayedSrc) {
      // Insert the successfully loaded image itself; assigning its URL to a
      // second element could trigger an unverified second download.
      next.image.alt = `Ảnh giao thông: ${camera.name}`;
      if (!large) {
        next.image.style.cursor = 'zoom-in';
        next.image.addEventListener('click', () => openImage(camera));
      }
      image.replaceWith(next.image); image = next.image; displayedSrc = next.src;
    }
    image.hidden = !next.src; placeholder.hidden = Boolean(next.src);
    root.setAttribute('aria-busy', String(next.status === 'loading'));
    refreshButton.disabled = next.status === 'loading';
    refreshButton.textContent = next.status === 'loading' ? 'Đang tải…' : 'Làm mới ảnh';
    status.classList.toggle('error', next.status === 'error');
    const last = next.loadedAt ? `Tải thành công lúc ${time(next.loadedAt)}.` : '';
    status.textContent = next.status === 'loading' ? `${last} Đang tải ảnh mới…` :
      next.status === 'error' ? `${next.error} ${next.src ? `Đang giữ ảnh cũ. ${last}` : ''}` : last;
    placeholder.textContent = next.status === 'error' ? 'Chưa có ảnh để hiển thị.' : 'Đang tải ảnh camera…';
    if (currentPopup?.isOpen() && popupViews.get(currentPopup)?.root === root) currentPopup.update();
  };
  const loader = camera.snapshotUrl
    ? new SnapshotLoader({url: camera.snapshotUrl, onState: onSnapshotState})
    : {start() {}, stop() {}, refresh() {}};
  if (!camera.snapshotUrl) {
    status.textContent = 'Camera này chưa có đường dẫn ảnh hợp lệ.';
  } else if (camera.city === 'hn') {
    note.textContent = 'Ảnh Hà Nội là một khung giải mã từ luồng VMS. Không phải JPEG Notis như HCM.';
  }
  const actions = element('div', 'camera-actions');
  const refreshButton = button('Làm mới ảnh', () => loader.refresh());
  refreshButton.disabled = !camera.snapshotUrl;
  actions.append(refreshButton, makePinButton(camera));
  if (safeHanoiLiveUrl(hanoiCameraId(camera))) {
    actions.append(button('Xem live', () => openLive(camera)));
  }
  if (!large) {
    actions.append(button('Xem ảnh lớn', () => openImage(camera)));
    image.style.cursor = 'zoom-in';
    image.addEventListener('click', () => openImage(camera));
  }
  root.append(title, district, frame, status, note, actions, storageMessage);
  return {root, loader};
}
function markerFor(camera, position) {
  const along = position !== undefined;
  const marker = L.marker([camera.lat, camera.lon], {
    title: camera.name, alt: camera.name,
    icon: L.divIcon({className: `camera-marker${along ? ' along' : ''}`, html: along ? String(position + 1) : '●', iconSize: [30, 30], iconAnchor: [15, 15]}),
    zIndexOffset: along ? 500 : 0
  });
  let view;
  marker.bindPopup(() => {
    view ??= cameraView(camera);
    popupViews.set(marker.getPopup(), view);
    return view.root;
  }, {maxWidth: 320, minWidth: 250, autoPanPadding: [24, 24]});
  marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `${along ? `${position + 1}. ` : ''}Camera ${camera.name}`));
  return marker;
}
function openCamera(camera) {
  if (!map || !basemapReady) { openImage(camera); return; }
  collapsePanels();
  if (temporaryMarker) map.removeLayer(temporaryMarker);
  map.setView([camera.lat, camera.lon], 16, {animate: false});
  const marker = markerFor(camera);
  temporaryMarker = marker;
  marker.on('popupclose', () => {
    map.removeLayer(marker);
    if (temporaryMarker === marker) temporaryMarker = null;
  });
  marker.addTo(map).openPopup();
  const view = popupViews.get(marker.getPopup());
  view?.root.querySelector('button')?.focus({preventScroll: true});
}
function openImage(camera) {
  if (dialogView) refresh.remove(dialogView.loader);
  dialogCamera = camera;
  dialogView = cameraView(camera, true);
  $('imageTitle').textContent = camera.name;
  $('imageContent').replaceChildren(dialogView.root);
  $('imageDialog').showModal();
  map?.closePopup();
  refresh.add(dialogView.loader);
  $('imageClose').focus();
}
$('imageClose').addEventListener('click', () => $('imageDialog').close());
$('imageDialog').addEventListener('close', () => {
  if (dialogView) refresh.remove(dialogView.loader);
  dialogView = null;
  const camera = dialogCamera; dialogCamera = null;
  if ($('liveDialog').open || $('wallDialog').open) return;
  if (camera && map && basemapReady) openCamera(camera);
  else $('listToggle').focus();
});
function stopLive() {
  liveSession?.stop();
  liveSession = null;
}
function openLive(camera) {
  const url = safeHanoiLiveUrl(hanoiCameraId(camera));
  if (!url) return;
  stopLive();
  map?.closePopup();
  const frame = element('div', 'live-frame');
  const video = document.createElement('video');
  video.controls = true; video.autoplay = true; video.muted = true; video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-label', `Live ${camera.name}`);
  frame.append(video);
  const status = element('p', 'status', 'Đang kết nối luồng VMS…');
  status.setAttribute('role', 'status');
  $('liveTitle').textContent = `Live · ${camera.name}`;
  $('liveContent').replaceChildren(frame, status);
  $('liveDialog').showModal();
  if ($('imageDialog').open) $('imageDialog').close();
  const abort = new AbortController();
  const player = attachHanoiLive(video, url, {signal: abort.signal, onStatus: text => { status.textContent = text; }});
  liveSession = {stop() { abort.abort(); player.stop(); }};
  $('liveClose').focus();
}
$('liveClose').addEventListener('click', () => $('liveDialog').close());
$('liveDialog').addEventListener('close', () => {
  stopLive();
  $('listToggle').focus();
});

function stopWall() {}
function renderWall() {
  const query = normalizeText($('wallSearch').value);
  const cameras = state.cameras.filter(camera => !query || normalizeText(`${camera.name} ${camera.district || ''}`).includes(query));
  $('wallCount').textContent = `${cameras.length} camera`;
  const grid = $('wallGrid');
  const fragment = document.createDocumentFragment();
  for (const camera of cameras) {
    const tile = element('div', 'wall-tile');
    tile.dataset.id = camera.id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.addEventListener('click', () => openImage(camera));
    tile.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openImage(camera);
    });
    const body = element('span', 'wall-body');
    if (camera.snapshotUrl) {
      const image = element('img', 'wall-shot');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = camera.snapshotUrl;
      body.append(image);
    } else body.append(element('p', 'empty', 'Không có ảnh'));
    body.append(element('span', 'wall-caption', camera.name), element('small', 'wall-district', camera.district || 'Chưa rõ khu vực'));
    tile.append(body);
    fragment.append(tile);
  }
  if (!cameras.length) fragment.append(element('p', 'empty', state.catalogLoading ? 'Đang tải danh mục…' : 'Không có camera.'));
  grid.replaceChildren(fragment);
}
function openWall() {
  $('wallDialog').showModal();
  $('wallToggle').setAttribute('aria-expanded', 'true');
  renderWall();
  $('wallClose').focus();
}
function closeWall() {
  if ($('wallDialog').open) $('wallDialog').close();
}
$('wallToggle').addEventListener('click', () => { cancelMapPick(); openWall(); });
$('wallClose').addEventListener('click', () => closeWall());
$('wallDialog').addEventListener('close', () => {
  stopWall();
  $('wallToggle').setAttribute('aria-expanded', 'false');
  $('wallToggle').focus();
});
$('wallSearch').addEventListener('input', renderWall);

function selectedRoute() { return state.routes[state.selectedRoute]; }
function visibleRows() {
  return filterCameraRows(state.cameras, {mode: $('cameraMode').value, district: $('distFilter').value,
    query: $('cameraSearch').value, pins: state.pins, along: selectedRoute()?.along || []});
}
function renderSidebar() {
  const mode = $('cameraMode').value, rows = visibleRows();
  $('districtField').hidden = mode !== 'all';
  $('listCount').textContent = `${rows.length} camera${mode === 'route' ? ' gần tuyến, theo thứ tự từ A đến B' : ''}`;
  const fragment = document.createDocumentFragment();
  for (const [index, row] of rows.slice(0, state.listLimit).entries()) {
    const camera = row.camera;
    const item = element('div', 'camera-row');
    const open = button('', () => openCamera(camera), 'camera-open');
    open.append(element('span', '', `${mode === 'route' ? `${index + 1}. ` : ''}${camera.name}`));
    open.append(element('small', '', mode === 'route' ? `${km(row.progress)} km từ A · cách tuyến ${Math.round(row.distance)} m` : camera.district || 'Chưa rõ khu vực'));
    item.append(open, makePinButton(camera)); fragment.append(item);
  }
  if (!rows.length) {
    const message = mode === 'route' && !selectedRoute() ? 'Tìm đường và chọn một tuyến để xem camera theo thứ tự A đến B.' :
      state.catalogLoading && !state.cameras.length ? 'Đang tải danh mục…' :
      !state.catalog && state.catalogError ? state.catalogError :
      mode === 'pinned' ? 'Chưa có camera phù hợp. Dùng nút Ghim ở danh sách hoặc ảnh camera.' : 'Không có camera phù hợp. Thử đổi khu vực hoặc từ khóa.';
    fragment.append(element('p', 'empty', message));
  }
  if (mode === 'pinned' && !$('cameraSearch').value) {
    const known = new Set(state.cameras.map(c => c.id));
    for (const id of state.pins.filter(id => !known.has(id))) {
      const item = element('div', 'camera-row');
      item.append(element('p', 'muted', 'Camera đã ghim hiện chưa có trong danh mục.'), makePinButton({id, name: `camera ${id}`}));
      fragment.append(item);
    }
  }
  $('sbList').replaceChildren(fragment);
  $('moreCameras').hidden = rows.length <= state.listLimit;
}
function renderCameraLayer() {
  if (!cameraLayer) return;
  cameraLayer.clearLayers();
  if (!$('showCameras').checked) return;
  const alongIds = new Set(selectedRoute()?.along.map(row => row.camera.id));
  const markers = visibleRows().filter(row => !alongIds.has(row.camera.id)).map(row => markerFor(row.camera));
  if (cameraLayer.addLayers) cameraLayer.addLayers(markers);
  else markers.forEach(marker => cameraLayer.addLayer(marker));
}
function renderAlongMarkers() {
  if (!alongLayers) return;
  alongLayers.clearLayers();
  selectedRoute()?.along.forEach((row, index) => alongLayers.addLayer(markerFor(row.camera, index)));
}
function renderDistricts() {
  const previous = $('distFilter').value;
  const options = [new Option('Tất cả quận / khu vực', '')];
  [...new Set(state.cameras.map(c => c.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'))
    .forEach(d => options.push(new Option(d, d)));
  $('distFilter').replaceChildren(...options);
  $('distFilter').value = options.some(o => o.value === previous) ? previous : '';
}
function catalogText() {
  if (!state.catalog) return state.catalogError || 'Đang tải danh mục camera…';
  const {source, loadedAt, warning, rejected} = state.catalog;
  const origin = source === 'live' ? `Danh mục tải lúc ${time(loadedAt)}.` :
    source === 'memory' ? `Chưa làm mới được. Giữ danh mục tải lúc ${time(loadedAt)}.` : warning;
  const hnNote = state.city === 'hn' ? ' Ảnh Hà Nội là một khung VMS; nút Xem live phát luồng liên tục (H.264).' : '';
  return `${state.cameras.length} camera. ${origin} Chưa xác nhận tình trạng từng camera.${hnNote}${rejected ? ` Bỏ qua ${rejected} bản ghi không hợp lệ/trùng.` : ''}`;
}
async function reloadCameras() {
  const ticket = catalogRequest.begin();
  state.catalogLoading = true; $('retryCameras').disabled = true;
  $('catalogStatus').textContent = 'Đang tải danh mục camera…';
  try {
    let catalog = await loadCatalog({signal: ticket.signal, city: state.city});
    if (!ticket.current()) return;
    if (catalog.source === 'bundled' && state.catalog?.loadedAt) catalog = {...state.catalog, source: 'memory'};
    state.catalog = catalog; state.cameras = catalog.cameras; state.catalogError = '';
    renderDistricts();
    state.routes.forEach(route => { route.along = camerasAlongRoute(state.cameras, route.coords); });
    renderRouteInfo(); renderAlongMarkers(); renderCameraLayer();
  } catch (error) {
    if (!ticket.current()) return;
    state.catalogError = error.message;
    if (state.catalog?.loadedAt) state.catalog = {...state.catalog, source: 'memory'};
  } finally {
    if (ticket.current()) {
      state.catalogLoading = false; $('retryCameras').disabled = false;
      $('catalogStatus').textContent = catalogText();
      $('catalogStatus').classList.toggle('error', Boolean(state.catalogError) || state.catalog?.source !== 'live');
      renderSidebar();
      if ($('wallDialog').open) renderWall();
    }
  }
}

function setRouteBusy(busy) {
  $('routeBtn').disabled = busy;
  $('routeBtn').textContent = busy ? 'Đang tìm tuyến…' : 'Tìm tuyến ô tô';
}
function invalidateRoute() {
  routeRequest.cancel(); setRouteBusy(false);
  state.routes = []; state.endpoints = null; state.selectedRoute = 0;
  routeLayers?.clearLayers(); alongLayers?.clearLayers();
  $('routeInfo').hidden = true;
  routeStatus('');
  renderCameraLayer(); renderSidebar();
}
function renderEndpoints() {
  if (!map) return;
  endpointLayers.clearLayers();
  for (const [field, letter] of [['from', 'A'], ['to', 'B']]) {
    const place = state.places[field];
    if (place) {
      const marker = L.marker([place.lat, place.lon], {title: `${letter}: ${place.label}`, alt: `${letter}: ${place.label}`,
        icon: L.divIcon({className: 'endpoint-marker', html: letter, iconSize: [32, 32], iconAnchor: [16, 16]})});
      marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `${letter}: ${place.label}`));
      marker.addTo(endpointLayers);
    }
  }
}
function choosePlace(field, place) {
  placeRequests[field].cancel();
  $(field + 'Search').disabled = false;
  state.places[field] = place;
  $(field).value = place.label;
  $(field + 'Hint').textContent = `Đã chọn: ${place.address || `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`}`;
  $(field + 'Results').hidden = true;
  $(field).removeAttribute('aria-invalid');
  invalidateRoute(); renderEndpoints();
}
async function lookupPlace(field) {
  const query = $(field).value.trim();
  if (!query) { $(field + 'Hint').textContent = 'Nhập địa điểm cần tìm.'; $(field).setAttribute('aria-invalid', 'true'); return; }
  const ticket = placeRequests[field].begin();
  $(field + 'Search').disabled = true;
  $(field + 'Hint').textContent = 'Đang tìm địa điểm…';
  $(field + 'Results').hidden = true;
  try {
    const places = await searchPlaces(query, {signal: ticket.signal});
    if (!ticket.current()) return;
    const list = $(field + 'Results'); list.replaceChildren();
    for (const place of places) {
      const item = element('li');
      const select = button('', () => { void selectPlaceSuggestion(field, place); });
      select.append(element('span', '', place.label), element('span', 'place-address', place.address));
      item.append(select); list.append(item);
    }
    list.hidden = !places.length;
    $(field + 'Hint').textContent = places.length ? `Chọn đúng địa điểm trong ${places.length} kết quả NDA Maps. Kiểm tra địa chỉ, tránh tên trùng.` : 'Chưa tìm thấy địa điểm. Thử tên cụ thể hơn.';
  } catch (error) {
    if (ticket.current()) $(field + 'Hint').textContent = `${error.message}${basemapReady ? ' Có thể chọn trên bản đồ.' : ''}`;
  } finally { if (ticket.current()) $(field + 'Search').disabled = false; }
}
async function selectPlaceSuggestion(field, suggestion) {
  const ticket = placeRequests[field].begin();
  state.places[field] = null; invalidateRoute(); renderEndpoints();
  $(field + 'Search').disabled = true;
  $(field + 'Hint').textContent = 'Đang xác định tọa độ địa điểm…';
  const buttons = [...$(field + 'Results').querySelectorAll('button')];
  buttons.forEach(node => { node.disabled = true; });
  try {
    const place = await resolvePlace(suggestion.ref, {signal: ticket.signal});
    if (!ticket.current()) return;
    choosePlace(field, {...place, label: suggestion.label});
    $(field).focus();
  } catch (error) {
    if (ticket.current()) $(field + 'Hint').textContent = error.message;
  } finally {
    buttons.forEach(node => { node.disabled = false; });
    if (ticket.current()) $(field + 'Search').disabled = false;
  }
}
function cancelMapPick() {
  picking = null; $('mapPick').hidden = true; $('map').classList.remove('picking');
}
function beginMapPick(field) {
  if (!map || !basemapReady) { routeStatus('Bản đồ chưa tải được. Hãy tìm địa điểm bằng tên.', true); return; }
  placeRequests[field].cancel(); $(field + 'Search').disabled = false;
  picking = field; collapsePanels(); map.closePopup();
  $('mapNotice').hidden = true;
  $('mapPickHint').textContent = `Chọn ${field === 'from' ? 'điểm đi A' : 'điểm đến B'}: chạm bản đồ hoặc di chuyển bằng phím mũi tên rồi chọn tâm bản đồ.`;
  $('mapPick').hidden = false; $('map').classList.add('picking'); $('map').focus();
}
function herePlace(lat, lon) {
  return {lat, lon, label: 'Vị trí hiện tại', address: 'Từ GPS thiết bị'};
}
function placeHereMarker(lat, lon) {
  if (!map) return;
  hereMarker?.remove();
  hereMarker = L.marker([lat, lon], {
    title: 'Vị trí của bạn', alt: 'Vị trí của bạn', zIndexOffset: 800,
    icon: L.divIcon({className: 'here-marker', iconSize: [16, 16], iconAnchor: [8, 8]})
  });
  const body = element('div', 'here-popup');
  body.append(element('p', '', 'Vị trí của bạn'));
  body.append(button('Làm điểm đi A', () => {
    choosePlace('from', herePlace(lat, lon));
    map.closePopup(); setPanel('panel', true); $('from').focus();
  }));
  hereMarker.bindPopup(body).addTo(map);
}
function showHere(asPick = false) {
  if (!map) return;
  if (!navigator.geolocation) { notice('Trình duyệt không hỗ trợ vị trí.'); return; }
  if (locating) return;
  locating = true;
  const btn = $('locateMe');
  if (btn) btn.disabled = true;
  notice('Đang lấy vị trí…');
  navigator.geolocation.getCurrentPosition(position => {
    locating = false;
    if (btn) btn.disabled = false;
    const lat = position.coords.latitude, lon = position.coords.longitude;
    if (!validCoordinates(lon, lat)) { notice('Tọa độ GPS không hợp lệ.'); return; }
    if (asPick && picking) {
      placeHereMarker(lat, lon);
      completeMapPick({lat, lng: lon});
      return;
    }
    const near = nearestCity(lat, lon);
    if (near && near.id !== state.city && near.km <= CITY_NEAR_KM) setCity(near.id, {fit: false});
    placeHereMarker(lat, lon);
    map.setView([lat, lon], 16, {animate: false});
    $('mapNotice').hidden = true;
  }, error => {
    locating = false;
    if (btn) btn.disabled = false;
    notice(geolocationMessage(error));
  }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 15000});
}
function completeMapPick(latlng) {
  const field = picking;
  if (!field) return;
  choosePlace(field, {lat: latlng.lat, lon: latlng.lng, label: `Điểm ${field === 'from' ? 'A' : 'B'} (${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)})`, address: 'Đã chọn trên bản đồ'});
  cancelMapPick(); setPanel('panel', true); $(field).focus();
}
function fitSelectedRoute() {
  const route = selectedRoute();
  if (!route || !map) return;
  const left = !$('panel').hidden && !smallScreen.matches ? 396 : 24;
  const right = !$('sidebar').hidden && !smallScreen.matches ? 396 : 24;
  map.fitBounds(L.latLngBounds(route.coords.map(([lon, lat]) => [lat, lon])), {paddingTopLeft: [left, 32], paddingBottomRight: [right, 48], maxZoom: 16, animate: false});
}
function renderRouteInfo() {
  const route = selectedRoute();
  $('routeInfo').hidden = !route;
  if (!route) return;
  $('routeEndpoints').textContent = `${state.endpoints.a.label} → ${state.endpoints.b.label}`;
  $('routeOptions').replaceChildren(...state.routes.map((candidate, index) => {
    const option = button('', () => selectRoute(index), 'route-option');
    option.setAttribute('aria-pressed', String(index === state.selectedRoute));
    option.append(element('span', '', `Tuyến ${index + 1}${index === state.selectedRoute ? ' · đang chọn' : ''}`));
    option.append(element('strong', '', `${km(candidate.distance)} km · ${Math.max(1, Math.round(candidate.duration / 60))} phút`));
    option.append(element('small', '', state.catalog ? `${candidate.along.length} camera gần tuyến${state.catalog.source !== 'live' ? ' (danh mục cũ)' : ''}` : 'Chưa có danh mục camera để đối chiếu'));
    return option;
  }));
  $('routeCameraCount').textContent = state.catalog ? `${route.along.length} camera trong ${CAMERA_RADIUS_METERS} m quanh tuyến. Có thể khác đường hoặc hướng nhìn.` : 'Chưa tải được camera. Lộ trình vẫn dùng được.';
  $('alternativesNote').textContent = state.routes.length === 1 ? 'Dịch vụ chỉ trả về một tuyến cho hai điểm này.' : 'Chọn tuyến để so sánh. Số camera không phải mức độ thông thoáng.';
}
function selectRoute(index) {
  state.selectedRoute = index;
  if (map) {
    routeLayers.clearLayers();
    state.routes.forEach((route, i) => {
      if (i !== index) L.polyline(route.coords.map(([lon, lat]) => [lat, lon]), {color: '#677f86', weight: 4, opacity: .7})
        .addTo(routeLayers).on('click', () => selectRoute(i));
    });
    L.polyline(selectedRoute().coords.map(([lon, lat]) => [lat, lon]), {color: '#13878f', weight: 6, opacity: 1}).addTo(routeLayers);
  }
  renderRouteInfo(); renderAlongMarkers(); renderCameraLayer(); renderSidebar(); fitSelectedRoute();
}
async function findRoute() {
  cancelMapPick();
  const missing = ['from', 'to'].filter(field => !state.places[field]);
  if (missing.length) {
    routeStatus('Chọn địa điểm chính xác từ kết quả hoặc trên bản đồ trước khi tìm tuyến.');
    await Promise.all(missing.map(lookupPlace));
    return;
  }
  invalidateRoute();
  const ticket = routeRequest.begin();
  const a = {...state.places.from}, b = {...state.places.to};
  setRouteBusy(true); routeStatus('Đang so sánh các tuyến ô tô…');
  try {
    const routes = await getRoutes(a, b, {signal: ticket.signal});
    if (!ticket.current()) return;
    state.endpoints = {a, b};
    state.routes = routes.map(route => ({...route, along: camerasAlongRoute(state.cameras, route.coords)}));
    selectRoute(0);
    routeStatus(`Đã tìm thấy ${routes.length} tuyến. Chọn tuyến bên dưới để so sánh.`);
  } catch (error) { if (ticket.current()) routeStatus(error.message, true); }
  finally { if (ticket.current()) setRouteBusy(false); }
}

function renderFavorites() {
  $('favCount').textContent = `(${state.favorites.length})`;
  const rows = state.favorites.map((favorite, index) => {
    const row = element('div', 'favorite-row');
    const open = button(`${favorite.aLabel} → ${favorite.bLabel}`, () => {
      cancelMapPick();
      for (const [field, place, query] of [['from', favorite.a, favorite.from], ['to', favorite.b, favorite.to]]) {
        if (place) choosePlace(field, place);
        else {
          placeRequests[field].cancel(); state.places[field] = null; $(field).value = query;
          $(field + 'Search').disabled = false;
          $(field + 'Results').hidden = true;
          $(field + 'Hint').textContent = 'Lộ trình cũ: chọn lại địa điểm để lưu tọa độ chính xác.';
        }
      }
      invalidateRoute(); renderEndpoints();
      if (favorite.a && favorite.b) void findRoute();
      else routeStatus('Lộ trình cũ chưa lưu tọa độ. Chọn hai địa điểm rồi tìm đường để cập nhật.');
    }, 'favorite-open');
    const remove = button('Xóa', () => {
      const next = state.favorites.filter((_, i) => i !== index);
      const error = writeStored(storage, FAVORITES_KEY, next); storageError(error);
      if (!error) { state.favorites = next; renderFavorites(); $('favoriteSection').querySelector('summary').focus(); }
    });
    remove.setAttribute('aria-label', `Xóa lộ trình ${favorite.aLabel} đến ${favorite.bLabel}`);
    row.append(open, remove); return row;
  });
  $('favList').replaceChildren(...(rows.length ? rows : [element('p', 'muted', 'Chưa lưu lộ trình. Tìm đường rồi chọn Lưu lộ trình này.')]));
}
function saveFavorite() {
  if (!state.endpoints) return;
  const {a, b} = state.endpoints;
  const favorite = {from: a.label, to: b.label, aLabel: a.label, bLabel: b.label, a, b};
  const existing = state.favorites.findIndex(f => favoriteKey(f) === favoriteKey(favorite) || (!f.a && !f.b && f.aLabel === a.label && f.bLabel === b.label));
  const next = [...state.favorites];
  if (existing >= 0) next[existing] = favorite; else next.push(favorite);
  const error = writeStored(storage, FAVORITES_KEY, next); storageError(error);
  if (error) return;
  state.favorites = next; renderFavorites(); $('favoriteSection').open = true;
  routeStatus('Đã lưu lộ trình và tọa độ hai điểm trên thiết bị này.');
}

$('panelToggle').addEventListener('click', () => { cancelMapPick(); setPanel('panel', $('panel').hidden); });
$('listToggle').addEventListener('click', () => { cancelMapPick(); setPanel('sidebar', $('sidebar').hidden); });
$('panelClose').addEventListener('click', () => setPanel('panel', false, true));
$('sbClose').addEventListener('click', () => setPanel('sidebar', false, true));
$('routeForm').addEventListener('submit', event => { event.preventDefault(); void findRoute(); });
for (const field of ['from', 'to']) {
  $(field).addEventListener('input', () => {
    placeRequests[field].cancel(); state.places[field] = null;
    $(field + 'Search').disabled = false; $(field + 'Results').hidden = true;
    $(field + 'Hint').textContent = 'Nhập tên rồi chọn kết quả.';
    invalidateRoute(); renderEndpoints();
  });
  $(field).addEventListener('keydown', event => {
    if (event.key === 'Enter' && !state.places[field]) { event.preventDefault(); void lookupPlace(field); }
    if (event.key === 'Escape') { placeRequests[field].cancel(); $(field + 'Results').hidden = true; $(field + 'Search').disabled = false; }
  });
  $(field + 'Search').addEventListener('click', () => { void lookupPlace(field); });
  $(field + 'Map').addEventListener('click', () => beginMapPick(field));
}
$('cancelPick').addEventListener('click', () => { cancelMapPick(); setPanel('panel', true, true); });
$('pickCenter').addEventListener('click', () => { if (map) completeMapPick(map.getCenter()); });
$('pickHere').addEventListener('click', () => { void showHere(true); });
$('fitRoute').addEventListener('click', () => { collapsePanels(); fitSelectedRoute(); $('map').focus(); });
$('alongList').addEventListener('click', () => { $('cameraMode').value = 'route'; $('cameraSearch').value = ''; state.listLimit = 40; setPanel('sidebar', true); renderCameraLayer(); });
$('saveFavBtn').addEventListener('click', saveFavorite);
$('retryCameras').addEventListener('click', () => { void reloadCameras(); });
$('retryBasemap').addEventListener('click', () => { void basemap?.start(); });
for (const id of ['cameraMode', 'distFilter', 'cameraSearch']) $(id).addEventListener(id === 'cameraSearch' ? 'input' : 'change', () => {
  state.listLimit = 40; renderSidebar(); renderCameraLayer();
});
$('showCameras').addEventListener('change', renderCameraLayer);
$('moreCameras').addEventListener('click', () => { state.listLimit += 40; renderSidebar(); });
$('autoRefresh').addEventListener('change', () => refresh.setEnabled($('autoRefresh').checked));
smallScreen.addEventListener('change', () => { if (smallScreen.matches && !$('sidebar').hidden) setPanel('panel', false); });
document.addEventListener('visibilitychange', () => refresh.setVisible(!document.hidden));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && picking) { cancelMapPick(); setPanel('panel', true, true); } });
window.addEventListener('pagehide', () => {
  stopLive();
  stopWall();
  basemap?.dispose();
  refresh.dispose(); routeRequest.cancel(); catalogRequest.cancel();
  Object.values(placeRequests).forEach(request => request.cancel()); clearTimeout(noticeTimer);
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('storage', event => {
  if ([FAVORITES_KEY, PINS_KEY, CITY_KEY, null].includes(event.key)) {
    if (event.key === CITY_KEY || event.key === null) {
      const next = (() => { try { return normalizeCity(JSON.parse(storage.getItem(CITY_KEY))); } catch { return state.city; } })();
      if (next !== state.city) setCity(next);
    }
    state.favorites = readStored(storage, FAVORITES_KEY, normalizeFavorites).value;
    state.pins = readStored(storage, PINS_KEY, normalizePins).value;
    renderFavorites(); renderSidebar(); renderCameraLayer(); document.querySelectorAll('[data-pin]').forEach(updatePinButton);
  }
});

function applyCityChrome() {
  const city = CITIES[state.city];
  const select = $('citySelect');
  if (select) select.value = state.city;
  const subtitle = document.querySelector('.brand .tagline');
  if (subtitle) subtitle.textContent = `${city.label} · Quan sát trước khi đi`;
  document.title = `Camera Giao Thông ${city.label}`;
  $('from').placeholder = city.fromPlaceholder;
  $('to').placeholder = city.toPlaceholder;
}
function setCity(city, {fit = true} = {}) {
  const next = normalizeCity(city);
  if (next === state.city && state.catalog) return;
  if ($('liveDialog').open) $('liveDialog').close();
  else stopLive();
  state.city = next;
  const error = writeStored(storage, CITY_KEY, next);
  storageError(error);
  applyCityChrome();
  if (fit) map?.setView(CITIES[next].center, CITIES[next].zoom);
  state.cameras = []; state.catalog = null; state.catalogError = '';
  invalidateRoute(); renderDistricts(); renderSidebar(); renderCameraLayer(); renderAlongMarkers();
  void reloadCameras();
}

initMap();
applyCityChrome();
renderFavorites(); renderSidebar(); storageError(storedFavs.error || storedPins.error);
$('citySelect')?.addEventListener('change', event => setCity(event.target.value));
void reloadCameras();
