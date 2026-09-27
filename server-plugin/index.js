// index.js - Cổng vào plugin server SillyTavern của V.Adapter (Chuyển đổi giao thức NovelAI).
//
// Mối quan hệ với V.Adapter (Go) v1.1.4: Plugin này giao service độc lập đó cho SillyTavern host và khởi động.
//   - Hướng ra bên ngoài giữ nguyên toàn bộ bề mặt giao thức NovelAI (/ai/generate-image nhận định dạng NAI, trả về ZIP;
//     /ai/user/subscription; /ai/encode-vibe 404);
//   - Tích hợp sẵn port listen độc lập (mặc định 8888, có thể sửa trong bảng quản lý), kế thừa cách thức kết nối của service gốc,
//     URL channel NovelAI của client không cần chỉnh sửa, đồng thời lách được lớp bảo vệ CSRF của server SillyTavern;
//   - Không cần chạy file exe độc lập, khởi động / thoát cùng SillyTavern; bảng quản lý được giữ nguyên 1:1.
//
// Cài đặt: File này không trực tiếp được sử dụng làm plugin SillyTavern. Nó được loader nằm ở `<SillyTavern>/plugins/V.Adapter/`
//       load theo nhu cầu (xem `bootstrap/index.js` ở thư mục gốc của repository), do đó implementation của server có thể
//       phân phối và cập nhật cùng với extension. Dữ liệu chạy nằm ở thư mục `data/` của loader, không liên quan đến vị trí ở đây.

import { startAdapterService, stopAdapterService, getAdapterStatus } from './lib/server.js';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'Chuyển đổi giao thức NovelAI: Đóng gói API tạo ảnh tương thích OpenAI tuyến trên thành service giao thức NovelAI (Port 8888, tích hợp sẵn bảng quản lý).',
};

/**
 * Khởi tạo plugin (Cổng vào server plugin của SillyTavern).
 * @param {import('express').Router} router Router được mount tại /api/plugins/v-adapter (Service chính của plugin này chạy port độc lập)
 */
export async function init(router) {
    await startAdapterService();

    // Tiện thể expose một endpoint trạng thái read-only trên router riêng của SillyTavern, thuận tiện cho việc kiểm tra tình trạng hoạt động từ phía SillyTavern
    if (router && typeof router.get === 'function') {
        router.get('/status', (req, res) => {
            res.json(getAdapterStatus());
        });
    }
}

/** Thoát plugin (Được gọi khi SillyTavern đóng): Dừng service nhúng. */
export async function exit() {
    await stopAdapterService();
}

// Expose trạng thái chạy ra ngoài, cung cấp cho loader của server bên trong SillyTavern truy vấn (loader không trực tiếp phụ thuộc vào implementation dưới lib/).
export { getAdapterStatus };