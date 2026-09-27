# Loader service của V.Adapter

Thư mục này được deploy vào `<SillyTavern>/plugins/V.Adapter/`, là deploy một lần duy nhất, sau này sẽ không thay đổi theo phiên bản nữa.

## Vấn đề được giải quyết

SillyTavern có hai giới hạn nền tảng:

1. Plugin server chỉ được load một lần khi khởi động tiến trình (xem điểm gọi của `src/plugin-loader.js`), các thư mục được đưa vào `plugins/` trong lúc đang chạy sẽ không được load;
2. Không cung cấp cổng cài đặt cho plugin server - không có `plugins.js` dưới `src/endpoints/`, `/api/plugins/<id>` chỉ có duy nhất một hình thái là "route do plugin đã load tự đăng ký".

Do đó tính năng "Install Extension" có thể kéo code về `data/<user>/extensions/`, nhưng lại không thể bê vào `plugins/`.

## Phương thức hoạt động

Loader không chứa business logic, chỉ load `extensions/<thư mục extension>/server-plugin/index.js` theo nhu cầu bên trong tiến trình SillyTavern:

| Endpoint | Hành vi |
|---|---|
| `GET /api/plugins/v-adapter/status` | Implementation có tồn tại không, có đang chạy không, địa chỉ listen |
| `POST /api/plugins/v-adapter/start` | Load implementation và gọi `init()` của nó |
| `POST /api/plugins/v-adapter/stop` | Gọi `exit()` của nó, giải phóng port |
| `POST /api/plugins/v-adapter/reload` | Stop trước rồi mới start, dùng để load code đã cập nhật |

Khi load sẽ thêm timestamp vào URL module để bypass cache module ESM, do đó `reload` có thể giúp code sau khi cập nhật có tác dụng ngay lập tức, không cần khởi động lại tiến trình SillyTavern.

Khi SillyTavern khởi động, loader sẽ tự động cố gắng khởi chạy service, làm cho hành vi của server đồng nhất với plugin thông thường; nếu thất bại chỉ ghi log cảnh báo, không chặn việc khởi động của SillyTavern.

## Biến môi trường

| Biến | Tác dụng |
|---|---|
| `VADAPTER_EXT_DIR` | Chỉ định thư mục extension; khi không thiết lập sẽ quét `data/<user>/extensions` dưới thư mục làm việc của tiến trình |
| `VADAPTER_AUTOSTART` | Đặt là `0` sẽ tắt tính năng tự động khởi động cùng SillyTavern, chuyển sang bật/tắt hoàn toàn thủ công |

Cấu hình chạy được cố định trong thư mục `data/` nằm dưới thư mục của loader, được inject vào implementation của server thông qua `VADAPTER_DATA_DIR` (đọc bởi `server-plugin/lib/settings.js`), do đó việc di chuyển và cập nhật extension sẽ không ảnh hưởng đến cấu hình hiện có.

## Tương thích nền tảng

Node ESM thuần túy, không có dependency bên thứ ba, sử dụng được cho cả Windows, Linux, macOS, Termux.