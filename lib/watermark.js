// watermark.js - Xóa logo watermark của nền tảng ở góc dưới bên phải ảnh được tạo (như "Qwen").
// Port 1:1 từ watermark.go của V.Adapter (Go) (Dùng Canvas implement thay thế cho thư viện chuẩn image của Go):
//
// Bối cảnh: API chat tạo ảnh dự phòng trả về ảnh được tạo từ web chính thức tuyến trên, góc dưới bên phải có watermark "Qwen"
// (API tạo ảnh tiêu chuẩn không có watermark này, nên chỉ xử lý luồng chat).
// Cách làm: Thực hiện làm mờ trung bình (mean blur) nhiều lần cho vùng tỷ lệ cố định ở góc dưới bên phải, xóa sạch chữ logo, giữ lại texture nền.
// Chỉ hỗ trợ PNG/JPEG; các định dạng như webp/gif/bmp sẽ được trả về nguyên trạng (không xử lý, tránh lỗi decode).

// Tỷ lệ vùng watermark ở góc dưới bên phải (tương đối so với chiều rộng và chiều cao ảnh). Watermark của luồng chat chiếm khoảng 11% bên phải, 9% bên dưới,
// Chừa đủ khoảng trống (margin) để đảm bảo bao phủ hoàn toàn.
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

// removeWatermark Thực hiện làm mờ trung bình vùng góc dưới bên phải ảnh; định dạng không hỗ trợ / decode thất bại sẽ trả về byte gốc.
// Input/Output đều là Uint8Array (Byte gốc của ảnh).
export async function removeWatermark(data, ext) {
    let isJPG = false;
    if (ext === 'png') {
        // png
    } else if (ext === 'jpg' || ext === 'jpeg') {
        isJPG = true;
    } else {
        return data;
    }

    let bitmap;
    try {
        bitmap = await decodeToBitmap(data);
    } catch {
        return data; // Decode thất bại thì trả về nguyên trạng (Giống hệt bản Go)
    }
    const w = bitmap.width, h = bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    // Lấy pixel của toàn bộ ảnh (Canvas trực tiếp trả về ImageData của toàn bộ ảnh, xử lý vùng phụ ở góc dưới bên phải)
    const ctx = get2dContext(bitmap.source);
    const full = ctx.getImageData(0, 0, w, h);
    const px = full.data; // RGBA, không pre-multiplied (non-premultiplied)

    // Lặp lại làm mờ trung bình (mean blur) (Vùng lân cận 9x9, 6 vòng), san phẳng hoàn toàn chữ logo, giữ lại texture nền.
    // Mỗi vòng trước tiên chụp snapshot cho vùng đó, đọc lân cận từ snapshot (clamp đến ranh giới vùng), ghi lại vào ảnh gốc - giống hệt bản Go.
    for (let iter = 0; iter < 6; iter++) {
        const snap = new Uint8ClampedArray(px); // Snapshot toàn bộ ảnh
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
                px[o] = r / n;
                px[o + 1] = g / n;
                px[o + 2] = b / n;
                px[o + 3] = a / n;
            }
        }
    }
    ctx.putImageData(full, 0, 0);

    const blob = await canvasToBlob(bitmap.source, isJPG);
    const buf = new Uint8Array(await blob.arrayBuffer());
    return buf;
}

// decodeToBitmap Decode byte thành object có thể vẽ (Ưu tiên OffscreenCanvas, lùi về HTMLCanvasElement nếu cần).
async function decodeToBitmap(data) {
    const blob = new Blob([data]);
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return { source: canvas, width: canvas.width, height: canvas.height };
    }
    // Đường dẫn lùi (Fallback path): HTMLImageElement + canvas thông thường
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('image decode failed'));
            im.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return { source: canvas, width: canvas.width, height: canvas.height };
    } finally {
        URL.revokeObjectURL(url);
    }
}

function get2dContext(source) {
    return source.getContext('2d', { willReadFrequently: true });
}

async function canvasToBlob(source, isJPG) {
    if (typeof OffscreenCanvas === 'function' && source instanceof OffscreenCanvas) {
        return source.convertToBlob(isJPG ? { type: 'image/jpeg', quality: 0.90 } : { type: 'image/png' });
    }
    return new Promise((resolve, reject) => {
        source.toBlob(
            blob => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))),
            isJPG ? 'image/jpeg' : 'image/png',
            isJPG ? 0.90 : undefined,
        );
    });
}