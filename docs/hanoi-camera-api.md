# API camera Hà Nội

Tài liệu này mô tả **hai lớp API** dùng cho camera giao thông/cộng đồng Hà Nội trong [ứng dụng Camera Giao Thông](README.md):

1. **Nguồn công khai CDS + VMS Viettel** — danh mục vị trí và luồng live.
2. **Máy chủ ứng dụng** (`127.0.0.1:8765` local, hoặc cùng origin trên Vercel) — hợp đồng mà giao diện web gọi: danh sách, JPEG, live fMP4.

Không dùng API Notis (HCM). Token VMS **không** gửi ra trình duyệt. Local chỉ nghe loopback; Vercel chỉ nhận host đã cấu hình.

Nguồn sự thật trong mã: [hanoi-vms.mjs](../hanoi-vms.mjs), [server.mjs](../server.mjs), [camera-core.mjs](../assets/camera-core.mjs), [camera-api.mjs](../assets/camera-api.mjs), [hanoi-live.mjs](../assets/hanoi-live.mjs).

## Chạy và gọi API

```sh
cd work/camera-giaothong
npm start
```

Mở [http://127.0.0.1:8765/camera-traffic.html](http://127.0.0.1:8765/camera-traffic.html), chọn **Hà Nội**. Cần Node ≥ 20 và **ffmpeg** (JPEG + live). Không `npm install`.

Mọi endpoint chỉ chấp nhận host loopback (`127.0.0.1`/`localhost` kèm cổng) hoặc, khi `VERCEL=1`, host trong `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL` / `ALLOWED_HOST`. Origin phải cùng origin (hoặc không Origin). Phương thức GET/HEAD (live chỉ GET). Không CORS công khai.

## Sơ đồ luồng

```text
Trình duyệt                    Máy chủ local                    CDS / VMS
     |                              |                              |
     | GET /api/hanoi/cameras       | GET .../video-wall-cameras-v2 |
     | < JSON (không WSS/token)     | < catalog + profile.streams   |
     |                              |                              |
     | GET /api/hanoi/snapshot/{id} | WSS /evup/{token}/{channel}  |
     | < image/jpeg                 | send "mobile:{token}"         |
     |                              | < binary NAL H.264/H.265      |
     |                              | ffmpeg → 1 khung JPEG         |
     |                              |                              |
     | GET /api/hanoi/live/{id}     | cùng handshake WSS            |
     | < video/mp4 (fMP4 chunked)   | ffmpeg → H.264 baseline fMP4  |
     | MediaSource + <video>        |                              |
```

Hai ID khác nhau:

| ID | Ví dụ | Dùng ở |
|---|---|---|
| `camera_id` CDS | `gm9SoV9AOg` | `/api/hanoi/snapshot/{id}`, `/api/hanoi/live/{id}`, field JSON local |
| `id` trên UI | `hn-gm9SoV9AOg` | ghim, danh sách, marker (`hn-` + `camera_id`) |

## 1. Catalog công khai CDS

Không cần đăng nhập. App **không** gọi CDS từ trình duyệt; máy chủ kéo hộ rồi lọc field.

```http
GET https://cds.hanoi.gov.vn/api/1.0/public/video-wall-cameras-v2?page=1&refresh=0
Accept: application/json
```

Phân trang Laravel-style: `current_page`, `last_page` (thường 9), `per_page` 10, `total` ~86. Máy chủ lặp `page=1..last_page` (tối đa 20).

Health VMS (CDS, app **không** gọi):

```http
GET https://cds.hanoi.gov.vn/api/1.0/public/check-overload-vms
```

### Field camera (rút từ JSON gốc)

Dùng cho vị trí / tên:

- `camera_id` — chuỗi `[\w-]{1,64}`
- `name` — thường có hậu tố `-PTZ` (loại máy, không phải quyền điều khiển)
- `ward_name`, `lng`, `lat` — số JSON
- `profile[]` — từng độ phân giải (`384x216`, `1920x1080`, …)

Mỗi `profile.streams[]`:

| Field | Ý nghĩa |
|---|---|
| `protocol` | `HTTPS` hoặc `WSS` |
| `source` | URL đầy đủ |
| `device_id` | mã thiết bị VMS |
| `channel_id` | kênh trong URL |

HTTPS mẫu (trang xem playback — **404** khi GET ngoài app, không dùng):

```text
https://rec01ihanoi.vtscloud.vn:443/playback/view/{channel_id}
```

WSS live (dùng):

```text
wss://rec0{1|2|3}ihanoi.vtscloud.vn:443/evup/{token}/{channel_id}
```

Host chỉ `rec01ihanoi.vtscloud.vn`, `rec02ihanoi.vtscloud.vn`, `rec03ihanoi.vtscloud.vn`. Token path: unix time (~10 số) + 6 ký tự, phát mới mỗi lần kéo catalog. `channel_id` khác nhau giữa profile SD/HD.

JSON CDS còn `created_user`, email, điện thoại, `vms_key`, … Máy chủ **bỏ hết**. Không log token.

### JSON local sau khi lọc

`GET /api/hanoi/cameras` trả mảng:

```json
{
  "camera_id": "gm9SoV9AOg",
  "name": "An Dương Vương-Đường Dẫn Cầu Nhật Tân - C149.08-PTZ",
  "ward_name": "Phú Thượng",
  "lng": 105.823,
  "lat": 21.075,
  "ptz": true
}
```

Không có `live`, `wss://`, `evup/`, `token`. `ptz: true` khi tên khớp `\bPTZ\b` — chỉ nhãn loại máy.

Cache catalog trên máy chủ ~45 giây.

Fallback nếu CDS lỗi: [cameras_hanoi.json](../cameras_hanoi.json) (vị trí). Ảnh/live vẫn cần VMS.

## 2. Handshake VMS (WebSocket)

Player iHanoi native: sau khi mở WSS, gửi **một tin nhắn text**:

```text
mobile:{token}
```

`token` là đoạn path `/evup/{token}/{channel}`. Không gửi thì socket mở nhưng **không có frame**.

Origin trình duyệt (`http://127.0.0.1:8765`) vẫn nhận được frame; app vẫn **proxy trên máy chủ** để token không lộ.

### Gói binary

| Offset | Ý nghĩa |
|---|---|
| `byte[1]` | `1` = H.264 (AVC), `2` = H.265 (HEVC) |
| `byte[12:]` | một NAL, **không** có start code |

App prepend `00 00 00 01` (Annex-B).

NAL cần cho một keyframe:

- H.264: SPS (7), PPS (8), IDR (5)
- H.265: VPS (32), SPS (33), PPS (34), IDR (19 hoặc 20)

P-frame trước bộ tham số bị bỏ. Máy chủ chọn **profile WSS có `width×height` lớn nhất**.

## 3. API máy chủ local

Base: `http://127.0.0.1:8765`

`{id}` = `camera_id` CDS, regex `[\w-]{1,64}`.

### GET `/api/hanoi/cameras`

Danh mục đã lọc. `Content-Type: application/json`.

| HTTP | Khi nào |
|---|---|
| 200 | mảng camera |
| 502 | CDS/schema/lỗi mạng; body `{ "error": "Chưa tải được danh mục camera Hà Nội. Hãy thử lại." }` |

Trình duyệt: `loadCatalog({ city: 'hn' })` gọi URL này, rồi `normalizeHanoiCameras` → `id: "hn-…"`, `snapshotUrl: "./api/hanoi/snapshot/{camera_id}"`.

```sh
curl -sS http://127.0.0.1:8765/api/hanoi/cameras | python3 -m json.tool | head
```

### GET `/api/hanoi/snapshot/{id}`

Một khung JPEG từ keyframe live (không phải snapshot Notis). Cache JPEG ~8 giây / camera. Gom request trùng.

| HTTP | Body |
|---|---|
| 200 | `image/jpeg`, `Cache-Control: no-store` |
| 400 | id không hợp lệ |
| 404 | không có camera / không có WSS hợp lệ |
| 429 | > 40 ảnh / phút |
| 503 | chưa có `ffmpeg` |
| 502 | VMS/timeout/ffmpeg lỗi |

HEAD: cùng status, không body khi 200.

```sh
ID=$(curl -sS http://127.0.0.1:8765/api/hanoi/cameras | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['camera_id'])")
curl -sS -o /tmp/hn.jpg -D - "http://127.0.0.1:8765/api/hanoi/snapshot/$ID"
file /tmp/hn.jpg
```

UI: [snapshot-loader.mjs](../assets/snapshot-loader.mjs) — URL tương đối, `?t=` chống cache. **Làm mới 15s** chỉ khi khung đang mở và tab hiện.

### GET `/api/hanoi/live/{id}`

Luồng fMP4 chunked. Transcode H.264 baseline (`libx264`, `ultrafast`, `zerolatency`, `frag_keyframe+empty_moov+default_base_moof`). **Một live tại một thời điểm** (mở camera khác cắt live cũ). Đóng kết nối HTTP thì cắt WSS + ffmpeg.

| HTTP | Body |
|---|---|
| 200 | `video/mp4` chunked, bắt đầu khi có byte đầu (ftyp/moov) |
| 405 | không phải GET |
| 400 / 404 / 429 / 503 / 502 | JSON `error` (429: > 8 lần mở / phút) |

Timeout: ~12s chờ keyframe, thêm ~10s chờ byte fMP4 đầu.

```sh
# vài giây rồi Ctrl+C — file phải có ftyp/moov/moof
curl --max-time 6 -o /tmp/hn-live.mp4 "http://127.0.0.1:8765/api/hanoi/live/$ID"
python3 -c "p=open('/tmp/hn-live.mp4','rb').read(); print(p[4:8], 'moov', p.find(b'moov'), 'moof', p.find(b'moof'))"
```

Player: [hanoi-live.mjs](../assets/hanoi-live.mjs) — `MediaSource` + codec `video/mp4; codecs="avc1.42E01E"`. Nút **Xem live**. Autoplay tắt tiếng. Đóng dialog = `AbortController` → server `stop`.

Thiếu MediaSource: báo không phát được fMP4.

## 4. Dùng trong UI

1. `npm start` → mở HTML loopback (không mở file `file://`).
2. Chọn **Hà Nội** (lưu `localStorage` khóa `camtraffic_city`).
3. Bản đồ tâm ~21.0285, 105.8542. Marker + danh sách từ catalog.
4. Click camera: JPEG qua snapshot. **Xem live**: dialog `<video>`.
5. **Ghim** dùng `id` có tiền tố `hn-`.

Tìm đường / NDA Maps không liên quan VMS; xem [README](README.md).

## 5. PTZ

Hầu hết tên catalog có `-PTZ` → cờ `ptz: true`. Đó là **loại camera**.

- iHanoi dân sự **không** có joystick PTZ. Pinch-zoom là zoom ảnh.
- CDS public **không** có `movePTZ`.
- SDK operator (ThingHub login) không dùng trong app này.

Live/JPEG = hướng camera đang đứng. Digital zoom ảnh (sau này) không quay máy.

## 6. Giới hạn và lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| Danh sách HN được, không ảnh | thiếu ffmpeg, hoặc VMS timeout |
| Live không chạy | không MediaSource; hoặc ffmpeg; hoặc đã có live khác |
| Ảnh SD (~384×216) | camera chỉ có profile đó, hoặc HD không lên |
| Catalog cũ | CDS down → file lưu sẵn; vị trí có thể lệch |
| Token hết hạn | catalog cache 45s; snapshot/live lấy token từ cache đó |
| HTTPS `/playback/view` 404 | đúng: không dùng HTTP playback |
| Gọi từ host không nằm trong allowlist | máy chủ từ chối |

Không gửi WSS URL cho client. Không điều khiển PTZ đô thị. Không đụng `created_user` / PII CDS.

## 7. Kiểm tra

```sh
npm test
npm run check
```

Hợp đồng HN: [tests/hanoi-vms.test.mjs](../tests/hanoi-vms.test.mjs), [tests/hanoi-live.test.mjs](../tests/hanoi-live.test.mjs), phần Hà Nội trong [camera-core](../tests/camera-core.test.mjs) / [camera-api](../tests/camera-api.test.mjs). Test local không chứng minh CDS/VMS đang sống; `curl` snapshot/live khi `npm start` mới xác nhận luồng thật.
