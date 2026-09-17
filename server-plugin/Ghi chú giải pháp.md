# V.Adapter Phiên bản Server Plugin · Giải thích Thiết kế

> Tài liệu này mô tả mục tiêu thiết kế, mối quan hệ giữa các hình thái, luồng dữ liệu (data flow), phạm vi tính năng, cấu trúc thư mục,
> cài đặt và cấu hình client của V.Adapter phiên bản Server Plugin, cũng như các sự thật liên quan đến extension sinh ảnh tích hợp sẵn của SillyTavern. Là một tài liệu giải thích thiết kế/kiến trúc, các kết luận trong văn bản đều đã được chốt.

---

## Tổng quan

Đưa khả năng tương thích giao thức của V.Adapter vào chạy dưới dạng server plugin của SillyTavern: Plugin sẽ khởi động cùng SillyTavern, cách client kết nối vẫn giữ nguyên như bản gốc Go (Vẫn kết nối đến `IP:8888`).

Trước đây: Người dùng tự chạy file exe, chiếm dụng port 8888.
Sau này: Do SillyTavern host (Khi SillyTavern đóng thì plugin cũng đóng theo), không cần quản lý tiến trình (process) độc lập nữa.

---

## So sánh 3 hình thái

| | (1) Bản gốc Go (Hiện có) | (2) Extension UI Frontend | (3) Server Plugin (Thư mục này) |
|---|---|---|---|
| Hình thái | File exe độc lập | Extension frontend SillyTavern | Server plugin SillyTavern |
| Giao thức hướng ra ngoài | Giao thức NovelAI | Không hướng ra ngoài (Tự xuất ảnh) | Giao thức NovelAI |
| Cách client kết nối | URL điền `IP:8888` | Không cần kết nối | URL điền `IP:8888` (Hoàn toàn giống (1)) |
| Có phải tiến trình độc lập không | Có | Không | Không (Khởi động/đóng cùng SillyTavern) |
| Bảng quản lý | Có | Có | Có (Dùng lại giao diện nguyên bản) |

**Quyết định thiết kế: Hướng ra ngoài chỉ cung cấp bề mặt giao thức NovelAI.** Nếu plugin mới lại cung cấp thêm interface định dạng OpenAI ra bên ngoài, thì khả năng "Chuyển đổi Open->NAI" của (1) sẽ bị vô hiệu hóa. Do đó: Hướng ra ngoài chỉ nhận diện giao thức NAI, bên trong chuyển đổi thành OpenAI cho tuyến trên (upstream).

---

## Luồng dữ liệu (Data Flow)

```
Client (SillyTavern Helper / Bất kỳ client giao thức NAI nào)
   │  POST /ai/generate-image (JSON định dạng NovelAI + Bearer key)
   ▼
[Plugin V.Adapter] Lắng nghe 8888
   │  Xác thực key -> Chuyển đổi nguyên trạng input của client thành request tương thích OpenAI
   ▼
API sinh ảnh tuyến trên (Tương thích OpenAI; Interface tiêu chuẩn thất bại tự động chuyển sang interface chat để fallback)
   │  Lấy được ảnh
   ▼
Xóa watermark (Ảnh từ luồng chat) -> Đóng gói vào ZIP -> Trả về theo đường cũ
   ▼
Client nhận ZIP, giải nén và xuất ảnh
```

---

## Danh sách tính năng

Tính năng được port 1:1 từ bản Go, không bị cắt xén:

- **Bộ 3 endpoint NAI**: `/ai/generate-image` (Trả về ZIP), `/ai/user/subscription` (Test kết nối hiển thị "Free"), `/ai/encode-vibe` (404, không hỗ trợ)
- **Hai tham số mở rộng phi tiêu chuẩn** (Chuỗi truy vấn (query string), client NAI tiêu chuẩn không bị ảnh hưởng): `raw=1` Xuất thẳng byte hình ảnh không bọc vỏ ZIP; `expand=1` Đưa `input` cho model chat mở rộng thành prompt toàn cảnh hoàn chỉnh rồi mới xuất ảnh
- **Xác thực key**: `nai_key` (Mặc định `v-adapter-8888`, để trống thì key nào cũng gọi được)
- **Bộ 3 gọi API tuyến trên**: Ưu tiên decode b64_json -> Nếu không có thì download url -> Thất bại khi mang theo negative_prompt thì tự động loại bỏ rồi thử lại
- **Fallback interface chat + Ngắt mạch (Circuit breaker)**: Interface tiêu chuẩn không lấy được ảnh sẽ tự động chuyển sang interface chat; Liên tục gặp sự cố 3 lần sẽ ngắt mạch 30 phút (Đi thẳng qua chat, không chờ interface tiêu chuẩn nữa)
- **Xử lý kích thước**: Giữ nguyên giá trị do client truyền vào (clamp 64~2048); Khi tuyến trên từ chối kích thước thì lùi về kích thước mặc định và thử lại
- **Xóa watermark ở góc dưới bên phải**: Làm mờ trung bình 9x9 x 6 vòng (Chỉ áp dụng cho ảnh của luồng chat)
- **Biên dịch nhân vật**: Nhập mô tả trên bảng điều khiển để xuất ảnh trực tiếp
- **Lịch sử sinh ảnh**: 200 mục gần nhất (Thời gian/Kích thước/Luồng/Độ trễ/Kết quả/Prompt/Lỗi)
- **Bảng quản lý**: Tổng quan hoạt động / Biên dịch nhân vật / Lịch sử sinh ảnh / Trung tâm cài đặt
- **Cài đặt hot-reload + Lưu trữ persistence**: Thay đổi trên bảng điều khiển có hiệu lực ngay lập tức, khởi động lại không bị mất

> **Art style (Phong cách vẽ) không nằm trong dịch vụ này.** File `style.go` của bản gốc (14 preset art style + Tự định nghĩa) đã bị loại bỏ:
> Các request chuyển tiếp qua dịch vụ này sẽ giữ nguyên `input` do client gửi đến, không đính kèm bất kỳ tiền tố phong cách nào.
> Art style do bên sử dụng tự quyết định -- V.Canvas cấu hình tại trang "Prompt", plugin sinh ảnh bên thứ ba dùng cổng vào đi kèm của nó để cấu hình.

---

## Cấu trúc thư mục

```
server-plugin/            Khi bàn giao sẽ ném toàn bộ vào thư mục plugins/ của SillyTavern (Đổi tên thành V.Adapter)
  Ghi chú giải pháp.md     Tài liệu này
  index.js                Cổng vào plugin (Khai báo danh tính với SillyTavern, cách khởi động và thoát)
  panel.html              Bảng quản lý (Lấy từ bản Go)
  LICENSE                 Giấy phép gốc (Giữ lại tên tác giả VILK)
  lib/
    nai.js                Endpoint giao thức NovelAI (Nhận định dạng NAI, trả về ZIP)
    pipeline.js           Gọi API tuyến trên (Bộ 3 / Fallback / Ngắt mạch)
    translate.js          Biên dịch nhân vật
    watermark.js          Xóa watermark
    zip.js                Đóng gói ZIP
    settings.js           Cài đặt (Đọc/ghi data/settings.json)
    genlog.js             Lịch sử sinh ảnh
    server.js             Dịch vụ HTTP nhúng (Gộp route + CORS), đã hoàn thành
    admin.js              Endpoint quản lý (Interface bảng điều khiển + Mật khẩu), đã hoàn thành
  data/                   Sinh ra tự động lúc runtime (settings.json), không có trong file bàn giao
```

---

## Cài đặt

1. Đưa thư mục `server-plugin` vào thư mục `plugins/` của SillyTavern, đổi tên thành `V.Adapter`
2. Trong `config.yaml` của SillyTavern, đổi `enableServerPlugins` thành `true` (Mặc định là false)
3. Khởi động lại SillyTavern -> Mở trình duyệt truy cập `http://127.0.0.1:8888`, đây chính là bảng quản lý

> Nguyên nhân dùng port độc lập: Server của SillyTavern có bảo vệ CSRF, client bên thứ ba (như SillyTavern Helper) kết nối trực tiếp đến route plugin của SillyTavern sẽ bị chặn 403. Việc plugin tự lắng nghe port 8888 có thể lách giới hạn này, đồng thời giữ nguyên cách kết nối của phương án (1).

---

## Cấu hình Client

- **URL**: `http://<IP_Server>:8888` (Không cần thêm `/ai`, client sẽ tự động điền)
- **Key**: `nai_key` đã cấu hình trong bảng quản lý
- **Model**: Tùy chọn (Server sẽ bỏ qua)
- **Ảnh tham khảo vibe**: Không hỗ trợ, vui lòng không bật

---

## Quyết định Thiết kế

Các kết luận sau đã được chốt:

1. **Đặt tên**: Thư mục plugin là `V.Adapter`, tên hiển thị trên bảng điều khiển giữ nguyên là "V.Adapter".
2. **Port**: Giữ nguyên 8888. Nếu bản Go vẫn đang chạy thường trực thì sẽ xảy ra xung đột, cần phải dừng bản Go lại trước.
3. **Extension UI Frontend (`/vgen`) vẫn được giữ lại**: Hai cổng vào không xung đột với nhau, có thể tồn tại song song.
4. **Tính năng mật khẩu của bảng điều khiển vẫn được giữ lại**: Lần đầu miễn mật khẩu, có thể cài mật khẩu (Chi tiết xem hướng dẫn đăng nhập trong README của server plugin).
5. **Cấu hình engine do server này nắm giữ**: API Tuyến trên, Model, Kích thước mặc định, Luồng sinh ảnh lấy server này (`:8888`) làm nơi uy quyền (authoritative) duy nhất.
   Hình thái extension frontend của SillyTavern có một bộ cấu hình độc lập khác, chỉ tác dụng lên `/vgen` và tính năng biên dịch nhân vật của riêng nó; V.Canvas và plugin NAI bên thứ ba xuất ảnh thông qua `:8888` sẽ đọc bộ cấu hình của server này. Hai luồng có cấu hình riêng, không bị coi là trùng lặp,
   nguyên nhân là do khâu bắt buộc đi qua của hai luồng này là khác nhau.
6. **Art style không nằm trong dịch vụ này**: File `style.go` của bản gốc đã bị loại bỏ. Lý do là art style thuộc phần "Vẽ như thế nào"
   do bên sử dụng quyết định -- V.Canvas có trang "Prompt" độc lập (Chất lượng tích cực / Phủ định / Art style),
   plugin bên thứ ba cũng có cổng vào riêng; Nếu server lại lưu thêm một bản nữa, sẽ chỉ gây ra sự nhầm lẫn "đã cấu hình nhưng không có tác dụng".
   Request chuyển tiếp qua dịch vụ này sẽ giữ nguyên `input` do client gửi đến.
7. **Tự động xuất ảnh không thuộc về plugin này**: Việc lắng nghe AI phản hồi, phân tích thẻ đánh dấu, chèn ảnh tại chỗ do V.Canvas đảm nhận.
   Plugin này chỉ phụ trách "Vẽ như thế nào", không lắng nghe `MESSAGE_RECEIVED`.

---

## Sự thật và Giới hạn đã biết

Hai địa chỉ nguồn của extension "Image Generation" (Sinh ảnh) tích hợp sẵn trong SillyTavern đều bị hardcode (Nguồn NovelAI fix cứng truy cập `image.novelai.net`, nguồn OpenAI fix cứng truy cập `api.openai.com`), do đó nút cây đũa phép (magic wand) của nó không thể trỏ tới plugin này - đây không phải là do thiếu sót tính năng, mà là do SillyTavern không cung cấp interface tương ứng.

Phạm vi có thể kết nối:
- Tính năng sinh ảnh tùy chỉnh của SillyTavern Helper (Khi đã cài plugin này)
- Bất kỳ client nào hỗ trợ tùy chỉnh URL NovelAI