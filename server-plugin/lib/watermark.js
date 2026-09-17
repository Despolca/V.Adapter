// watermark.js — Xóa watermark nền tảng ở góc dưới bên phải của ảnh được sinh ra (Bản Node server-side, triển khai bằng Jimp).
// Port 1:1 từ V.Adapter (Go) watermark.go (Bản Go dùng thư viện tiêu chuẩn image, ở đây dùng Jimp tích hợp sẵn của SillyTavern):
//   Chỉ hỗ trợ PNG/JPEG; thực hiện làm mờ trung bình (mean blur) nhiều lần trên một khu vực có tỷ lệ cố định ở góc dưới bên phải, xóa sạch chữ của watermark, giữ lại kết cấu (texture) nền;
//   Các định dạng như webp/gif/bmp sẽ được trả về nguyên trạng (không xử lý, tránh lỗi giải mã).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Jimp do SillyTavern cung cấp (<SillyTavern>/src/jimp.js). Đường dẫn tương đối được hardcode sẽ mất hiệu lực khi
// độ sâu của thư mục này trong cây thư mục thay đổi, do đó sẽ thăm dò theo các đường dẫn tuyệt đối ứng viên; khi thăm dò thất bại sẽ trả về null, bên gọi (caller) sẽ trả về hình ảnh nguyên trạng.
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

// Tỷ lệ khu vực watermark ở góc dưới bên phải (so với chiều rộng và chiều cao của ảnh). Watermark của luồng chat chiếm khoảng 11% bên phải, 9% bên dưới, ở đây để lại đủ khoảng dư (margin).
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

/**
 * Làm mờ trung bình khu vực góc dưới bên phải của hình ảnh; định dạng không được hỗ trợ/giải mã thất bại sẽ trả về byte gốc.
 * @param {Uint8Array} data Byte của hình ảnh
 * @param {string} ext Đuôi mở rộng (png/jpg/jpeg/webp/gif/bmp)
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
    if (!jimp) return data; // Khi Jimp tích hợp sẵn của SillyTavern không khả dụng thì bỏ qua xử lý, không ảnh hưởng đến việc xuất ảnh

    let img;
    try {
        img = await jimp.default.fromBuffer(Buffer.from(data));
    } catch {
        return data; // Giải mã thất bại trả về nguyên trạng (Nhất quán với bản Go)
    }

    const w = img.bitmap.width, h = img.bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    const px = img.bitmap.data; // RGBA

    // Làm mờ trung bình lặp (khu vực lân cận 9x9, 6 vòng), xóa sạch hoàn toàn chữ của watermark, giữ lại kết cấu nền.
    for (let iter = 0; iter < 6; iter++) {
        const snap = Buffer.from(px); // Snapshot (Đọc các điểm lân cận từ snapshot, tránh nhiễu chéo (crosstalk) trong cùng một vòng)
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