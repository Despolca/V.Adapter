# V.Adapter · Engine Tạo Ảnh SillyTavern

> Biến một câu nói thành một bức ảnh. V.Adapter được tích hợp sẵn vào giao diện SillyTavern, kết nối trực tiếp với API tạo ảnh tương thích OpenAI - Cài xong là dùng ngay, không cần service độc lập, không cần port, không cần channel NovelAI.

Nó là engine xuất ảnh trong SillyTavern: Họa sĩ tuyến trên (API tạo ảnh tương thích OpenAI) chịu trách nhiệm vẽ, V.Adapter chịu trách nhiệm biến "Mô tả" thành "Request", biến "Phản hồi" thành "Hình ảnh" - Khi API tạo ảnh tiêu chuẩn không khả dụng sẽ tự động chuyển sang mô hình chat để dự phòng, tiện tay xóa luôn watermark ở góc dưới bên phải, ảnh vẽ xong sẽ rơi vào khung chat dưới dạng thư viện ảnh (gallery). Nó không quan tâm "khi nào nên vẽ" - đó là việc của V.Canvas; nó chỉ lo việc vẽ thành công, vẽ sạch sẽ, vẽ có lưu lại lịch sử.

> Port từ V.Adapter v1.1.4 (Go, tác giả **VILK**, MIT License), logic cốt lõi được port từng chữ một.

---

## Nó có thể làm gì

### 🎨 Engine xuất ảnh cài xong là dùng ngay
- **Không cần tiến trình độc lập**: Bản thân extension chính là engine xuất ảnh, cài đặt xong là có thể xuất ảnh ngay trong SillyTavern - không có file exe độc lập, không có port độc lập, không cần cấu hình channel NovelAI.
- **Logic cốt lõi được port từng chữ một**: Chuyển đổi giao thức, dịch mô tả, xóa watermark, lưu trữ thiết lập, lịch sử tạo ảnh, các module tương ứng 1:1 với bản gốc bằng Go.

### 🔁 Chuỗi tạo ảnh: Mặc định chạy qua API chat
- **Bốn tùy chọn chuỗi**: `chat_only` (**Mặc định**: Chỉ chạy qua API chat để tạo ảnh, ổn định và khả dụng) / `auto` (Ưu tiên API tiêu chuẩn, thất bại tự động chuyển sang chat dự phòng) / `off` (Chỉ dùng API tiêu chuẩn) / `openai`.
- **Tại sao mặc định là chat**: Trong môi trường reverse proxy, API tạo ảnh tiêu chuẩn `/images/generations` thường bị hệ thống kiểm soát rủi ro tuyến trên chặn (trả về 429/trang captcha),
  trong khi API chat lại hoạt động ổn định và vẫn có thể tạo ảnh; `chat_only` chạy trực tiếp qua chuỗi khả dụng, không đâm đầu vào API bị chặn nữa.
  Khi tuyến trên là **Mô hình tạo ảnh thực thụ** (như qwen-image, dall-e-3), hãy đổi lại thành `auto` / `off` / `openai`.
- **Ngắt mạch chống kẹt**: Trong chế độ `auto`, khi API tiêu chuẩn trả về 5xx / 429 / cảnh báo rủi ro, tất cả sẽ được tính vào bộ ngắt mạch. Nếu thất bại liên tiếp 3 lần, nó sẽ chuyển thẳng sang API chat trong vòng 30 phút.
- **Hiển thị dự phòng ảnh từ xa**: Khi link ảnh từ xa lấy được qua dự phòng chat không hỗ trợ tải xuống cục bộ, nó sẽ trích dẫn trực tiếp link gốc để hiển thị (ảnh này sẽ không được xóa watermark).

### 🪄 Tạo ảnh bằng một câu nói: Dịch nhân vật và /vgen
- **Trang dịch nhân vật**: Nhập một câu mô tả -> Tự động dịch thành prompt hoàn chỉnh -> Xuất ảnh.
- **Lệnh `/vgen`**: Có thể gán vào quick reply; `translate=false` để trực tiếp dùng nội dung làm prompt, `size=832x1216` để chỉ định kích thước.
- **Kết quả vào khung chat**: Chèn dưới dạng "Tin nhắn nhân vật + Thư viện ảnh" (giống hệt tính năng tạo ảnh mặc định của SillyTavern), ảnh tự động được lưu vào thư mục user data của SillyTavern.

### 🧹 Tự động xóa watermark
- Tự động xóa watermark ở góc dưới bên phải (Làm mờ trung bình 9x9 x 6 vòng, implement bằng Canvas), thuật toán giống hệt bản gốc Go.

### 📋 Lịch sử tạo và bảng điều khiển hoàn chỉnh
- **Tổng quan hoạt động**: Trạng thái service, cấu hình đang áp dụng (Key đã được che), lịch sử tạo ảnh gần đây.
- **Lịch sử tạo**: 200 mục gần nhất, có thể xem lại bất cứ lúc nào.
- **Trung tâm cài đặt**: API tuyến trên, model, kích thước mặc định, chuỗi tạo ảnh; thay đổi được lưu ngay lập tức, nếu lưu thất bại sẽ rollback và báo rõ lý do.

### 🔗 Cấu hình hai luồng, việc ai nấy làm
- **① Port giao thức `:8888`**: Dành cho V.Canvas, plugin NAI bên thứ ba, client bên ngoài sử dụng -> Cấu hình nằm trong **Plugin Server** (`<SillyTavern>\plugins\V.Adapter\data\`, quản lý tại bảng điều khiển `http://127.0.0.1:8888`).
- **② Nội bộ extension**: Dành cho lệnh `/vgen` của extension này, dịch nhân vật xuất ảnh sử dụng -> Cấu hình nằm trong bảng quản lý của chính extension này.
- **Các khâu bắt buộc đi qua** của hai luồng này khác nhau, cấu hình chỉ có thể được lưu ở khâu bắt buộc của luồng tương ứng, mỗi bên lưu một bản, không dùng chung; sửa nhầm chỗ sẽ không có tác dụng.
- **Đã xóa preset phong cách vẽ**: Do bên tiêu thụ tự quyết định - V.Canvas cấu hình ở trang "Prompt", plugin tạo ảnh bên thứ ba dùng cổng vào riêng của chúng để cấu hình. Các request được forward qua `:8888` sẽ gửi nguyên xi `input` từ client đưa tới, service này không gắn thêm bất kỳ tiền tố phong cách nào.

### 🤝 Phân công rõ ràng với V.Canvas
- Extension này chịu trách nhiệm **"Vẽ thế nào"**: Kết nối tuyến trên, chuyển đổi giao thức, xóa watermark, lịch sử tạo, port giao thức `:8888`.
- Lắng nghe AI phản hồi để tự động xuất ảnh (**"Khi nào vẽ, hiển thị ở đâu"**) do **V.Canvas** đảm nhận, extension này không cung cấp nữa - không dẫm chân lên nhau, ai làm việc nấy.

## Mẹo nhỏ
- **Môi trường reverse proxy nên dùng `chat_only` mặc định**: Chạy thẳng qua API chat để xuất ảnh, né API tiêu chuẩn bị chặn bởi kiểm soát rủi ro.
- **Lưu ý CORS**: Extension chạy trong trình duyệt, nếu muốn kết nối trực tiếp với API tuyến trên thì tuyến trên phải cho phép CORS (trả về `Access-Control-Allow-Origin`); tự dựng reverse proxy (như zai2api-http) thì thêm một dòng CORS header là xong, nếu không hãy đổi sang proxy trung gian có hỗ trợ CORS.
- **Cấu hình lưu theo luồng**: Muốn sửa cấu hình cho `/vgen` thì vào bảng quản lý của extension này, muốn sửa cấu hình cho V.Canvas thì vào Plugin Server ở `:8888`, đừng sửa nhầm chỗ.
- **Phong cách vẽ không cấu hình ở đây**: Service này không gắn thêm phong cách vẽ, hãy để bên tiêu thụ (trang "Prompt" của V.Canvas) quyết định.

---

## Cài đặt

### I. Bản thể Extension

1. Mở SillyTavern -> Bảng "Extensions" ở trên cùng (biểu tượng ba khối vuông)
2. Bấm "Install Extension"
3. Dán địa chỉ git của repo này (`https://github.com/<USERNAME>/V.Adapter.git`) -> Cài đặt
4. Hoàn tất thì danh sách extension sẽ xuất hiện "V.Adapter"

**Khi không thể truy cập GitHub (Cài đặt cục bộ)**: Giải nén gói release (`V.Adapter-1.1.4-src.zip`), đưa toàn bộ
thư mục `V.Adapter` vào `<SillyTavern>/data/<user-handle>/extensions/`, khởi động lại SillyTavern là được.

### II. Cài đặt Loader Service (Một lần duy nhất, chỉ cần cho plugin bên thứ ba)

SillyTavern chỉ load code server trong `plugins/` khi khởi động tiến trình, và cũng không cho Plugin Server nút cài đặt,
nên loader chỉ cần đặt một lần. Đặt xong **không cần cập nhật theo phiên bản nữa** - Bản thân code implement của server nằm trong
thư mục extension, nó sẽ đi theo thao tác "Install Extension".

**Chỉ khi bạn cần plugin tạo ảnh bên thứ ba của SillyTavern thì mới cần bước này**; Nếu chỉ dùng V.Canvas thì bỏ qua, nó dùng kết nối trực tiếp trong trang.

- Windows: Bấm đúp vào `install-loader.bat` trong thư mục extension
- Linux / macOS / Termux: Chạy `sh install-loader.sh` trong thư mục extension

Script sẽ tự động hoàn thành ba việc, **không cần chỉnh sửa thủ công bất kỳ file nào**:

1. Định vị thư mục gốc SillyTavern (mặc định là lên 4 cấp từ thư mục extension; có thể thêm tham số để chỉ định, ví dụ
   `sh install-loader.sh /root/SillyTavern`)
2. Copy `bootstrap/` vào `<SillyTavern>/plugins/V.Adapter/` (Thư mục `data/` hiện có sẽ được giữ nguyên)
3. Đổi `enableServerPlugins` trong `config.yaml` thành `true` (File gốc tự động backup thành
   `config.yaml.bak-<timestamp>`)

Sau đó **khởi động lại SillyTavern một lần** là xong. Từ nay về sau không cần cấu hình gì thêm.

### III. Khởi động Service Giao thức

Ngăn kéo extension:

```
V.Adapter      v1.1.5-st.1
   Engine tạo ảnh              [ Sẵn sàng ]
   Service giao thức           [ Đã dừng / Đang chạy · 0.0.0.0:8888 ]
   [ Khởi động service giao thức ]
   [ Áp dụng bản cập nhật ]     <- Cập nhật file plugin xong bấm vào đây để áp dụng, không cần khởi động lại SillyTavern
   [ Mở bảng quản lý ]
```

- **Khởi động service giao thức**: Load `server-plugin/` nằm trong thư mục extension, listen port `:8888`
- **Reload implementation**: Giải phóng port trước rồi load lại, dùng để áp dụng ngay sau khi cập nhật extension (**không cần khởi động lại SillyTavern**)
- Data chạy và code được tách biệt, luôn lưu tại `<SillyTavern>/plugins/V.Adapter/data/`

Quy trình cập nhật: Bấm "Install Extension" để ghi đè extension -> Bấm "Reload implementation" trong ngăn kéo.

## Cấu hình (Một lần duy nhất)

Mở ngăn kéo extension -> "Mở bảng quản lý" -> "Trung tâm cài đặt":

| Cấu hình | Mô tả |
|---|---|
| Địa chỉ API | Base URL của API tạo ảnh tương thích OpenAI (thường kết thúc bằng `/v1`) |
| API Key | Secret key tuyến trên |
| Tên model | Model tạo ảnh tuyến trên |
| Kích thước mặc định | `RộngxCao`, ví dụ `832x1216` |
| Chuỗi tạo ảnh | `chat_only` (mặc định, chỉ chạy qua API chat) / `auto` (ưu tiên tiêu chuẩn + dự phòng) / `off` (chỉ dùng tiêu chuẩn) / `openai` |

> **Lưu ý Cross-Origin**: Extension chạy trong trình duyệt, nếu muốn kết nối trực tiếp với API tuyến trên thì tuyến trên phải cho phép CORS (trả về
> `Access-Control-Allow-Origin`). Tự dựng reverse proxy (như zai2api-http) thì thêm một dòng CORS header là xong;
> Nếu tuyến trên không hỗ trợ CORS, API tiêu chuẩn sẽ không thể dùng được trong trình duyệt, vui lòng đổi sang proxy trung gian có hỗ trợ CORS.
> Khi link ảnh từ xa lấy được qua dự phòng chat không hỗ trợ tải xuống cục bộ, nó sẽ trích dẫn trực tiếp link gốc để hiển thị
> (ảnh này sẽ không được xóa watermark ở góc dưới bên phải).

## Cấu hình chia hai nơi (Quyền sở hữu cấu hình engine)

Cấu hình engine (API tuyến trên, model, kích thước mặc định, chuỗi tạo ảnh) được lưu riêng theo từng luồng, không dùng chung:

| Luồng | Ai đang đọc | Vị trí cấu hình |
|---|---|---|
| ① Qua port `:8888` | V.Canvas, plugin NAI bên thứ ba, client bên ngoài | **Plugin Server**: `<SillyTavern>\plugins\V.Adapter\data\`, quản lý tại bảng điều khiển `http://127.0.0.1:8888` |
| ② Nội bộ extension | Lệnh `/vgen` của extension này, dịch nhân vật xuất ảnh | Cài đặt extension SillyTavern (`extension_settings['v-adapter']`), quản lý tại bảng quản lý của extension này |

Nguyên nhân là do **các khâu bắt buộc đi qua** của hai luồng này khác nhau, cấu hình chỉ có thể nằm ở khâu bắt buộc của luồng đó, nếu không sẽ không có tác dụng.

> **Phong cách vẽ không nằm trong số này.** Extension này đã xóa preset phong cách vẽ: Phong cách vẽ do bên tiêu thụ tự quyết định -
> V.Canvas cấu hình ở trang "Prompt", plugin tạo ảnh bên thứ ba dùng cổng vào riêng của chúng để cấu hình.
> Các request được forward qua `:8888` sẽ gửi nguyên xi `input` từ client đưa tới, service này không gắn thêm bất kỳ tiền tố phong cách nào.

## Ngăn kéo và bảng quản lý

**Ngăn kéo** (Cài đặt, bật/tắt đều ở đây):

```
V.Adapter      v1.1.4-st.1
   Service giao thức       Đã dừng / Đang chạy · 0.0.0.0:8888
   [ Khởi động service giao thức ]
   [ Reload implementation ]
   [ Mở bảng quản lý ]
```

**Tất cả thông số đều nằm trong bảng điều khiển**:

| Trang | Nội dung |
|---|---|
| Tổng quan hoạt động | Trạng thái service, cấu hình đang áp dụng (Key đã được che), lịch sử tạo ảnh gần đây |
| Dịch nhân vật | Mô tả -> Xuất ảnh |
| Lịch sử tạo | 200 mục gần nhất |
| Trung tâm cài đặt | API tuyến trên, model, kích thước mặc định, chuỗi tạo ảnh |

Thay đổi cấu hình được lưu trữ tức thì: Công tắc hoặc ô nhập liệu mất focus là ghi ngay; Lưu thành công sẽ báo "Đã lưu và áp dụng",
lưu thất bại sẽ rollback và báo rõ lý do (ví dụ: Regex không hợp lệ).

> Ranh giới trách nhiệm: Extension này chịu trách nhiệm "Vẽ thế nào" (Kết nối tuyến trên, chuyển đổi giao thức, xóa watermark, lịch sử tạo,
> port giao thức `:8888`). Lắng nghe AI phản hồi để tự động xuất ảnh thuộc phạm vi "Khi nào vẽ, hiển thị ở đâu",
> do **V.Canvas** đảm nhận, extension này không cung cấp tính năng đó nữa.

## Lệnh /vgen (Có thể gán quick reply)

```
/vgen Một con mèo cam nằm phơi nắng trên bậu cửa sổ          <- Mô tả, tự động dịch thành prompt rồi xuất ảnh
/vgen translate=false 1girl, ...       <- Trực tiếp dùng nội dung làm prompt để xuất ảnh
/vgen translate=false size=832x1216 1girl, ...
```

Kết quả xuất ảnh được chèn vào khung chat dưới dạng "Tin nhắn nhân vật + Thư viện ảnh" (giống hệt tính năng tạo ảnh mặc định của SillyTavern),
ảnh tự động được lưu vào thư mục user data của SillyTavern.

## Mối quan hệ tương ứng với bản gốc (Service độc lập bằng Go)

| Bản gốc | Bản extension |
|---|---|
| Tiến trình độc lập listen `0.0.0.0:8888` | Tích hợp trong giao diện SillyTavern, không cần port |
| Channel NovelAI điền URL để kết nối | Không cần cấu hình, extension trực tiếp xuất ảnh vào chat |
| `POST /ai/generate-image` -> ZIP | Gọi hàm nội bộ extension -> Ảnh lưu vào SillyTavern và chèn vào tin nhắn |
| Bảng quản lý `http://ip:8888/` | Ngăn kéo extension "Mở bảng quản lý" (Giữ nguyên UI 1:1) |
| Lưu trữ `data/settings.json` | Lưu trữ cài đặt extension SillyTavern (Theo file cấu hình SillyTavern) |
| Bảng điều khiển có mật khẩu bảo vệ server | Bảng điều khiển chạy trong trình duyệt cục bộ của user, chức năng mật khẩu vẫn giữ nhưng không cần thiết nữa |

Logic cốt lõi bản gốc được port từng chữ một: `qwen_client.go`->`lib/pipeline.js`, `translate.go`->`lib/translate.js`,
`watermark.go`->`lib/watermark.js` (Implement bằng Canvas, vẫn là làm mờ trung bình 9x9 x 6 vòng),
`settings.go`->`lib/settings.js`, `genlog.go`->`lib/genlog.js`,
`admin.go`+`auth.go`->`lib/virtual-api.js`.
File `style.go` của bản gốc (Preset phong cách vẽ) không được port nữa.

## Giấy phép và Miễn trừ trách nhiệm

Phát hành dưới dạng ủy quyền **MIT License + Điều khoản bổ sung phi thương mại** (Xem `LICENSE`); Giữ lại chữ ký của tác giả gốc **VILK**.

- Cấm thương mại hóa: Khi chưa có sự cho phép bằng văn bản của tác giả, không được phép bán, cho thuê, tích hợp vào các sản phẩm hoặc dịch vụ thương mại, cũng không được trục lợi trực tiếp hoặc gián tiếp dưới bất kỳ hình thức nào như quảng cáo, nhận donate, thu phí triển khai, dựng thuê.
- Cho phép sử dụng cá nhân, học tập nghiên cứu, sao chép, chỉnh sửa (sáng tác phái sinh) và phân phối lại với mục đích phi thương mại.
- Khi sáng tác phái sinh và phân phối lại, **bắt buộc phải giữ lại chữ ký của tác giả gốc (VILK)** cùng với tuyên bố cấp phép này.
- **Chỉ dành cho mục đích học tập và nghiên cứu**, vui lòng tuân thủ điều khoản dịch vụ của tuyến trên, người dùng tự chịu rủi ro.
- Phần mềm này được cung cấp theo nguyên trạng "như hiện có", không đi kèm bất kỳ bảo đảm rõ ràng hay ngụ ý nào, tác giả không chịu trách nhiệm cho bất kỳ hậu quả nào phát sinh từ việc sử dụng chương trình này.