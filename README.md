# V.Adapter · Engine Sinh Ảnh SillyTavern

> Biến một câu nói thành một bức ảnh. V.Adapter được tích hợp sẵn vào giao diện SillyTavern, kết nối trực tiếp với API sinh ảnh tương thích OpenAI - cài xong là dùng, không cần dịch vụ độc lập, không cần cổng (port), không cần kênh NovelAI.

Nó là engine xuất ảnh trong SillyTavern: Họa sĩ tuyến trên (API sinh ảnh tương thích OpenAI) chịu trách nhiệm vẽ, V.Adapter chịu trách nhiệm biến "Mô tả" thành "Request", biến "Kết quả trả về" thành "Hình ảnh" - khi interface sinh ảnh tiêu chuẩn không khả dụng, nó sẽ tự động chuyển sang model trò chuyện (chat) để dự phòng (fallback), tiện tay xóa luôn watermark ở góc dưới bên phải, ảnh vẽ xong sẽ rơi vào khung chat dưới dạng thư viện ảnh (gallery). Nó không quan tâm "khi nào nên vẽ" - đó là việc của V.Canvas; nó chỉ quan tâm đến việc vẽ thành công, vẽ sạch sẽ, và có lưu lại lịch sử sinh ảnh.

> Port từ V.Adapter v1.1.4 (Go, tác giả **VILK**, MIT License), logic cốt lõi được port nguyên văn.

---

## Nó có thể làm gì

### 🎨 Engine xuất ảnh cài xong là dùng
- **Không cần tiến trình (process) độc lập**: Bản thân extension chính là engine xuất ảnh, sau khi cài đặt sẽ xuất ảnh ngay trong SillyTavern - không có file exe độc lập, không có port độc lập, không cần cấu hình kênh NovelAI.
- **Logic cốt lõi được port nguyên văn**: Chuyển đổi giao thức, biên dịch mô tả, xóa watermark, lưu trữ thiết lập (persistence), lịch sử sinh ảnh, các module tương ứng 1:1 với bản gốc viết bằng Go.

### 🔁 Luồng sinh ảnh: Mặc định đi qua interface chat
- **4 mức luồng tùy chọn**: `chat_only` (**Mặc định**: Chỉ đi qua interface chat để sinh ảnh, ổn định và khả dụng) / `auto` (Ưu tiên interface tiêu chuẩn, thất bại tự động chuyển sang chat để dự phòng) / `off` (Chỉ dùng interface tiêu chuẩn) / `openai`.
- **Tại sao lại mặc định là chat**: Trong kịch bản dùng proxy ngược (reverse proxy), interface sinh ảnh tiêu chuẩn `/images/generations` thường bị hệ thống kiểm soát rủi ro (risk control) của tuyến trên chặn lại (trả về 429/trang mã xác nhận), trong khi interface chat lại ổn định khả dụng và cũng có thể sinh ảnh; `chat_only` trực tiếp đi qua luồng khả dụng, không còn đâm đầu vào các interface bị chặn nữa. Khi tuyến trên là **model sinh ảnh hàng xịn** (như qwen-image, dall-e-3), hãy đổi lại thành `auto` / `off` / `openai`.
- **Ngắt mạch (Circuit breaker) không gây treo máy**: Trong chế độ `auto`, interface tiêu chuẩn trả về 5xx / 429 / cảnh báo rủi ro đều sẽ được tính vào cơ chế ngắt mạch, liên tục 3 lần thì trong vòng 30 phút sẽ chuyển thẳng sang interface chat.
- **Hiển thị dự phòng ảnh từ xa**: Khi link ảnh từ xa nhận được qua luồng chat dự phòng không hỗ trợ tải xuống cục bộ, hệ thống sẽ trích dẫn trực tiếp link gốc để hiển thị (ảnh này sẽ không được xóa watermark).

### 🪄 Sinh ảnh bằng một câu nói: Biên dịch nhân vật và /vgen
- **Trang biên dịch nhân vật**: Nhập một câu mô tả -> Tự động biên dịch thành prompt hoàn chỉnh -> Xuất ảnh.
- **Lệnh `/vgen`**: Có thể gán vào câu trả lời nhanh (quick reply); `translate=false` sẽ trực tiếp coi nội dung là prompt, `size=832x1216` để chỉ định kích thước.
- **Kết quả vào khung chat**: Chèn vào dưới dạng "Tin nhắn nhân vật + Thư viện ảnh gallery" (giống với tính năng sinh ảnh mặc định của SillyTavern), ảnh tự động lưu vào thư mục dữ liệu người dùng của SillyTavern.

### 🧹 Tự động xóa watermark
- Tự động xóa watermark ở góc dưới bên phải (Làm mờ trung bình 9x9 x 6 vòng, thực hiện bằng Canvas), giống với thuật toán của bản gốc Go.

### 📋 Lịch sử sinh ảnh và Bảng điều khiển hoàn chỉnh
- **Tổng quan hoạt động**: Trạng thái dịch vụ, cấu hình đang có hiệu lực (Đã che giấu Key), lịch sử sinh ảnh gần nhất.
- **Lịch sử sinh ảnh**: 200 mục gần nhất, có thể xem lại bất cứ lúc nào.
- **Trung tâm cài đặt**: API tuyến trên, Model, Kích thước mặc định, Luồng sinh ảnh; Thay đổi được lưu lại tức thì (persistence), lưu thất bại sẽ rollback và giải thích lý do.

### 🔗 Cấu hình luồng kép, mỗi cái về đúng vị trí
- **(1) Cổng giao thức `:8888`**: Dành cho V.Canvas, plugin NAI của bên thứ 3, client bên ngoài sử dụng -> Cấu hình tại **Plugin Server** (`<SillyTavern>\plugins\V.Adapter\data\`, bảo trì tại bảng điều khiển `http://127.0.0.1:8888`).
- **(2) Nội bộ extension**: Dành cho lệnh `/vgen` của extension này, sinh ảnh bằng biên dịch nhân vật -> Cấu hình tại bảng quản lý của extension này.
- **Khâu bắt buộc đi qua** của hai luồng là khác nhau, cấu hình chỉ có thể được đặt ở khâu bắt buộc của luồng đó, mỗi bên lưu một bản, không dùng chung; Sửa nhầm chỗ sẽ không có tác dụng.
- **Art style đã bị loại bỏ preset**: Do bên sử dụng (consumer) tự quyết định - V.Canvas cấu hình tại trang "Prompt", plugin sinh ảnh bên thứ ba dùng cổng vào (entry) đi kèm của nó để cấu hình. Request được chuyển tiếp qua `:8888` sẽ gửi nguyên vẹn `input` mà client gửi đến, dịch vụ này không đính kèm bất kỳ tiền tố art style nào.

### 🤝 Phân công rõ ràng với V.Canvas
- Extension này phụ trách **"Vẽ như thế nào"**: Kết nối tuyến trên, chuyển đổi giao thức, xóa watermark, lịch sử sinh ảnh, cổng giao thức `:8888`.
- Lắng nghe AI phản hồi để tự động xuất ảnh (**"Khi nào nên vẽ, hiển thị ở đâu"**) do **V.Canvas** đảm nhận, extension này không cung cấp nữa - không dẫm chân lên nhau, mỗi người một việc.

## Mẹo nhỏ
- **Kịch bản reverse proxy hãy dùng `chat_only` mặc định**: Đi thẳng qua interface chat để xuất ảnh, né tránh interface tiêu chuẩn bị chặn bởi hệ thống kiểm soát rủi ro.
- **Lưu ý CORS**: Extension chạy trong trình duyệt, kết nối trực tiếp với tuyến trên yêu cầu tuyến trên phải cho phép CORS (trả về `Access-Control-Allow-Origin`); Các reverse proxy tự dựng (như zai2api-http) thêm một dòng header CORS là được, nếu không vui lòng đổi sang proxy trung gian hỗ trợ CORS.
- **Cấu hình lưu theo luồng**: Đổi cấu hình cho `/vgen` thì đến bảng quản lý của extension này, đổi cấu hình cho V.Canvas thì đến plugin server `:8888`, đừng đổi nhầm chỗ.
- **Art style không cấu hình ở đây**: Dịch vụ này không đính kèm art style, giao lại cho bên sử dụng (Trang "Prompt" của V.Canvas) quyết định.

---

## Cài đặt

### I. Bản thể Extension

1. Mở SillyTavern -> Bảng "Extension" ở trên cùng (icon ba hình vuông)
2. Bấm "Install Extension" (Cài đặt extension)
3. Dán địa chỉ git của repo này (`https://github.com/<USERNAME>/V.Adapter.git`) -> Install
4. Sau khi hoàn tất, danh sách extension sẽ xuất hiện "V.Adapter"

**Khi không thể truy cập GitHub (Cài đặt cục bộ)**: Giải nén gói phát hành (`V.Adapter-1.1.4-src.zip`), bỏ toàn bộ thư mục `V.Adapter` vào `<SillyTavern>/data/<user-handle>/extensions/`, khởi động lại SillyTavern là được.

### II. Cài đặt bootloader dịch vụ (Làm 1 lần, chỉ cần thiết cho plugin bên thứ 3)

SillyTavern chỉ load code server-side trong `plugins/` khi tiến trình khởi động, cũng không cung cấp cổng vào (entry) cài đặt cho plugin server, nên bootloader (trình mồi) cần được đặt thủ công một lần. Đặt xong **không cần cập nhật theo phiên bản nữa** - bản thân implementation (bản triển khai) của server nằm trong thư mục extension, sẽ đi theo cùng bước "Install Extension".

**Chỉ khi cần dùng plugin sinh ảnh SillyTavern của bên thứ ba mới cần bước này**; Nếu chỉ dùng V.Canvas thì bỏ qua, nó đi qua kết nối trực tiếp trong trang.

- Windows: Double-click vào `install-loader.bat` trong thư mục extension
- Linux / macOS / Termux: Thực thi `sh install-loader.sh` trong thư mục extension

Script sẽ tự động hoàn thành 3 việc, **không cần chỉnh sửa thủ công bất kỳ file nào**:

1. Định vị thư mục gốc của SillyTavern (Mặc định là 4 cấp thư mục tính từ thư mục extension trở lên; có thể thêm tham số để chỉ định, ví dụ `sh install-loader.sh /root/SillyTavern`)
2. Copy `bootstrap/` vào `<SillyTavern>/plugins/V.Adapter/` (thư mục `data/` đã có sẽ được giữ nguyên)
3. Sửa `enableServerPlugins` trong `config.yaml` thành `true` (file gốc sẽ tự động backup thành `config.yaml.bak-<timestamp>`)

Sau đó **khởi động lại SillyTavern 1 lần** là được. Từ đó về sau không cần bất kỳ cấu hình nào nữa.

### III. Khởi động dịch vụ giao thức

Ngăn extension (Extension drawer):

```
V.Adapter      v1.1.5-st.1
   Engine xuất ảnh       [ Sẵn sàng ]
   Dịch vụ giao thức     [ Đã dừng / Đang chạy · 0.0.0.0:8888 ]
   [ Khởi động dịch vụ giao thức ]
   [ Áp dụng bản cập nhật ]     <- Sau khi cập nhật file plugin thì bấm vào đây để có hiệu lực, không cần khởi động lại SillyTavern
   [ Mở bảng quản lý ]
```

- **Khởi động dịch vụ giao thức**: Load `server-plugin/` nằm trong thư mục extension, lắng nghe (listen) cổng `:8888`
- **Tải lại bản triển khai (Reload implementation)**: Giải phóng port trước rồi load lại, dùng để áp dụng ngay sau khi cập nhật extension (**không cần khởi động lại SillyTavern**)
- Dữ liệu hoạt động và code được tách biệt, luôn được lưu tại `<SillyTavern>/plugins/V.Adapter/data/`

Quy trình cập nhật: Bấm "Install Extension" để ghi đè extension -> Tại ngăn extension bấm "Tải lại bản triển khai".

## Cấu hình (Làm 1 lần)

Mở ngăn extension -> "Mở bảng quản lý" -> "Trung tâm cài đặt":

| Cấu hình | Giải thích |
|---|---|
| Địa chỉ API | Base url của interface sinh ảnh tương thích OpenAI (Thường kết thúc bằng `/v1`) |
| API Key | Key tuyến trên |
| Tên Model | Model sinh ảnh tuyến trên |
| Kích thước mặc định | `RộngxCao`, ví dụ `832x1216` |
| Luồng sinh ảnh | `chat_only` (Mặc định, chỉ đi qua interface chat) / `auto` (Ưu tiên tiêu chuẩn + dự phòng) / `off` (Chỉ tiêu chuẩn) / `openai` |

> **Giải thích về Cross-Domain (CORS)**: Extension chạy trong trình duyệt, kết nối trực tiếp API tuyến trên yêu cầu tuyến trên phải cho phép CORS (trả về `Access-Control-Allow-Origin`). Các reverse proxy tự dựng (như zai2api-http) thêm một dòng header CORS là được; Nếu tuyến trên không hỗ trợ CORS, interface tiêu chuẩn sẽ không thể dùng được trong trình duyệt, vui lòng đổi sang proxy trung gian hỗ trợ CORS. Khi link ảnh từ xa nhận được qua luồng chat dự phòng không hỗ trợ tải xuống cục bộ, hệ thống sẽ trích dẫn trực tiếp link gốc để hiển thị (ảnh này sẽ không được xóa watermark ở góc dưới bên phải).

## Cấu hình chia làm 2 nơi (Vị trí đặt cấu hình engine)

Cấu hình engine (API tuyến trên, Model, Kích thước mặc định, Luồng sinh ảnh) được lưu mỗi luồng 1 bản, không dùng chung:

| Luồng | Ai đang đọc | Vị trí cấu hình |
|---|---|---|
| (1) Qua cổng `:8888` | V.Canvas, Plugin NAI bên thứ 3, Client bên ngoài | **Plugin Server**: `<SillyTavern>\plugins\V.Adapter\data\`, bảo trì tại bảng điều khiển `http://127.0.0.1:8888` |
| (2) Nội bộ extension | Lệnh `/vgen` của extension này, Sinh ảnh bằng biên dịch nhân vật | Cài đặt extension của SillyTavern (`extension_settings['v-adapter']`), bảo trì tại bảng quản lý của extension này |

Nguyên nhân là do **khâu bắt buộc đi qua** của hai luồng là khác nhau, cấu hình chỉ có thể được đặt ở khâu bắt buộc của luồng đó, nếu không sẽ không có hiệu lực.

> **Art style không nằm trong số này.** Extension này đã loại bỏ preset art style: Art style do bên sử dụng tự quyết định - V.Canvas cấu hình tại trang "Prompt", các plugin sinh ảnh bên thứ ba dùng cổng vào đi kèm của nó để cấu hình. Request được chuyển tiếp qua `:8888` sẽ gửi nguyên vẹn `input` mà client gửi đến, dịch vụ này không đính kèm bất kỳ tiền tố phong cách nào.

## Ngăn extension và Bảng quản lý

**Ngăn extension** (Cài đặt, Khởi động/Dừng đều ở đây):

```
V.Adapter      v1.1.4-st.1
   Dịch vụ giao thức        Đã dừng / Đang chạy · 0.0.0.0:8888
   [ Khởi động dịch vụ giao thức ]
   [ Tải lại bản triển khai ]
   [ Mở bảng quản lý ]
```

**Tất cả các tham số đều nằm trong bảng quản lý**:

| Trang | Nội dung |
|---|---|
| Tổng quan hoạt động | Trạng thái dịch vụ, cấu hình đang có hiệu lực (Key đã che giấu), lịch sử sinh ảnh gần nhất |
| Biên dịch nhân vật | Mô tả -> Xuất ảnh |
| Lịch sử sinh ảnh | 200 mục gần nhất |
| Trung tâm cài đặt | API tuyến trên, Model, Kích thước mặc định, Luồng sinh ảnh |

Cấu hình thay đổi được lưu tức thì (persistence): Công tắc hoặc ô input khi mất focus (blur) sẽ tự động ghi; Lưu thành công sẽ thông báo "Đã lưu và có hiệu lực", lưu thất bại sẽ rollback và giải thích lý do (như Regular Expression không hợp lệ).

> Ranh giới trách nhiệm: Extension này phụ trách "Vẽ như thế nào" (Kết nối tuyến trên, Chuyển đổi giao thức, Xóa watermark, Lịch sử sinh ảnh, Cổng giao thức `:8888`). Lắng nghe AI phản hồi để tự động xuất ảnh thuộc về phạm trù "Khi nào nên vẽ, hiển thị ở đâu", do **V.Canvas** đảm nhận, extension này không cung cấp tính năng đó nữa.

## Lệnh /vgen (Có thể gán vào Quick Reply)

```
/vgen 一只橘猫趴在窗台上晒太阳          <- Mô tả, tự động biên dịch thành prompt để xuất ảnh
/vgen translate=false 1girl, ...       <- Trực tiếp coi nội dung là prompt để xuất ảnh
/vgen translate=false size=832x1216 1girl, ...
```

Kết quả xuất ảnh được chèn vào khung chat dưới dạng "Tin nhắn nhân vật + Thư viện ảnh gallery" (giống với tính năng sinh ảnh mặc định của SillyTavern), ảnh tự động lưu vào thư mục dữ liệu người dùng của SillyTavern.

## Tương ứng với bản gốc (Dịch vụ độc lập viết bằng Go)

| Bản gốc | Bản Extension |
|---|---|
| Tiến trình độc lập lắng nghe `0.0.0.0:8888` | Tích hợp sẵn trong giao diện SillyTavern, không cần port |
| Kênh NovelAI điền URL để kết nối | Không cần cấu hình, extension trực tiếp xuất ảnh vào chat |
| `POST /ai/generate-image` → ZIP | Gọi hàm nội bộ extension -> Ảnh lưu vào SillyTavern và chèn vào tin nhắn |
| Bảng quản lý `http://ip:8888/` | Ngăn extension "Mở bảng quản lý" (Giữ lại UI 1:1) |
| Lưu trữ bằng `data/settings.json` | Lưu trữ bằng Cài đặt extension của SillyTavern (Lưu theo file cấu hình của SillyTavern) |
| Bảng quản lý có mật khẩu bảo vệ server | Bảng quản lý chạy trong trình duyệt cục bộ của người dùng, tính năng mật khẩu được giữ lại nhưng không còn cần thiết nữa |

Logic cốt lõi của bản gốc được port nguyên văn: `qwen_client.go`->`lib/pipeline.js`, `translate.go`->`lib/translate.js`, `watermark.go`->`lib/watermark.js` (Thực hiện bằng Canvas, cũng làm mờ trung bình 9x9 x 6 vòng), `settings.go`->`lib/settings.js`, `genlog.go`->`lib/genlog.js`, `admin.go`+`auth.go`->`lib/virtual-api.js`. `style.go` (Preset art style) của bản gốc sẽ không được port nữa.

## License và Miễn trừ trách nhiệm

Phát hành dưới dạng **MIT License + Điều khoản bổ sung phi thương mại** (Xem `LICENSE`); Giữ nguyên bản quyền (attribution) của tác giả gốc **VILK**.

- Cấm thương mại: Nếu chưa có sự ủy quyền bằng văn bản của tác giả, không được phép bán, cho thuê, tích hợp vào các sản phẩm hoặc dịch vụ thương mại, cũng không được phép trục lợi trực tiếp hoặc gián tiếp dưới bất kỳ hình thức nào như quảng cáo, nhận donate, triển khai có thu phí, dựng hộ (hosting)...;
- Cho phép sử dụng cá nhân, học tập nghiên cứu, sao chép, sửa đổi (Sáng tác phái sinh) và lan truyền thứ cấp với mục đích phi thương mại;
- Khi sáng tác phái sinh và tái phân phối, **BẮT BUỘC phải giữ lại tên tác giả gốc (VILK)** và tuyên bố license này;
- **Chỉ dành cho mục đích học tập và nghiên cứu**, vui lòng tuân thủ điều khoản dịch vụ (TOS) của tuyến trên, người dùng tự chịu rủi ro khi sử dụng;
- Phần mềm này được cung cấp theo "Nguyên trạng" (As is), không kèm theo bất kỳ bảo đảm rõ ràng hay ngầm định nào, tác giả không chịu trách nhiệm cho bất kỳ hậu quả nào phát sinh từ việc sử dụng chương trình này.