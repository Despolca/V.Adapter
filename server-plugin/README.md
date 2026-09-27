# V.Adapter · Phiên bản Plugin Server SillyTavern

Service chuyển đổi giao thức NovelAI thành API tương thích OpenAI tuyến trên, được host bởi SillyTavern:
Plugin sẽ khởi động cùng lúc với SillyTavern và dừng lại khi SillyTavern đóng, không cần chạy file exe độc lập.

```
Plugin minh họa V.Canvas trong SillyTavern ──Giao thức NovelAI──▶ Plugin này (Nội bộ tiến trình SillyTavern, listen độc lập ở port :8888)
                                                              └──Tương thích OpenAI──▶ API tạo ảnh tuyến trên
```

> Giao diện giao thức hướng ra bên ngoài được giữ nguyên như bản gốc Go: URL channel NovelAI của client vẫn điền `http://<IP>:8888`.
> Lý do plugin sử dụng port độc lập thay vì mount vào router của SillyTavern là vì server SillyTavern có bảo vệ CSRF,
> client bên thứ ba kết nối trực tiếp vào router plugin của SillyTavern sẽ bị 403 chặn lại, port độc lập có thể lách qua giới hạn này.

---

## I. Cài đặt và Khởi động

Thư mục này không được sử dụng trực tiếp như một plugin SillyTavern, mà sẽ được loader nằm ở `<SillyTavern>/plugins/V.Adapter/`
load theo nhu cầu (xem `bootstrap/index.js` ở thư mục gốc của repository). Phân công như sau:

| Vị trí | Nội dung |
|---|---|
| `<SillyTavern>/plugins/V.Adapter/` | Bản thể của loader (Copy từ `bootstrap/`), sau một lần deploy sẽ không thay đổi nữa |
| `server-plugin/` bên trong thư mục extension | Implementation của server, được phân phối và cập nhật cùng với extension |
| `data/` nằm dưới thư mục loader | Cấu hình chạy và thông tin xác thực, tách biệt với vị trí chứa code |

Các bước:

1) Chạy `install-loader.bat` (Windows) hoặc `install-loader.sh` (Linux / macOS / Termux) ở thư mục gốc của repository
2) Trong `<SillyTavern>/config.yaml`:
       enableServerPlugins: true
       enableServerPluginsAutoUpdate: false      # Tùy chọn, bỏ qua bước check git cho thư mục plugin khi khởi động
3) Khởi động lại SillyTavern
4) Mở ngăn kéo extension V.Adapter, bấm "Khởi động service giao thức"

Từ nay về sau, việc cập nhật implementation server không cần khởi động lại SillyTavern: Cập nhật extension xong, bấm "Reload implementation" trong ngăn kéo là được.

Sau khi khởi động thành công:

| Địa chỉ | Mục đích sử dụng |
|---|---|
| `http://127.0.0.1:8888/` | **Bảng quản lý** (Tổng quan hoạt động / Dịch nhân vật / Lịch sử tạo / Trung tâm cài đặt) |
| `http://127.0.0.1:8888/ai/generate-image` | Endpoint tạo ảnh, trả về ZIP |
| `http://127.0.0.1:8000/api/plugins/v-adapter/status` | Trạng thái read-only phía SillyTavern (Mở được tức là loader đã được SillyTavern load) |

> ⚠️ **Tại cùng một thời điểm, port 8888 chỉ cho phép một tiến trình chiếm dụng.** Nếu file exe bản Go cũ vẫn đang chạy, cần phải tắt đi trước,
> nếu không khi plugin khởi động sẽ báo lỗi `Port 8888 đã bị chiếm dụng` (Log nằm ở console của SillyTavern, tiền tố `[V.Adapter]`).

---

## II. Hai hình thái phản hồi: ZIP (Giao thức) và Ảnh trực tiếp

`POST /ai/generate-image` **mặc định trả về ZIP** - Đây là định dạng phản hồi của giao thức NovelAI,
trợ lý SillyTavern cũng như mọi client NAI tiêu chuẩn đều phụ thuộc vào định dạng này.

Nhưng client của service này không cần đi qua lớp đóng gói đó. Khi client tuyên bố "Chỉ cần ảnh", server sẽ trả về trực tiếp
luồng byte PNG/JPEG, **không đóng gói ZIP**:

| Hành vi client | Server trả về |
|---|---|
| `Accept: image/*` (Và không chủ động yêu cầu zip) | **`Content-Type: image/png` trực tiếp là byte của ảnh** |
| Query string có chứa `?raw=1` | Như trên (Bắt buộc trả ảnh trực tiếp) |
| Không gửi `Accept` (Tương đương `*/*`), hoặc yêu cầu rõ `application/zip` | `application/zip` (Định dạng giao thức) |

Cả hai hình thái đều trả về cùng một bức ảnh, sự khác biệt chỉ nằm ở lớp vỏ ngoài có đóng gói ZIP hay không. Plugin minh họa V.Canvas sử dụng luồng ảnh trực tiếp,
do đó không cần giải nén.

### Tham số mở rộng `?expand=1` (Mở rộng đầu vào)

Khi thêm query string `expand=1` vào `POST /ai/generate-image`, server sẽ ưu tiên giao `input` trong request
cho model chat đã cấu hình, mở rộng thành một prompt hình ảnh ngôn ngữ tự nhiên hoàn chỉnh, rồi mới dùng kết quả mở rộng đó để xuất ảnh.

Mục đích sử dụng: Dành cho trang "Dịch xuất ảnh" của V.Canvas và các cổng vào **kích hoạt tạo ảnh từ một câu mô tả ngắn** -
Bên gọi API không cần tự giữ thông tin xác thực model chat, cũng không cần gửi request trực tiếp vào `/admin/*` (Đường dẫn này cần mật khẩu bảng điều khiển).

| Hạng mục | Hành vi |
|---|---|
| Đầu ra | `input` -> `lib/translate.js` (Dịch nhân vật, cùng một luồng với bảng điều khiển) -> Prompt sau khi mở rộng |
| Từ tiêu cực | Từ tiêu cực trả về từ việc mở rộng được gộp chung với từ tiêu cực mang theo trong request |
| Kích thước | Nếu request không cung cấp rõ chiều rộng/chiều cao (Thiếu hoặc < 16), sẽ dùng kích thước được đề xuất từ bản mở rộng; Nếu có cung cấp rõ thì lấy theo request |
| Dự phòng thất bại | Request mở rộng thất bại / quá thời gian chờ / trả về rỗng / độ dài bất thường (Vượt quá 5 lần input gốc và lớn hơn 400 ký tự) -> **Lùi về việc gửi nguyên xi `input`, không cản trở quá trình tạo ảnh** |
| Khả năng quan sát | Mỗi lần mở rộng sẽ để lại một mục `expand` trong lịch sử tạo (Thành công hay thất bại đều ghi lại); Khi lùi về dự phòng, header phản hồi `X-Illust-Expand` sẽ là `fallback` |
| Header phản hồi | `X-Illust-Via` (Luồng thực tế), `X-Illust-Prompt` (Prompt thực tế gửi lên tuyến trên, đã URL encode), `X-Illust-Expand` (`ok` / `fallback`) |

Client NAI tiêu chuẩn sẽ không mang tham số này, cũng không đọc các header phản hồi này, do đó tính tương thích của giao thức không bị ảnh hưởng.

## III. Cấu hình

Gồm hai lớp, ưu tiên từ thấp đến cao:

| File | Tác dụng |
|---|---|
| `data/config.json` | **Giá trị mặc định khi khởi động** (Lần đầu deploy thì điền ở đây) |
| `data/settings.json` | Nơi lưu trữ thay đổi từ bảng điều khiển (Sau khi sửa trên bảng điều khiển thì sẽ ưu tiên file này) |

```json
{
  "listen": "0.0.0.0:8888",
  "qwen_url": "http://127.0.0.1:4000/v1",
  "qwen_key": "Secret key tuyến trên của bạn",
  "qwen_model": "qwen3.8-max",
  "default_size": "1024x1024",
  "nai_key": "v-adapter-8888",
  "chat_fallback": "chat_only"
}
```

Cũng hỗ trợ biến môi trường (Mức độ ưu tiên nằm giữa hai loại trên):
`VADAPTER_QWEN_URL` / `OPENAI_BASE_URL`, `VADAPTER_QWEN_KEY` / `OPENAI_API_KEY`,
`VADAPTER_QWEN_MODEL` / `OPENAI_IMAGE_MODEL`, `VADAPTER_LISTEN`, `VADAPTER_DEFAULT_SIZE`, `VADAPTER_NAI_KEY`.

**Khôi phục lại cấu hình của `config.json`**: Xóa file `data/settings.json` và khởi động lại SillyTavern.

### Các cấu hình quan trọng

| Trường | Giá trị khuyến nghị | Mô tả |
|---|---|---|
| `chat_fallback` | `chat_only` | Chỉ sử dụng API chat để xuất ảnh. API tạo ảnh tiêu chuẩn `/images/generations` tuyến trên liên tục trả về 500, việc thử API này không có tác dụng |
| `qwen_model` | `qwen3.8-max` | Bắt buộc phải là **model chat** (Tạo ảnh trong cuộc trò chuyện và trả về link ảnh). Không hỗ trợ các model có hậu tố `-image` |
| `nai_key` | `v-adapter-8888` | "API Key" trong plugin minh họa phải giống với cấu hình ở đây. Để trống đồng nghĩa với việc cho phép bất kỳ key nào |
| `listen` | `0.0.0.0:8888` | Localhost là 127.0.0.1:8888; `0.0.0.0` dùng để hỗ trợ kết nối từ client điện thoại. Sửa xong cần khởi động lại SillyTavern |

### Client (Plugin V.Canvas) điền gì

| Trường | Điền |
|---|---|
| Địa chỉ dịch vụ NAI | `http://127.0.0.1:8888` |
| API Key | `v-adapter-8888` |
| Tên model | Bỏ trống (Service này sẽ phớt lờ tên model do client gửi tới) |

Giá trị mặc định ban đầu của plugin chính là như trên, thông thường không cần chỉnh sửa.

---

## IV. Đăng nhập Bảng quản lý

- **Mở lần đầu không cần mật khẩu**, bảng điều khiển sẽ gợi ý cài mật khẩu (Có thể bỏ qua, sau đó vào "Trung tâm cài đặt" để bổ sung).
- Sau khi cài mật khẩu, các đường dẫn `/admin/*` sẽ yêu cầu đăng nhập; **Các endpoint tạo ảnh `/ai/*` không bị ảnh hưởng** (Client sử dụng `nai_key`, không liên quan đến việc đăng nhập bảng điều khiển).
- Mật khẩu được lưu trữ dưới dạng SHA-256 trong `data/auth.json`, session sử dụng cookie in-memory, hết hạn sau 24 giờ.

---

## V. Cấu trúc file

```
V.Adapter/
├── index.js            Cổng vào plugin: info / init(router) / exit() (Quy ước server plugin của SillyTavern)
├── package.json        Bắt buộc phải chứa "type": "module" - plugins/package.json là commonjs,
│                         nếu không ghi đè thì index.js sẽ bị Node hiểu lầm là CJS khi load, trực tiếp báo SyntaxError
├── panel.html          Bảng quản lý (Giao diện nguyên bản)
├── lib/
│   ├── server.js       Service HTTP nhúng (Lắp ráp router + CORS + Inject bảng điều khiển)
│   ├── admin.js        Endpoint quản lý + Đăng nhập bảng điều khiển
│   ├── nai.js          Endpoint giao thức NovelAI (Nhận định dạng NAI, trả về ZIP)
│   ├── pipeline.js     Gọi tuyến trên (Song song b64/url, dự phòng chat, ngắt mạch)
│   ├── translate.js    Dịch nhân vật
│   ├── watermark.js    Xóa watermark (Sử dụng Jimp có sẵn của SillyTavern)
│   ├── zip.js          Tự code chức năng đóng gói ZIP dạng store
│   ├── settings.js     Đọc/ghi cài đặt (data/config.json + Biến môi trường + data/settings.json)
│   └── genlog.js       Lịch sử tạo (Circular buffer trên bộ nhớ, 200 mục gần nhất)
└── data/               Tạo ra lúc chạy (config.json / settings.json / auth.json)
```

### Nội dung bổ sung trong đợt này

Hai file được đánh dấu "chờ bổ sung" trong `Phương án thiết kế.md` đã hoàn thành, đồng thời sửa hai liên kết hỏng trong code cũ:

| File | Trạng thái |
|---|---|
| `lib/server.js` | Viết mới (Nhúng service HTTP :8888, CORS preflight, Inject API bridge cho HTML của bảng điều khiển), đã hoàn thành |
| `lib/admin.js` | Viết mới (Port 1:1 từ admin.go + auth.go + handleAdminSettings), đã hoàn thành |
| `package.json` | Bổ sung (`"type": "module"`, nếu không plugin không thể load được, xem bên trên) |
| `lib/pipeline.js` | Fix lỗi: Bổ sung `import { settingsGet }` (Được gọi trong `targetFromSettings` nhưng chưa import) |
| `lib/translate.js` | Fix lỗi: `postJSONBridge` -> `postJSON` (Lỗi gõ sai tên hàm, không khớp với tên lúc import) |

> Bảng điều khiển `panel.html` không có thay đổi. Ban đầu nó chạy qua `window.parent.__V_ADAPTER_API__` (Bridge của hình thái extension),
> ở hình thái server, `server.js` sẽ inject một bridge cùng tên khi trả về HTML, chuyển sang sử dụng HTTP thực sự.

---

## VI. Nhật ký nghiệm thu (Môi trường SillyTavern 1.18.0)

| Kiểm tra | Kết quả |
|---|---|
| Sau khi SillyTavern khởi động, port 8888 có listen không | Có |
| `GET /health` | 200 `{"status":"ok","version":"v1.1.4-st.1"}` |
| `GET /ai/user/subscription` (Kèm Bearer) | 200 `{"tier":0,"active":true}` |
| `GET /admin/status` | 200, cấu hình chính xác |
| `GET /api/plugins/v-adapter/status` (Phía SillyTavern) | 200 -> Plugin đã được SillyTavern load |
| Bảng điều khiển `GET /` | 200, đã inject API bridge |
| `GET/POST /admin/settings` | 200 |
| CORS preflight `OPTIONS /ai/generate-image` | 204 + `Allow-Origin: *` + `Allow-Headers: Authorization, Content-Type, Accept` |
| Cung cấp key sai để gọi API tạo ảnh | 401 + Thông báo lỗi |
| **Tạo ảnh End-to-end (Giao diện ZIP)** | 20.2 giây -> ZIP 2.73 MB, bên trong chứa `image_0.png` |
| **Tạo ảnh End-to-end (Ảnh trực tiếp)** | 21.8 giây -> `Content-Type: image/png`, file PNG trần 2.57 MB, không đóng gói ZIP |
| Client cũ `Accept: */*` | Vẫn trả về ZIP, giao thức không bị phá vỡ |
| Lịch sử tạo | counters `{success:1, fail:0, total:1}`, `via: chat` |
| `exit()` (SillyTavern thoát) | Đóng port bình thường |

Ảnh mẫu (Sample): `plugins-test-output.png` ở thư mục gốc của repository.

### ⚠️ Hai giới hạn đã biết

1. **Kích thước ảnh xuất ra không thể kiểm soát.** Luồng chat có bản chất là "Yêu cầu model tạo một bức ảnh trong cuộc trò chuyện", nó sẽ bỏ qua `width`/`height`:
   Request yêu cầu 832x1216, thực tế trả về 1664x928. "Độ phân giải" trong plugin cơ bản là vô hiệu đối với luồng này.
2. **Thất bại ngẫu nhiên là hiện tượng bình thường.** Tuyến trên là phiên bản web chạy qua reverse proxy, thỉnh thoảng sẽ trả về link ảnh không thể tải xuống
   (`502` + "Tất cả link ảnh trả về từ tạo ảnh qua chat đều không thể tải xuống hoặc parse"), thử lại một lần thường sẽ tự khôi phục;
   pipeline cũng sẽ tự động thử lại một lần đối với các lỗi chớp nhoáng (transient error).

---

## VII. Giấy phép

MIT License + Điều khoản bổ sung phi thương mại (Xem `LICENSE` ở thư mục gốc), tác giả VILK.
Cấm thương mại hóa; khi sáng tác phái sinh/phân phối lại vui lòng giữ nguyên chữ ký và tuyên bố cấp phép này.