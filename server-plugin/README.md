# V.Adapter · Phiên bản Plugin Server cho SillyTavern

Dịch vụ adapter dịch giao thức NovelAI thành interface tương thích OpenAI của tuyến trên, được host bởi SillyTavern:
Plugin khởi động cùng SillyTavern và dừng khi SillyTavern đóng, không cần chạy exe riêng.

```
Plugin minh họa V.Canvas trong SillyTavern ──Giao thức NovelAI──▶ Plugin này (Trong tiến trình SillyTavern, lắng nghe độc lập :8888)
                                              └──Tương thích OpenAI──▶ API sinh ảnh tuyến trên
```

> Bề mặt giao thức hướng ra ngoài được giữ nguyên như bản gốc Go: URL kênh NovelAI của client vẫn điền `http://<IP>:8888`.
> Plugin sử dụng port độc lập thay vì gắn vào route của SillyTavern, nguyên nhân là do phía server SillyTavern có bảo vệ CSRF,
> Client bên thứ ba kết nối trực tiếp đến route plugin của SillyTavern sẽ bị chặn 403, port độc lập có thể lách giới hạn này.

---

## I. Cài đặt và Khởi động

Thư mục này không được dùng trực tiếp làm plugin của SillyTavern, mà được load theo nhu cầu bởi bootloader nằm trong `<SillyTavern>/plugins/V.Adapter/`
(xem `bootstrap/index.js` ở thư mục gốc của repository). Phân công như sau:

| Vị trí | Nội dung |
|---|---|
| `<SillyTavern>/plugins/V.Adapter/` | Bản thân bootloader (copy từ `bootstrap/` qua), triển khai 1 lần sau đó không thay đổi nữa |
| `server-plugin/` bên trong thư mục extension | Bản triển khai phía server, được phân phối và cập nhật cùng với extension |
| `data/` bên dưới thư mục bootloader | Cấu hình chạy và credential (thông tin xác thực), độc lập với vị trí chứa code |

Các bước:

1) Chạy `install-loader.bat` (Windows) hoặc `install-loader.sh` (Linux / macOS / Termux) ở thư mục gốc của repository
2) Trong `<SillyTavern>/config.yaml`:
       enableServerPlugins: true
       enableServerPluginsAutoUpdate: false      # Tùy chọn, bỏ qua thao tác kiểm tra git cho thư mục plugin lúc khởi động
3) Khởi động lại SillyTavern
4) Mở ngăn extension (drawer) của V.Adapter, bấm "Khởi động dịch vụ giao thức"

Từ đó về sau cập nhật bản triển khai phía server không cần khởi động lại SillyTavern: Sau khi cập nhật extension, chỉ cần bấm "Tải lại bản triển khai" trong ngăn extension là được.

Sau khi khởi động thành công:

| Địa chỉ | Mục đích sử dụng |
|---|---|
| `http://127.0.0.1:8888/` | **Bảng quản lý** (Tổng quan hoạt động / Biên dịch nhân vật / Lịch sử sinh ảnh / Trung tâm cài đặt) |
| `http://127.0.0.1:8888/ai/generate-image` | Endpoint sinh ảnh, trả về ZIP |
| `http://127.0.0.1:8000/api/plugins/v-adapter/status` | Trạng thái read-only phía SillyTavern (Mở được tức là bootloader đã được SillyTavern load) |

> ⚠️ **Port 8888 tại cùng một thời điểm chỉ cho phép một tiến trình chiếm dụng.** Nếu file exe của bản Go cũ vẫn đang chạy, cần đóng lại trước,
> nếu không plugin khi khởi động sẽ báo lỗi `Port 8888 đã bị chiếm dụng` (Log nằm ở console của SillyTavern, tiền tố `[V.Adapter]`).

---

## II. Hai hình thái response: ZIP (Giao thức) và Xuất thẳng ảnh

`POST /ai/generate-image` **Mặc định trả về ZIP** - Đây là định dạng response của giao thức NovelAI,
SillyTavern helper cũng như bất kỳ client NAI tiêu chuẩn nào đều phụ thuộc vào định dạng này.

Tuy nhiên client của dịch vụ này không cần đi qua lớp đóng gói (encapsulation) đó. Khi client khai báo "Chỉ cần hình ảnh", server sẽ trực tiếp trả về
byte stream (luồng byte) PNG/JPEG, **không đóng gói ZIP**:

| Hành vi của Client | Trả về của Server |
|---|---|
| `Accept: image/*` (và không chủ động yêu cầu zip) | **`Content-Type: image/png` Trực tiếp là byte ảnh** |
| Chuỗi truy vấn (query string) có mang `?raw=1` | Như trên (Bắt buộc xuất thẳng) |
| Không gửi `Accept` (Tương đương `*/*`), hoặc khai báo rõ `application/zip` | `application/zip` (Định dạng giao thức) |

Cả hai hình thái đều trả về cùng một bức ảnh, điểm khác biệt duy nhất là vỏ ngoài có đóng gói ZIP hay không. Plugin minh họa V.Canvas đi theo đường dẫn xuất thẳng,
do đó không cần giải nén (unpack).

### Tham số mở rộng `?expand=1` (Mở rộng input)

Khi thêm chuỗi truy vấn `expand=1` vào `POST /ai/generate-image`, server sẽ đưa `input` trong request
cho model chat đã cấu hình trước, mở rộng thành prompt toàn cảnh bằng ngôn ngữ tự nhiên hoàn chỉnh, rồi mới dùng kết quả mở rộng để xuất ảnh.

Mục đích sử dụng: Dành cho trang "Biên dịch xuất ảnh" của V.Canvas và các cổng vào **phát lệnh sinh ảnh từ một mô tả ngắn gọn** sử dụng -
Bên gọi (caller) không cần tự nắm giữ credential của model chat, cũng không cần trực tiếp gửi request đến `/admin/*` (Đường dẫn này yêu cầu mật khẩu bảng điều khiển).

| Mục | Hành vi |
|---|---|
| Output | `input` -> `lib/translate.js` (Biên dịch nhân vật, cùng một luồng với bảng điều khiển) -> Prompt sau khi mở rộng |
| Từ khóa phủ định | Từ khóa phủ định trả về từ việc mở rộng sẽ được gộp chung với từ khóa phủ định có sẵn trong request |
| Kích thước | Khi request không ghi rõ chiều rộng/cao (thiếu hoặc < 16), sẽ áp dụng kích thước đề xuất từ việc mở rộng; Khi có ghi rõ thì lấy theo request làm chuẩn |
| Lùi về dự phòng (Fallback) | Request mở rộng thất bại / timeout / trả về rỗng / độ dài bất thường (Gấp 5 lần input gốc và lớn hơn 400 ký tự) -> **Lùi về gửi đi `input` nguyên trạng, không cản trở việc xuất ảnh** |
| Khả năng quan sát (Observability) | Mỗi lần mở rộng sẽ để lại một mục `expand` trong lịch sử sinh ảnh (Thành công hay thất bại đều ghi lại); Khi lùi về, response header `X-Illust-Expand` sẽ mang giá trị `fallback` |
| Response header | `X-Illust-Via` (Luồng thực tế), `X-Illust-Prompt` (Prompt thực tế gửi lên tuyến trên, mã hóa URL), `X-Illust-Expand` (`ok` / `fallback`) |

Client NAI tiêu chuẩn sẽ không mang tham số này, cũng không đọc các response header này, do đó tính tương thích giao thức không bị ảnh hưởng.

## III. Cấu hình

Hai tầng, độ ưu tiên từ thấp đến cao:

| File | Tác dụng |
|---|---|
| `data/config.json` | **Giá trị mặc định khởi động** (Điền vào đây khi triển khai lần đầu) |
| `data/settings.json` | Nơi lưu lại các thay đổi từ bảng điều khiển (Sau khi bảng điều khiển thay đổi thì sẽ lấy theo file này làm chuẩn) |

```json
{
  "listen": "0.0.0.0:8888",
  "qwen_url": "http://127.0.0.1:4000/v1",
  "qwen_key": "Key_tuyến_trên_của_bạn",
  "qwen_model": "qwen3.8-max",
  "default_size": "1024x1024",
  "nai_key": "v-adapter-8888",
  "chat_fallback": "chat_only"
}
```

Hỗ trợ cả biến môi trường (Độ ưu tiên nằm ở giữa hai loại trên):
`VADAPTER_QWEN_URL` / `OPENAI_BASE_URL`, `VADAPTER_QWEN_KEY` / `OPENAI_API_KEY`,
`VADAPTER_QWEN_MODEL` / `OPENAI_IMAGE_MODEL`, `VADAPTER_LISTEN`, `VADAPTER_DEFAULT_SIZE`, `VADAPTER_NAI_KEY`.

**Khôi phục lại cấu hình của `config.json`**: Xóa file `data/settings.json` và khởi động lại SillyTavern.

### Các mục cấu hình quan trọng

| Trường | Giá trị đề xuất | Giải thích |
|---|---|---|
| `chat_fallback` | `chat_only` | Chỉ sử dụng interface chat để xuất ảnh. Interface sinh ảnh tiêu chuẩn tuyến trên `/images/generations` trả về 500 một cách ổn định, cố thử dùng interface đó cũng vô ích |
| `qwen_model` | `qwen3.8-max` | Bắt buộc phải là **Model chat** (Sinh ra hình ảnh trong khung chat và trả về link ảnh). Không hỗ trợ các model có hậu tố `-image` |
| `nai_key` | `v-adapter-8888` | Trường "API Key" trong plugin minh họa phải giống với chỗ này. Làm trống nghĩa là cho qua mọi key |
| `listen` | `0.0.0.0:8888` | Cục bộ (Localhost) là 127.0.0.1:8888; `0.0.0.0` dùng để hỗ trợ kết nối từ client điện thoại. Sau khi sửa cần khởi động lại SillyTavern |

### Client (Plugin V.Canvas) điền gì

| Trường | Điền |
|---|---|
| Địa chỉ dịch vụ NAI | `http://127.0.0.1:8888` |
| API Key | `v-adapter-8888` |
| Tên model | Để trống (Dịch vụ này sẽ bỏ qua tên model do client gửi đến) |

Giá trị mặc định ban đầu của plugin chính là như trên, thông thường không cần sửa.

---

## IV. Đăng nhập bảng quản lý

- **Lần đầu mở ra sẽ miễn mật khẩu**, bảng điều khiển sẽ nhắc nhở thiết lập mật khẩu (cũng có thể bỏ qua, lát sau vào "Trung tâm cài đặt" để bổ sung).
- Sau khi thiết lập mật khẩu, `/admin/*` sẽ yêu cầu đăng nhập; **Các endpoint sinh ảnh `/ai/*` không bị ảnh hưởng** (Client sử dụng `nai_key`, không liên quan đến việc đăng nhập bảng điều khiển).
- Mật khẩu được lưu trữ dưới dạng SHA-256 tại `data/auth.json`, session là cookie trên RAM, hết hạn sau 24 giờ.

---

## V. Cấu trúc thư mục

```
V.Adapter/
├── index.js            Cổng vào plugin: info / init(router) / exit() (Quy ước của server plugin SillyTavern)
├── package.json        Bắt buộc phải chứa "type": "module" -- plugins/package.json là commonjs,
│                         khi không ghi đè, index.js sẽ bị Node hiểu là CJS và báo thẳng SyntaxError
├── panel.html          Bảng quản lý (Giao diện nguyên bản)
├── lib/
│   ├── server.js       Dịch vụ HTTP nhúng (Gộp route + CORS + Inject bảng điều khiển)
│   ├── admin.js        Endpoint quản lý + Đăng nhập bảng điều khiển
│   ├── nai.js          Endpoint giao thức NovelAI (Nhận định dạng NAI, trả về ZIP)
│   ├── pipeline.js     Gọi API tuyến trên (2 luồng b64/url, fallback chat, ngắt mạch)
│   ├── translate.js    Biên dịch nhân vật
│   ├── watermark.js    Xóa watermark (Sử dụng Jimp tích hợp sẵn của SillyTavern)
│   ├── zip.js          Tự viết tay thuật toán đóng gói ZIP dạng store
│   ├── settings.js     Đọc/ghi cài đặt (data/config.json + Biến môi trường + data/settings.json)
│   └── genlog.js       Lịch sử sinh ảnh (Ring buffer trên RAM, 200 mục gần nhất)
└── data/               Sinh ra lúc runtime (config.json / settings.json / auth.json)
```

### Nội dung bổ sung trong đợt này

Hai file từng bị đánh dấu là "đang chờ bổ sung" trong `Ghi chú giải pháp.md` đã được hoàn thành, ngoài ra còn sửa 2 chỗ đứt link của code cũ:

| File | Trạng thái |
|---|---|
| `lib/server.js` | Mới viết (Dịch vụ HTTP :8888 nhúng, Preflight CORS, HTML bảng điều khiển inject API bridge), Đã hoàn thành |
| `lib/admin.js` | Mới viết (Port 1:1 từ admin.go + auth.go + handleAdminSettings), Đã hoàn thành |
| `package.json` | Thêm mới (`"type": "module"`, nếu không plugin không thể load, xem ở trên) |
| `lib/pipeline.js` | Fix: Bổ sung `import { settingsGet }` (Trong `targetFromSettings` có gọi nhưng chưa import) |
| `lib/translate.js` | Fix: `postJSONBridge` -> `postJSON` (Tên hàm gõ nhầm, không khớp với tên lúc import) |

> Bảng điều khiển `panel.html` không bị chỉnh sửa. Nó vốn dĩ đi qua `window.parent.__V_ADAPTER_API__` (Cầu nối của hình thái extension),
> Dưới hình thái server-side, `server.js` sẽ inject một cầu nối cùng tên vào HTML khi trả về, đổi sang đi qua HTTP thực sự.

---

## VI. Biên bản nghiệm thu (Môi trường SillyTavern 1.18.0)

| Hạng mục kiểm tra | Kết quả |
|---|---|
| Sau khi SillyTavern khởi động, port 8888 có listen không | Có |
| `GET /health` | 200 `{"status":"ok","version":"v1.1.4-st.1"}` |
| `GET /ai/user/subscription` (kèm Bearer) | 200 `{"tier":0,"active":true}` |
| `GET /admin/status` | 200, Cấu hình chính xác |
| `GET /api/plugins/v-adapter/status` (Phía SillyTavern) | 200 -> Plugin đã được SillyTavern load |
| Bảng điều khiển `GET /` | 200, Đã inject cầu nối API |
| `GET/POST /admin/settings` | 200 |
| CORS Preflight `OPTIONS /ai/generate-image` | 204 + `Allow-Origin: *` + `Allow-Headers: Authorization, Content-Type, Accept` |
| Dùng key sai để gọi sinh ảnh | 401 + Thông báo |
| **Xuất ảnh End-to-End (Mặt giao thức ZIP)** | 20.2 giây -> 2.73 MB ZIP, bên trong chứa `image_0.png` |
| **Xuất ảnh End-to-End (Xuất thẳng ảnh)** | 21.8 giây -> `Content-Type: image/png`, file PNG trần 2.57 MB, không đóng gói ZIP |
| Client cũ `Accept: */*` | Vẫn trả về ZIP, mặt giao thức không bị phá vỡ |
| Lịch sử sinh ảnh | counters `{success:1, fail:0, total:1}`, `via: chat` |
| `exit()` (SillyTavern đóng) | Đóng port bình thường |

Ảnh mẫu: `plugins-test-output.png` nằm ở thư mục gốc của repository.

### ⚠️ Hai giới hạn đã biết

1. **Kích thước ảnh xuất ra không kiểm soát được.** Luồng chat hoạt động theo kiểu "bảo model vẽ một bức ảnh trong lúc chat", nó sẽ bỏ qua `width`/`height`:
   Request yêu cầu 832x1216, nhưng thực tế trả về 1664x928. "Độ phân giải" trong plugin về cơ bản vô hiệu đối với luồng này.
2. **Thi thoảng thất bại là hiện tượng bình thường.** Tuyến trên là bản web được reverse proxy, đôi khi trả về link ảnh không thể download
   (`502` + "Tất cả link ảnh trả về từ sinh ảnh chat đều không thể download hoặc phân tích"), thông thường thử lại một lần là khôi phục;
   pipeline cũng sẽ tự động thử lại một lần đối với các lỗi sự cố chốc lát (transient fault).

---

## VII. License

MIT License + Điều khoản bổ sung phi thương mại (Xem `LICENSE` ở thư mục gốc), tác giả VILK.
Cấm thương mại; Khi sáng tác phái sinh/tái phân phối vui lòng giữ lại tên tác giả và tuyên bố license này.