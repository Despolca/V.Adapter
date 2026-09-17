// virtual-api.js — Virtual route cho các endpoint quản lý (Backend để bảng điều khiển fetch).
// Port 1:1 từ logic xử lý (processor) của V.Adapter (Go) admin.go + auth.go:
// Ở bản Go, các endpoint này là route HTTP thực sự; ở bản extension chạy trong trang SillyTavern, bảng điều khiển thông qua hàm cầu nối (bridge function)
// gọi trực tiếp các processor ở đây, cấu trúc trả về ({ok, status, data}) nhất quán hoàn toàn với HTTP response gốc.
//
// Giải thích về Session: Bảng điều khiển bản extension chạy trong trình duyệt người dùng (Không có server để bảo vệ),
// /admin/auth/status luôn tương đương với trạng thái "Chưa đặt mật khẩu = Cho qua" của bản gốc; Tính năng mật khẩu
// trong trung tâm cài đặt vẫn được giữ lại bình thường (Thiết lập/Sửa đổi/Tắt đều có thể lưu).

import { settingsGet, settingsView, applySettings, normalizeSizeStr } from './settings.js';
import { genLog, genLogCap, newRecord } from './genlog.js';
import { generateImage, logf, mimeForExt, truncate, bytesToBase64 } from './pipeline.js';
import { translateCharacter, mergeNegative, translateDefaultNegative } from './translate.js';

export const version = 'v1.1.5-st.1'; // Port từ bản Go v1.1.4; -st = SillyTavern extension
const startTime = Date.now();

// panelPasswordSet / hashPassword (Tương ứng bên auth.go, giữ nguyên ngữ nghĩa tính năng)
const panelCookieName = 'v_adapter_panel';

function hashPassword(pw) {
    // Không có sha-256 đồng bộ (sync), lùi về dùng biến thể djb2 (Môi trường thuần frontend chỉ lưu trữ giữ chỗ (placeholder), không còn đảm nhận xác thực)
    let h = 5381;
    for (let i = 0; i < pw.length; i++) {
        h = ((h << 5) + h + pw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// -- Route chính (Cổng vào cầu nối của bảng điều khiển) --

// handleApi Xử lý request từ bảng điều khiển, trả về { ok, status, data }.
// path có dạng '/admin/status'; method là 'GET'|'POST'|'DELETE'; body là object đã được phân tích cú pháp (parsed) hoặc undefined.
export async function handleApi(path, method, body) {
    try {
        switch (`${method} ${path}`) {
            case 'GET /admin/auth/status':
                return json(200, { success: true, setup_required: false, locked: false });
            case 'POST /admin/auth/login':
            case 'POST /admin/auth/setup':
            case 'POST /admin/auth/logout':
                return handleAuth(method, path, body);
            case 'GET /admin/status':
                return json(200, adminStatus());
            case 'GET /admin/settings':
                return json(200, { success: true, settings: settingsView() });
            case 'POST /admin/settings':
                return handleAdminSettingsPost(body);
            case 'POST /admin/test':
                return handleAdminTest(body);
            case 'POST /admin/translate':
                return handleAdminTranslate(body);
            case 'GET /admin/logs':
            case 'DELETE /admin/logs':
                return handleAdminLogs(path, method);
            default:
                return json(404, { success: false, error: `Không tìm thấy endpoint: ${path}` });
        }
    } catch (err) {
        return json(500, { success: false, error: truncate(String(err?.message ?? err), 500) });
    }
}

function json(status, data) {
    return { ok: status >= 200 && status < 300, status, data };
}

// handleAuth Endpoint mật khẩu của bảng điều khiển (Giữ lại tính năng; Hình thái extension không khóa bảng điều khiển).
function handleAuth(method, path, body) {
    if (path === '/admin/auth/setup') {
        const password = String(body?.password ?? '').trim();
        if (!password) {
            return json(200, { success: true, closed: true });
        }
        if (password.length < 4) {
            return json(400, { success: false, error: 'Mật khẩu phải có ít nhất 4 ký tự' });
        }
        // Lưu (Hình thái extension chỉ lưu trữ, không tham gia vào việc khóa)
        try {
            const ctx = getPanelStore();
            ctx.password_hash = hashPassword(password);
            savePanelStore(ctx);
        } catch { /* Lưu thất bại cũng không block (chặn) */ }
        return json(200, { success: true });
    }
    if (path === '/admin/auth/login') {
        return json(200, { success: true });
    }
    // logout
    return json(200, { success: true });
}

function getPanelStore() {
    const v = localStorage.getItem(panelCookieName);
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}
function savePanelStore(obj) {
    localStorage.setItem(panelCookieName, JSON.stringify(obj));
}

// adminStatus GET /admin/status -> Trạng thái hoạt động + Cấu hình đã che giấu (masked) + Lịch sử gần nhất.
function adminStatus() {
    const [success, fail] = genLog.Counters();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const d = new Date(startTime);
    const pad = n => String(n).padStart(2, '0');
    return {
        status: 'ok',
        version,
        started_at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        uptime_seconds: uptimeSeconds,
        listen: 'Tích hợp (Chạy cùng SillyTavern, không cần port độc lập)',
        settings: settingsView(),
        counters: { success, fail, total: success + fail },
        recent: genLog.Snapshot(10),
    };
}

// handleAdminSettingsPost POST /admin/settings.
function handleAdminSettingsPost(body) {
    const inner = body?.settings && typeof body.settings === 'object' ? body.settings : (body ?? {});
    const [changed, notes] = applySettings(inner);
    for (const k of changed) {
        if (k === 'nai_key' && settingsGet.naiKey() !== '') {
            logf('[Settings] nai_key đã được cập nhật (Client phải đồng bộ đổi Key)');
        }
        if (k === 'qwen_key') {
            logf('[Settings] qwen_key đã được cập nhật');
        }
    }
    return json(200, { success: true, changed, notes, settings: settingsView() });
}

// targetFromSettings Snapshot cài đặt nóng trên bảng điều khiển (Dùng cho pipeline).
function targetFromSettings() {
    return {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
}

// handleAdminTest POST /admin/test -> Gọi thực tế API sinh ảnh tuyến trên 1 lần, trả về thời gian trễ (latency) / luồng (via) / ảnh xem trước (preview).
// body tùy chọn ghi đè (Không lưu vào ổ đĩa, không ảnh hưởng cấu hình live): {url, key, model, size, prompt}
async function handleAdminTest(body) {
    const toStr = v => (typeof v === 'string' ? v : '');
    const target = targetFromSettings();
    if (toStr(body?.url).trim()) target.url = toStr(body.url).trim();
    if (toStr(body?.key).trim()) target.key = toStr(body.key).trim();
    if (toStr(body?.model).trim()) target.model = toStr(body.model).trim();
    let size = settingsGet.defaultSize();
    const sizeNorm = normalizeSizeStr(toStr(body?.size).trim());
    if (sizeNorm) size = sizeNorm;
    let prompt = toStr(body?.prompt).trim();
    if (!prompt) prompt = 'Một quả táo màu đỏ đặt trên bàn gỗ, ánh sáng dịu nhẹ, nhiếp ảnh tĩnh vật, ảnh test';

    const start = Date.now();
    let res, err = null;
    try {
        res = await generateImage(target, prompt, '', size, settingsGet.chatFallback());
    } catch (e) {
        err = e;
    }
    const latency = Date.now() - start;

    const rec = newRecord({
        kind: 'test', endpoint: '/admin/test', model: target.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (err) {
        rec.status = 502;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        logf(`[Test] Test kết nối thất bại (${latency}ms): ${err.message}`);
        return json(502, { success: false, error: truncate(err.message, 500) });
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = res.via;
    genLog.Add(rec);
    logf(`[Test] Test kết nối thành công (${latency}ms via ${res.via}): ${size} ${res.ext} ${Math.floor((res.data?.length ?? 0) / 1024)}KB`);

    return json(200, {
        success: true,
        latency_ms: latency,
        model: target.model,
        size: size,
        via: res.via,
        ext: res.ext,
        bytes: res.data?.length ?? 0,
        preview: imagePreview(res),
        message: `Sinh ảnh thành công: Thời gian ${latency}ms, luồng ${res.via}`,
    });
}

// imagePreview Kết quả -> URL data xem trước (Khi giáng cấp (fallback) là URL từ xa, thẻ <img> đều có thể hiển thị).
export function imagePreview(res) {
    if (res.data) {
        return `data:${mimeForExt(res.ext)};base64,${bytesToBase64(res.data)}`;
    }
    return res.remoteUrl ?? '';
}

// handleAdminTranslate POST /admin/translate -> Biên dịch nhân vật + Trực tiếp sinh ảnh.
//
// Mục đích của tính năng này là "Dùng một câu mô tả để trực tiếp xuất ảnh", prompt sau khi biên dịch chỉ là sản phẩm trung gian (Đồng thời hiển thị ra để tham khảo/copy).
//
//  body: {
//    text     string  Mô tả (Bắt buộc; nếu đã đưa prompt thì bỏ qua biên dịch, trực tiếp dùng prompt xuất ảnh)
//    prompt   string  Tùy chọn: Trực tiếp chỉ định tổng prompt (Dùng cho "Vẽ thêm tấm nữa" trên bảng, tránh biên dịch lại làm trôi phong cách)
//    negative string  Tùy chọn: Trực tiếp chỉ định từ khóa phủ định
//    generate bool    Tùy chọn: Lập tức xuất ảnh sau khi biên dịch
//    style    bool    Tùy chọn: Áp dụng "Preset phong cách vẽ" của bảng khi xuất ảnh
//    size     string  Tùy chọn: "RộngxCao", ghi đè kích thước đề xuất từ bản biên dịch
//  }
//
// Dữ liệu data trả về là kết quả biên dịch; khi generate=true sẽ mang theo thêm preview/via/ext/bytes/latency_ms/used_size;
// Nếu biên dịch thành công nhưng xuất ảnh thất bại, status vẫn là 200, lỗi đặt trong image_error (Tránh xóa mất prompt đã lấy được).
async function handleAdminTranslate(body) {
    const req = {
        text: String(body?.text ?? ''),
        prompt: String(body?.prompt ?? ''),
        negative: String(body?.negative ?? ''),
        generate: !!body?.generate,
        size: String(body?.size ?? ''),
    };

    const res = { prompt: '', character_prompt: '', main_prompt: '', negative_prompt: '', width: 832, height: 1216, steps: 28, cfg_scale: 7.0 };
    if (req.prompt.trim()) {
        // "Vẽ thêm tấm nữa": Tiếp tục dùng prompt của lần trước, không qua biên dịch nữa
        let neg = req.negative.trim();
        if (!neg) neg = mergeNegative(translateDefaultNegative);
        res.prompt = req.prompt.trim();
        res.negative_prompt = neg;
    } else {
        try {
            const r = await translateCharacter(targetFromSettings(), req.text);
            Object.assign(res, r);
        } catch (err) {
            logf(`[Translate] Biên dịch thất bại: ${err.message}`);
            return json(502, { success: false, error: truncate(err.message, 300) });
        }
        logf(`[Translate] Biên dịch thành công: ${truncate(req.text.trim(), 40)} -> Tổng prompt ${[...res.prompt].length} chữ`);
    }

    const out = { success: true, data: res };
    if (!req.generate) {
        return json(200, out);
    }

    const target = targetFromSettings();
    let prompt = res.prompt.trim();
    if (!prompt) prompt = (res.character_prompt + ', ' + res.main_prompt).trim();
    let neg = res.negative_prompt;
    let size = `${res.width}x${res.height}`;
    const sizeNorm = normalizeSizeStr(req.size.trim());
    if (sizeNorm) size = sizeNorm;

    const start = Date.now();
    let img, gerr = null;
    try {
        img = await generateImage(target, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    const latency = Date.now() - start;
    const rec = newRecord({
        kind: 'translate', endpoint: '/admin/translate', model: target.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    out.latency_ms = latency;
    out.used_size = size;
    out.used_prompt = prompt;
    if (gerr) {
        rec.status = 502;
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        logf(`[Translate] Xuất ảnh thất bại (${latency}ms): ${gerr.message}`);
        out.image_error = truncate(gerr.message, 500);
        return json(200, out);
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    logf(`[Translate] Xuất ảnh thành công (${latency}ms via ${img.via}): ${size} ${img.ext} ${Math.floor((img.data?.length ?? 0) / 1024)}KB`);

    out.preview = imagePreview(img);
    out.via = img.via;
    out.ext = img.ext;
    out.bytes = img.data?.length ?? 0;
    out.used_negative = neg;
    return json(200, out);
}

// handleAdminLogs GET /admin/logs(?limit=N) / DELETE /admin/logs (Xóa lịch sử).
// path được cầu nối (bridge) bởi bảng điều khiển sẽ có mang theo query (Ví dụ: '/admin/logs?limit=200').
function handleAdminLogs(path, method) {
    if (method === 'DELETE') {
        genLog.Clear();
        return json(200, { success: true });
    }
    let limit = 100;
    const m = /[?&]limit=(\d+)/.exec(path);
    if (m && parseInt(m[1], 10) > 0) limit = parseInt(m[1], 10);
    const [success, fail] = genLog.Counters();
    return json(200, {
        success: true,
        logs: genLog.Snapshot(limit),
        cap: genLogCap,
        counters: { success, fail, total: success + fail },
    });
}