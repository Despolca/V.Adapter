// watermark.js — Xóa watermark nền tảng ở góc dưới bên phải của ảnh được sinh ra (ví dụ: "Qwen").
// Port 1:1 từ V.Adapter (Go) watermark.go (Sử dụng bản triển khai Canvas thay thế cho thư viện tiêu chuẩn Go image):
//
// Bối cảnh: Ảnh dự phòng sinh ra từ interface chat được trả về từ trang web chính thức của tuyến trên, góc dưới bên phải có watermark "Qwen"
// (Interface sinh ảnh tiêu chuẩn không chứa watermark này, do đó chỉ xử lý luồng chat).
// Cách làm: Thực hiện làm mờ trung bình (mean blur) nhiều lần trên một khu vực có tỷ lệ cố định ở góc dưới bên phải, xóa đi chữ của watermark và giữ lại kết cấu (texture) nền.
// Chỉ hỗ trợ PNG/JPEG; các định dạng như webp/gif/bmp sẽ được trả về nguyên trạng (Không xử lý, tránh lỗi giải mã).

// Tỷ lệ khu vực watermark ở góc dưới bên phải (So với chiều rộng và chiều cao của ảnh). Watermark của luồng chat chiếm khoảng 11% bên phải, 9% bên dưới,
// Cần để lại đủ khoảng dư (margin) để đảm bảo che phủ hoàn toàn.
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

// removeWatermark Làm mờ trung bình khu vực góc dưới bên phải của hình ảnh; định dạng không được hỗ trợ/giải mã thất bại sẽ trả về byte gốc.
// Đầu vào/Đầu ra đều là Uint8Array (Byte gốc của hình ảnh).
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
        return data; // Giải mã thất bại trả về nguyên trạng (Nhất quán với bản Go)
    }
    const w = bitmap.width, h = bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    // Lấy pixel của toàn bộ ảnh (Canvas trực tiếp cung cấp ImageData của toàn bộ ảnh, xử lý khu vực phụ ở góc dưới bên phải)
    const ctx = get2dContext(bitmap.source);
    const full = ctx.getImageData(0, 0, w, h);
    const px = full.data; // RGBA, không pre-multiplied (nhân trước alpha)

    // Làm mờ trung bình lặp (Khu vực lân cận 9x9, 6 vòng), xóa sạch hoàn toàn chữ của watermark, giữ lại kết cấu nền.
    // Mỗi vòng trước tiên sẽ tạo snapshot cho khu vực, đọc các điểm lân cận từ snapshot (clamp vào ranh giới khu vực), ghi ngược lại ảnh gốc - nhất quán với bản Go.
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

// decodeToBitmap Giải mã byte thành object có thể vẽ (Ưu tiên OffscreenCanvas, lùi về (fallback) HTMLCanvasElement).
async function decodeToBitmap(data) {
    const blob = new Blob([data]);
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return { source: canvas, width: canvas.width, height: canvas.height };
    }
    // Đường dẫn lùi về (Fallback path): HTMLImageElement + canvas thông thường
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