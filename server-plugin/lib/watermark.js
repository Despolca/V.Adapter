// watermark.js - Xóa logo watermark của nền tảng ở góc dưới bên phải ảnh được tạo (Phiên bản Node server, implement bằng Jimp).
// Port 1:1 từ watermark.go của V.Adapter (Go) (Go dùng thư viện chuẩn image, ở đây dùng Jimp tích hợp sẵn của SillyTavern):
//   Chỉ hỗ trợ PNG/JPEG; thực hiện làm mờ trung bình (mean blur) nhiều lần cho vùng tỷ lệ cố định ở góc dưới bên phải, xóa sạch chữ logo, giữ lại texture nền;
//   Các định dạng như webp/gif/bmp sẽ trả về nguyên trạng (không xử lý, tránh lỗi decode).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Jimp do SillyTavern cung cấp (<SillyTavern>/src/jimp.js). Đường dẫn tương đối hardcode sẽ mất tác dụng khi độ sâu của thư mục này
// thay đổi trong cây thư mục, do đó dò tìm theo các đường dẫn tuyệt đối ứng viên; khi dò tìm thất bại sẽ trả về null, bên gọi sẽ trả về ảnh nguyên trạng.
let jimpPromise = null;

function loadJimp() {
    if (!jimpPromise) {
        jimpPromise = (async () => {
            const roots = [process.env.VADAPTER_ST_ROOT, process.cwd()].filter(Boolean);
            for (const root of roots) {
                const file = path.join(String(root), 'src', 'jimp.js');
                if (fs.existsSync(file)) return await import(pathToFileURL(file).href);
            }
            return null;
        })();
    }
    return jimpPromise;
}

// Tỷ lệ vùng watermark ở góc dưới bên phải (tương đối so với chiều rộng và chiều cao ảnh). Watermark của luồng chat chiếm khoảng 11% bên phải, 9% bên dưới, ở đây chừa đủ khoảng trống.
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

/**
 * Thực hiện làm mờ trung bình vùng góc dưới bên phải ảnh; định dạng không hỗ trợ / decode thất bại sẽ trả về byte gốc.
 * @param {Uint8Array} data Byte của ảnh
 * @param {string} ext Đuôi file (png/jpg/jpeg/webp/gif/bmp)
 * @returns {Promise<Uint8Array>} Byte sau khi xử lý (hoặc byte gốc)
 */
export async function removeWatermark(data, ext) {
    let isJPG = false;
    if (ext === 'png') {
        // png
    } else if (ext === 'jpg' || ext === 'jpeg') {
        isJPG = true;
    } else {
        return data;
    }

    const jimp = await loadJimp();
    if (!jimp) return data; // Khi Jimp tích hợp sẵn của SillyTavern không khả dụng thì bỏ qua xử lý, không ảnh hưởng đến việc tạo ảnh

    let img;
    try {
        img = await jimp.default.fromBuffer(Buffer.from(data));
    } catch {
        return data; // Decode thất bại thì trả về nguyên trạng (Giống hệt bản Go)
    }

    const w = img.bitmap.width, h = img.bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    const px = img.bitmap.data; // RGBA

    // Lặp lại làm mờ trung bình (mean blur) (Vùng lân cận 9x9, 6 vòng), san phẳng hoàn toàn chữ logo, giữ lại texture nền.
    for (let iter = 0; iter < 6; iter++) {
        const snap = Buffer.from(px); // Snapshot (Đọc lân cận từ snapshot, tránh nhiễu chéo trong cùng một vòng)
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                let r = 0, g = 0, b = 0, a = 0, n = 0;
                for (let dy = -4; dy <= 4; dy++) {
                    let ny = y + dy;
                    if (ny < y0) ny = y0; else if (ny >= y1) ny = y1 - 1;
                    for (let dx = -4; dx <= 4; dx++) {
                        let nx = x + dx;
                        if (nx < x0) nx = x0; else if (nx >= x1) nx = x1 - 1;
                        const idx = (ny * w + nx) * 4;
                        r += snap[idx];
                        g += snap[idx + 1];
                        b += snap[idx + 2];
                        a += snap[idx + 3];
                        n++;
                    }
                }
                const o = (y * w + x) * 4;
                px[o] = Math.round(r / n);
                px[o + 1] = Math.round(g / n);
                px[o + 2] = Math.round(b / n);
                px[o + 3] = Math.round(a / n);
            }
        }
    }

    try {
        const out = isJPG
            ? await img.getBuffer(jimp.JimpMime.jpeg, { quality: 90 })
            : await img.getBuffer(jimp.JimpMime.png);
        return new Uint8Array(out);
    } catch {
        return data;
    }
}