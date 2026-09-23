# Camera Giao Thông

Ứng dụng web của [William](https://labs.io.vn) ([GitHub](https://github.com/anhxuanpham), [LinkedIn](https://www.linkedin.com/in/26thmay/)) để chọn tuyến ô tô và xem camera giao thông gần đường đi tại **TP.HCM** và **Hà Nội**. Người dùng tự đánh giá tình hình từ ảnh; ứng dụng không đo mức độ ùn tắc. Bản công khai: [camera-giaothong.vercel.app](https://camera-giaothong.vercel.app).

Nút **Tường** mở lưới mọi camera của thành phố đang chọn. Ô đang nhìn thấy tự tải ảnh mới mỗi 15 giây (Hà Nội tối đa 8 ô/lần vì giới hạn 40 ảnh/phút). Bấm ô để xem lớn.

Nút **Vị trí** góc phải bản đồ lấy GPS, hiện chấm vị trí, kéo bản đồ tới đó. Gần Hà Nội thì đổi thành phố. Trong lúc chọn điểm A/B có **Vị trí hiện tại**. Trình duyệt sẽ hỏi quyền vị trí.

Chọn thành phố trên thanh công cụ. HCM dùng ảnh snapshot Notis. Hà Nội lấy danh mục public của CDS (`video-wall-cameras-v2`, ~86 camera). Máy chủ local bắt luồng VMS WebSocket Viettel (`wss://rec0Xihanoi.vtscloud.vn/evup/{token}/{channel}` + tin nhắn `mobile:{token}`): **một khung JPEG** (`/api/hanoi/snapshot/{id}`) và **live fMP4** (`/api/hanoi/live/{id}`, transcode H.264 baseline cho MediaSource). Token VMS không gửi ra trình duyệt. Nút **Xem live** trên camera Hà Nội. Một live tại một thời điểm. Chi tiết hợp đồng: [API camera Hà Nội](hanoi-camera-api.md).

## Chạy trên máy

Cần Node.js từ phiên bản 20, **ffmpeg** (để giải mã luồng Hà Nội), npm và trình duyệt có JavaScript/WebGL. Trong thư mục chứa [package.json](../package.json), chạy:

```sh
npm start
```

Mở [http://127.0.0.1:8765/camera-traffic.html](http://127.0.0.1:8765/camera-traffic.html). Giữ tiến trình `npm start` chạy trong lúc dùng ứng dụng; nếu đóng hoặc dừng tiến trình, địa chỉ local sẽ không còn truy cập được. Dùng địa chỉ HTTP này thay vì mở tệp HTML trực tiếp. Không cần `npm install` hoặc bước build. Nhấn `Ctrl+C` trong terminal để dừng máy chủ.

## Cấu hình nguồn bản đồ

Bản đồ nền và tìm địa điểm dùng [NDA Maps](https://docs.ndamaps.vn/). Cần khóa riêng của dự án với quyền Map Tiles, Autocomplete và Place Detail. [Máy chủ](../server.mjs) ưu tiên biến `NDAMAPS_API_KEY`; trên macOS, nếu biến này chưa có, tự đọc khóa trong Keychain. Khóa chỉ được gửi từ máy chủ đến NDA Maps, kể cả khi tải ô bản đồ. Xem [xác thực của nhà cung cấp](https://docs.ndamaps.vn/docs/authentication/apikey/).

Trên macOS, lưu khóa một lần vào Keychain bằng lệnh sau. `-w` phải ở cuối để nhập kín và xác nhận khóa trong terminal:

```sh
security add-generic-password -U -a NDAMAPS_API_KEY -s camera-giaothong.ndamaps -w
npm start
```

Các lần sau chỉ cần `npm start`, kể cả mở terminal mới. Nếu Keychain đang khóa hoặc từ chối quyền đọc, máy chủ báo rõ và dừng; mở khóa Keychain hoặc dùng biến môi trường rồi chạy lại. Muốn thay khóa, chạy lại lệnh lưu trên rồi khởi động lại máy chủ.

Nếu chỉ muốn cấu hình tạm trong một phiên zsh, dùng biến môi trường:

```zsh
read -rs 'NDAMAPS_API_KEY?NDA Maps API key: '
export NDAMAPS_API_KEY
npm start
```

Khóa không hiện khi nhập và không nằm trong lịch sử lệnh. Biến môi trường chỉ tồn tại trong phiên terminal; sau khi dừng máy chủ, dùng `unset NDAMAPS_API_KEY` để xóa biến khỏi phiên và trở lại dùng khóa Keychain ở lần chạy sau. Không ghi khóa thật vào source, báo cáo, ảnh chụp hoặc Git.

[server.mjs](../server.mjs) mặc định chỉ nghe loopback. Trên Vercel (`VERCEL=1`) nó chấp nhận host của deployment (`VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `ALLOWED_HOST`) và Origin HTTPS cùng host; vẫn chặn site khác. Khóa NDA Maps đặt bằng `NDAMAPS_API_KEY` trên Vercel, không đưa ra trình duyệt. Chi tiết: [triển khai](deployment.md). [nda-maps.mjs](../nda-maps.mjs) sở hữu các đường dẫn nhà cung cấp, giới hạn tốc độ và việc chuyển URL tài nguyên sang cùng origin để giữ khóa kín. Dùng Node thay vì máy chủ tệp Python vì ứng dụng cần lớp máy chủ này. Bản đồ có thể tải dần khi nhiều ô đang chờ; cấu hình tốc độ cục bộ không thay thế hạn mức ngày hoặc chính sách tính phí của tài khoản.

Thiếu ffmpeg trên host (Hobby Vercel thường không có) thì danh sách camera Hà Nội vẫn mở, ảnh JPEG và live trả 503. Snapshot HCM (Notis) không cần ffmpeg.

Nếu chưa có khóa, trang vẫn mở được danh sách và ảnh camera. Bản đồ nền và tìm tên địa điểm sẽ báo chưa cấu hình; chọn điểm trên bản đồ bị khóa khi nền chưa tải. Lộ trình đã lưu tọa độ vẫn có thể gọi dịch vụ tìm đường, nhưng không có nền đường phố để đối chiếu. Ứng dụng không tự chuyển về OSM/Photon khi nguồn mới lỗi.

Trước khi đưa bản đồ vào sử dụng chính thức, đối chiếu Hoàng Sa, Trường Sa và đường biên với nguồn chính thức Việt Nam ở mức toàn quốc, quần đảo và đảo; kiểm tra cả tìm kiếm và các tên trùng. Ghi nhận nguồn/style/ngày kiểm tra. Tên nhà cung cấp và nhãn tiếng Việt trên demo không thay thế việc nghiệm thu bản tích hợp. Kiểm tra lại khi thay dữ liệu hoặc style; không tự vẽ ranh giới suy đoán hay phủ nhãn để che nội dung khác bên dưới.

## Cách dùng

1. Nhập điểm đi A và điểm đến B, bấm **Tìm**, rồi chọn đúng địa điểm từ danh sách có địa chỉ. Ứng dụng lấy tọa độ sau khi bạn chọn, không tự chọn kết quả đầu tiên. Kiểm tra địa chỉ để tránh địa điểm trùng tên. Khi bản đồ đã tải, có thể dùng **Chọn trên bản đồ**, chạm vị trí hoặc di chuyển bằng phím mũi tên rồi bấm **Chọn tâm bản đồ**.
2. Bấm **Tìm tuyến ô tô**. Chọn từng tuyến để so sánh quãng đường, thời gian ước tính và camera gần tuyến. Tuyến thay thế đến từ dịch vụ tìm đường; nếu dịch vụ chỉ trả một tuyến, giao diện sẽ báo rõ.
3. Chọn **TP.HCM** hoặc **Hà Nội**. Bấm **Camera gần tuyến** để xem camera trong khoảng 500 m quanh tuyến, theo thứ tự từ A đến B. Mở **Camera** để đổi sang danh sách tất cả, lọc quận/khu vực hoặc xem camera đã ghim. Ô tìm kiếm nhận cả tiếng Việt không dấu, ví dụ `nguyen huu tho`.
4. Chọn camera trong danh sách hoặc trên bản đồ để mở ảnh; dùng **Xem ảnh lớn**, **Làm mới ảnh** hoặc **Ghim**. Camera Hà Nội có **Xem live** (fMP4). Bật **Hiện camera trên bản đồ** để hiện thêm camera theo bộ lọc. Trên màn hình nhỏ, dùng **Lộ trình**, **Camera** và **Thu gọn** để chuyển giữa bảng điều khiển và bản đồ.
5. Bật **Làm mới 15s** nếu muốn tải lại ảnh định kỳ. Chỉ khung ảnh đang mở được làm mới khi tab hiển thị; đóng khung hoặc ẩn tab sẽ dừng tải. Khi tải ảnh mới thất bại, ảnh đã tải thành công trước đó vẫn được giữ cùng thông báo lỗi.

**Lưu lộ trình này** lưu tên và tọa độ hai đầu vào trình duyệt trên thiết bị hiện tại. Mở lại mục đã lưu sẽ tìm tuyến từ các tọa độ đó. Camera ghim cũng được lưu cục bộ; dữ liệu không đồng bộ giữa thiết bị hay địa chỉ truy cập khác nhau. Dữ liệu cũ tại khóa `camtraffic_fav_routes` vẫn đọc được; mục cũ chưa có tọa độ yêu cầu chọn lại địa điểm rồi lưu. Nếu trình duyệt chặn lưu trữ, ứng dụng báo lỗi thay vì xác nhận đã lưu.

## Hiểu đúng dữ liệu

- Thời gian đi đường là ước tính cho **ô tô**, chưa tính kẹt xe trực tiếp; không phải chỉ dẫn dành cho xe máy.
- Camera gần tuyến có thể ở đường khác hoặc nhìn hướng khác. Khoảng cách và thứ tự A–B không xác nhận đúng làn xe; số camera không thể hiện độ thông thoáng.
- **Nhận lúc…** là giờ trình duyệt tải xong file JPEG. Giờ in trên khung hình (ví dụ `23.Sep.2026 13:44:59`) là đồng hồ camera; Notis không gửi giờ chụp trong header hay EXIF. Hai mốc có thể lệch vài giây.
- Khi không tải được danh mục mới, ứng dụng có thể giữ danh mục trong phiên hoặc dùng [danh mục lưu sẵn](../cameras_full.json), chưa rõ ngày thu thập. Trạng thái nguồn được hiển thị trong bảng Camera; danh mục tải được không chứng minh mọi camera đang hoạt động. Nếu không có danh mục, vẫn có thể tìm đường.
- Cần kết nối tới Notis (camera HCM), CDS Hà Nội qua máy chủ local `/api/hanoi/cameras` (danh mục HN), VMS Viettel qua `/api/hanoi/snapshot/{id}` và `/api/hanoi/live/{id}` (ảnh + live HN), NDA Maps (bản đồ nền và địa điểm), OSRM (tuyến ô tô) và CDN unpkg (thư viện bản đồ). Nếu CDS lỗi, Hà Nội dùng [danh mục lưu sẵn](../cameras_hanoi.json) cho vị trí; ảnh/live vẫn cần VMS. Thiếu ffmpeg thì danh sách HN vẫn mở, live/ảnh báo chưa giải mã được. MapLibre chỉ là thư viện vẽ lớp vector, không phải nguồn dữ liệu địa lý. OSRM vẫn cung cấp hình học tuyến, không sở hữu nhãn hay đường biên trên lớp nền. Danh mục camera lưu sẵn không biến ứng dụng thành bản dùng ngoại tuyến; dịch vụ ngoài có thể lỗi hoặc thay đổi.

## Mã nguồn và kiểm tra

[Trang vào](../camera-traffic.html) cùng [CSS](../assets/camera-traffic.css) sở hữu giao diện. [camera-app.mjs](../assets/camera-app.mjs) nối giao diện với [logic dữ liệu, tuyến và lưu trữ](../assets/camera-core.mjs), [các dịch vụ dữ liệu](../assets/camera-api.mjs), [vòng đời tải ảnh](../assets/snapshot-loader.mjs) và [player live fMP4](../assets/hanoi-live.mjs). [hanoi-vms.mjs](../hanoi-vms.mjs) sở hữu handshake `mobile:{token}`, JPEG keyframe và transcode live H.264.

[vietnam-basemap.mjs](../assets/vietnam-basemap.mjs) sở hữu nguồn/style và phiên bản renderer được cố định. Proxy trả URL tuyệt đối cùng origin local cho sprite, glyph, nguồn vector và tile; giữ nguyên các placeholder của SDK. MapLibre yêu cầu URL sprite tuyệt đối trước khi gọi `transformRequest`, nên đường dẫn tương đối có thể làm cả lớp bản đồ lỗi dù từng endpoint trả HTTP 200. [Tài liệu NDA Maps](https://docs.ndamaps.vn/en/docs/map-tiles/javascript/) mô tả hợp đồng style; [MapLibre–Leaflet](https://github.com/maplibre/maplibre-gl-leaflet) giữ các lớp camera/lộ trình của Leaflet khi vẽ nền vector.

Các lệnh kiểm tra do [package.json](../package.json) quản lý:

```sh
npm test
npm run check
```

Hợp đồng HTTP/WSS Hà Nội: [API camera Hà Nội](hanoi-camera-api.md). Kiểm thử [logic lõi](../tests/camera-core.test.mjs), [hợp đồng API](../tests/camera-api.test.mjs), [máy chủ và bảo vệ khóa](../tests/map-server.test.mjs), [tài nguyên và tốc độ NDA Maps](../tests/nda-maps.test.mjs), [lớp bản đồ](../tests/vietnam-basemap.test.mjs), [tải/làm mới ảnh](../tests/snapshot-loader.test.mjs), [luồng VMS Hà Nội](../tests/hanoi-vms.test.mjs) và [player live](../tests/hanoi-live.test.mjs). Các kiểm tra này chạy cục bộ; chúng không xác nhận nội dung địa lý, dịch vụ ngoài đang khả dụng, toàn bộ camera có ảnh hay ứng dụng đã được triển khai.
