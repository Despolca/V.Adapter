# Bootloader server của V.Adapter

Thư mục này được triển khai (deploy) vào `<SillyTavern>/plugins/V.Adapter/`, thuộc dạng triển khai một lần, sau đó không thay đổi theo phiên bản nữa.

## Vấn đề được giải quyết

SillyTavern tồn tại hai giới hạn nền tảng:

1. Plugin server chỉ được load một lần khi tiến trình (process) khởi động (xem điểm gọi của `src/plugin-loader.js`), các thư mục được đưa vào `plugins/` trong lúc đang chạy sẽ không được load;
2. Không cung cấp cổng vào (entry) cài đặt cho plugin server - dưới `src/endpoints/` không có `plugins.js`, `/api/plugins/<id>` chỉ có một hình thái duy nhất là "route do plugin đã load tự đăng ký".

Do đó, "Install Extension" có thể kéo code về `data/<user>/extensions/`, nhưng lại không thể dời vào `plugins/`.

## Phương thức hoạt động

Bootloader không chứa logic nghiệp vụ, chỉ load `extensions/<thư mục extension>/server-plugin/index.js` theo nhu cầu bên trong tiến trình SillyTavern:

| Endpoint | Hành vi |
|---|---|
| `GET /api/plugins/v-adapter/status` | Bản triển khai (implementation) có tồn tại hay không, có đang chạy hay không, địa chỉ lắng nghe (listen) |
| `POST /api/plugins/v-adapter/start` | Load bản triển khai và gọi `init()` của nó |
| `POST /api/plugins/v-adapter/stop` | Gọi `exit()` của nó, giải phóng port |
| `POST /api/plugins/v-adapter/reload` | `stop` trước rồi `start`, dùng để load code sau khi cập nhật |

Khi load sẽ đính kèm timestamp vào URL module để vượt qua (bypass) cache module ESM, nhờ đó `reload` có thể làm cho code sau khi cập nhật có hiệu lực ngay lập tức, mà không cần khởi động lại tiến trình SillyTavern.

Khi SillyTavern khởi động, bootloader sẽ tự động cố gắng gọi (pull up) dịch vụ, giúp hành vi của server nhất quán với các plugin thông thường; nếu thất bại chỉ ghi lại cảnh báo (warning), không cản trở việc khởi động của SillyTavern.

## Biến môi trường (Environment Variables)

| Biến | Tác dụng |
|---|---|
| `VADAPTER_EXT_DIR` | Chỉ định thư mục extension; khi chưa thiết lập sẽ quét `data/<user>/extensions` dưới thư mục làm việc của tiến trình |
| `VADAPTER_AUTOSTART` | Thiết lập là `0` sẽ tắt việc tự động khởi động cùng SillyTavern, chuyển sang khởi động/dừng hoàn toàn thủ công |

Cấu hình hoạt động được cố định tại `data/` dưới thư mục bootloader, được inject (bơm) cho bản triển khai server thông qua `VADAPTER_DATA_DIR` (do `server-plugin/lib/settings.js` đọc), do đó việc di chuyển và cập nhật extension sẽ không ảnh hưởng đến cấu hình đã có.

## Tính tương thích nền tảng

Thuần Node ESM, không có dependency bên thứ 3, đều áp dụng được cho Windows, Linux, macOS, Termux.