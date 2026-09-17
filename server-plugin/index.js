// index.js - Cổng vào server plugin SillyTavern của V.Adapter (Adapter giao thức NovelAI).
//
// Mối quan hệ với V.Adapter (Go) v1.1.4: Plugin này giao dịch vụ độc lập đó cho SillyTavern host để khởi động.
//   - Hướng ra ngoài giữ nguyên bề mặt giao thức NovelAI hoàn chỉnh (/ai/generate-image nhận định dạng NAI, trả về ZIP;
//     /ai/user/subscription; /ai/encode-vibe 404);
//   - Tích hợp sẵn port lắng nghe độc lập (mặc định 8888, có thể sửa trong bảng quản lý), dùng lại cách kết nối của dịch vụ gốc,
//     URL kênh NovelAI của client không cần sửa, đồng thời lách được bảo vệ CSRF của server SillyTavern;
//   - Không cần chạy file exe riêng lẻ, khởi động / thoát cùng SillyTavern; Bảng quản lý được giữ lại 1:1.
//
// Cài đặt: File này không được dùng trực tiếp làm plugin của SillyTavern. Nó được load theo nhu cầu bởi bootloader
//       nằm trong <SillyTavern>/plugins/V.Adapter/ (xem bootstrap/index.js ở thư mục gốc của repository), do đó bản triển khai phía server có thể được phân phối
//       và cập nhật cùng với extension. Dữ liệu runtime lưu ở data/ trong thư mục của bootloader, không liên quan đến vị trí ở đây.

import { startAdapterService, stopAdapterService, getAdapterStatus } from './lib/server.js';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'Adapter giao thức NovelAI: Đóng gói API sinh ảnh tương thích OpenAI của tuyến trên thành dịch vụ giao thức NovelAI (Port 8888, tích hợp sẵn bảng quản lý).',
};

/**
 * Khởi tạo plugin (Cổng vào server plugin của SillyTavern).
 * @param {import('express').Router} router Route được mount tại /api/plugins/v-adapter (Dịch vụ chính của plugin này đi qua port độc lập)
 */
export async function init(router) {
    await startAdapterService();

    // Tiện thể expose (phơi bày) một endpoint trạng thái read-only trên chính route của SillyTavern, thuận tiện cho việc xem tình trạng hoạt động từ phía SillyTavern
    if (router && typeof router.get === 'function') {
        router.get('/status', (req, res) => {
            res.json(getAdapterStatus());
        });
    }
}

/** Plugin thoát (Được gọi khi SillyTavern đóng): Dừng dịch vụ nhúng. */
export async function exit() {
    await stopAdapterService();
}

// Expose trạng thái hoạt động ra ngoài, để bootloader server bên trong SillyTavern truy vấn (Bootloader không phụ thuộc trực tiếp vào bản triển khai bên dưới lib/).
export { getAdapterStatus };