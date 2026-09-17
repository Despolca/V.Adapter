// nai.js — Các endpoint tương thích giao thức NovelAI (Bề mặt gọi (call surface) cho kênh NovelAI của client).
// Port 1:1 từ V.Adapter (Go) nai_handler.go:
//
//  POST /ai/generate-image    Sinh ảnh: Request là JSON định dạng NovelAI, response bắt buộc phải là ZIP (Bên trong chứa một bức ảnh)
//  GET  /ai/user/subscription Test kết nối: Trả về 200 + JSON gói đăng ký (Client hiển thị "Kết nối bình thường: Free")
//  POST /ai/encode-vibe       Mã hóa vibe: Dịch vụ này không hỗ trợ, trả về 404
//
// Lỗi thống nhất sử dụng non-2xx + {"message": "..."}: Client sẽ lấy trường message để hiển thị cho người dùng,
// do đó thông báo lỗi bắt buộc phải là văn bản có thể đọc được (readable text), không được chỉ là mã trạng thái (status code) trần trụi.
//
// Các tham số mở rộng phi tiêu chuẩn (Tham số truy vấn (query string), không ảnh hưởng đến client NAI tiêu chuẩn):
//
//  raw=1     Response xuất thẳng byte của hình ảnh, không bọc vỏ ZIP
//  expand=1  Đưa input cho model chat để mở rộng thành prompt toàn cảnh hoàn chỉnh rồi mới xuất ảnh (Xem expandInput)

import crypto from 'node:crypto';
import { settingsGet, normalizeSizeOrDefault } from './settings.js';
import { genLog, newRecord } from './genlog.js';
import { generateImage, truncate, mimeForExt } from './pipeline.js';
import { translateCharacter } from './translate.js';
import { createZip } from './zip.js';

// naiKeyGate Xác thực Bearer key do client mang đến (nai_key của server trống = Không xác thực).
export function naiKeyGate(handler) {
    return async (req, res, ctx) => {
        const want = settingsGet.naiKey();
        if (want !== '') {
            const auth = String(req.headers['authorization'] ?? '');
            let got = auth.replace(/^Bearer\s+/i, '').trim();
            const a = Buffer.from(got);
            const b = Buffer.from(want);
            const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
            if (!ok) {
                return sendJSON(res, 401, {
                    message: 'API Key không chính xác: Vui lòng điền Key trên kênh NovelAI của client cho khớp với giá trị của server (Có thể xem/sửa tại Bảng quản lý)',
                    statusCode: 401,
                });
            }
        }
        return handler(req, res, ctx);
    };
}

// -- Công cụ tiện ích lấy giá trị từ request body NAI (Tương ứng với các hàm cùng tên trong nai_handler.go của bản Go) --

function strFromMap(m, key) {
    if (!m) return '';
    const v = m[key];
    return typeof v === 'string' ? v.trim() : '';
}

function numFromMap(m, key) {
    if (!m) return null;
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const f = parseFloat(v.trim());
        if (Number.isFinite(f)) return f;
    }
    return null;
}

function numStr(m, key) {
    const v = numFromMap(m, key);
    return v === null ? '-' : String(Math.round(v));
}

// v4BaseNegative Một số model đặt từ khóa phủ định tại v4_negative_prompt.caption.base_caption.
function v4BaseNegative(params) {
    if (!params) return '';
    const v4 = params.v4_negative_prompt;
    if (!v4 || typeof v4 !== 'object') return '';
    const cap = v4.caption;
    if (!cap || typeof cap !== 'object') return '';
    return typeof cap.base_caption === 'string' ? cap.base_caption.trim() : '';
}

// defaultSizeWH Phân tích kích thước mặc định, dự phòng (fallback) là 1024x1024.
function defaultSizeWH() {
    const s = normalizeSizeOrDefault(settingsGet.defaultSize());
    const [w, h] = s.split('x').map(v => parseInt(v, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [1024, 1024];
    return [w, h];
}

function clampInt(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

export function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

// promptHeaders Đặt prompt thực tế được gửi lên tuyến trên và trạng thái mở rộng vào response header để truyền về,
// dành cho các bên gọi (caller) thuộc loại bảng điều khiển hiển thị và đối chiếu. Client NAI tiêu chuẩn sẽ không đọc các header này, không làm ảnh hưởng đến khả năng tương thích giao thức.
// Giá trị của header bắt buộc phải là ASCII, do đó prompt được truyền đi sau khi mã hóa URL, và bị cắt ngắn trước khi mã hóa (để tránh vượt quá giới hạn độ dài header).
function promptHeaders(prompt, expandFlag) {
    const h = {};
    if (expandFlag) h['X-Illust-Expand'] = expandFlag;
    const s = String(prompt ?? '');
    const cut = s.length > 600 ? s.slice(0, 600) + '...' : s;
    const enc = encodeURIComponent(cut);
    if (enc) h['X-Illust-Prompt'] = enc;
    return h;
}

/**
 * expandInput Dùng model chat để mở rộng mô tả ngắn gọn thành prompt toàn cảnh hoàn chỉnh (Dùng chung tính năng "Biên dịch nhân vật" của lib/translate.js).
 *
 * Mọi trường hợp thất bại đều trả về { ok:false }, do bên gọi (caller) lùi về (fallback) gửi nguyên trạng, do đó hàm này không throw exception.
 * Nguyên nhân lùi về (fallback) sẽ được ghi vào lịch sử sinh ảnh: Request mở rộng thất bại, timeout, trả về rỗng, độ dài bất thường (Gấp 5 lần đầu vào gốc và lớn hơn 400 ký tự).
 *
 * @param {{url:string,key:string,model:string}} target Interface chat tuyến trên
 * @param {string} text Input gốc
 * @param {{logf:Function}} ctx
 * @returns {Promise<{ok:true,prompt:string,negative:string,size:[number,number]}|{ok:false,error:string}>}
 */
async function expandInput(target, text, ctx) {
    const rec = newRecord({
        kind: 'expand', endpoint: '/chat/completions', model: target.model,
        prompt: truncate(text, 80), size: '-',
    });
    const t0 = Date.now();
    try {
        const r = await translateCharacter(target, text);
        const expanded = String(r.prompt || r.character_prompt || r.main_prompt || '').trim();
        if (!expanded) throw new Error('Kết quả mở rộng bị rỗng');
        const limit = Math.max(400, text.length * 5);
        if (expanded.length > limit) {
            throw new Error(`Độ dài kết quả mở rộng bất thường (${expanded.length} ký tự, giới hạn là ${limit})`);
        }

        rec.ok = true;
        rec.status = 200;
        rec.latency_ms = Date.now() - t0;
        rec.prompt = truncate(expanded, 80);
        rec.size = `${r.width}x${r.height}`;
        genLog.Add(rec);
        ctx.logf(`[Expand] Mở rộng thành công (${rec.latency_ms}ms): ${[...text].length} chữ -> ${[...expanded].length} chữ, kích thước đề xuất ${rec.size}`);
        return {
            ok: true,
            prompt: expanded,
            negative: String(r.negative_prompt ?? '').trim(),
            size: [r.width, r.height],
        };
    } catch (err) {
        rec.ok = false;
        rec.status = 502;
        rec.latency_ms = Date.now() - t0;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        ctx.logf(`[Expand] Mở rộng thất bại, lùi về gửi nguyên trạng: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

// wantsExpand Client có yêu cầu mở rộng input trước không (Chuỗi truy vấn có chứa `expand=1`).
function wantsExpand(req) {
    return /[?&]expand=1(?:&|$)/.test(String(req?.url ?? ''));
}

// handleGenerateImage POST /ai/generate-image -> ZIP
export async function handleGenerateImage(req, res, ctx) {
    const start = Date.now();
    if (req.method !== 'POST') {
        return sendJSON(res, 405, { message: 'Chỉ hỗ trợ POST' });
    }

    let raw;
    try {
        raw = await ctx.readBody(32 << 20);
    } catch (err) {
        return sendJSON(res, 400, { message: 'Đọc request body thất bại: ' + err.message });
    }

    // Khoan dung với các trường hợp BOM UTF-8 do một số client/công cụ mang lại
    let text = Buffer.from(raw).toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    let body;
    try {
        body = JSON.parse(text);
        // Nhất quán với việc phân tích (parsing) khoan dung của bản Go (Struct thiếu trường sẽ mang giá trị zero)
        body = body && typeof body === 'object' ? body : {};
    } catch (err) {
        return sendJSON(res, 400, { message: 'Request body không phải là JSON hợp lệ: ' + err.message });
    }

    let prompt = String(body.input ?? '').trim();
    let params = body.parameters && typeof body.parameters === 'object' ? body.parameters : null;
    let neg = strFromMap(params, 'negative_prompt');
    if (!neg) neg = v4BaseNegative(params);

    // Kích thước do client chỉ định rõ ràng (Khi thiếu có thể dùng giá trị đề xuất từ việc mở rộng bù vào, xem recSize bên dưới)
    const reqW = numFromMap(params, 'width');
    const reqH = numFromMap(params, 'height');

    const target = {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };

    // -- Tùy chọn: Mở rộng input (Kích hoạt khi chuỗi truy vấn (query string) của client có mang `expand=1`) --
    // Giao input cho model chat để mở rộng thành prompt toàn cảnh hoàn chỉnh, dành cho các cổng vào sinh ảnh bắt nguồn từ mô tả ngắn gọn như "Biên dịch xuất ảnh" của V.Canvas.
    // Khi thất bại, timeout, trả về rỗng hoặc độ dài bất thường sẽ lùi về gửi đi nguyên trạng, không làm gián đoạn quá trình xuất ảnh; sự kiện lùi về (fallback) được ghi vào lịch sử sinh ảnh.
    let recSize = null;
    let expandFlag = '';
    if (wantsExpand(req) && prompt !== '') {
        const e = await expandInput(target, prompt, ctx);
        if (e.ok) {
            prompt = e.prompt;
            if (e.negative) neg = neg ? `${neg}, ${e.negative}` : e.negative;
            recSize = e.size;
            expandFlag = 'ok';
        } else {
            expandFlag = 'fallback';
        }
    }

    const [defW, defH] = defaultSizeWH();
    let width = defW, height = defH;
    if (reqW !== null && reqW >= 16) width = clampInt(Math.round(reqW), 64, 2048);
    else if (recSize) width = clampInt(Math.round(recSize[0]), 64, 2048);
    if (reqH !== null && reqH >= 16) height = clampInt(Math.round(reqH), 64, 2048);
    else if (recSize) height = clampInt(Math.round(recSize[1]), 64, 2048);
    const size = `${width}x${height}`;

    const rec = newRecord({
        kind: 'generate', endpoint: '/ai/generate-image', model: target.model,
        prompt: truncate(prompt, 80), size,
    });

    if (prompt === '') {
        rec.status = 400;
        rec.error = 'Từ khóa tích cực (input) bị rỗng';
        genLog.Add(rec);
        return sendJSON(res, 400, { message: 'Từ khóa tích cực (input) bị rỗng, client chưa ráp ra từ khóa tích cực' });
    }

    ctx.logf(`[Gen] Request sinh ảnh model=${JSON.stringify(body.model ?? '')} size=${size} steps=${numStr(params, 'steps')} seed=${numStr(params, 'seed')} Từ khóa phủ định=${[...neg].length} chữ Từ khóa tích cực=${[...prompt].length} chữ`);

    let result, gerr = null;
    try {
        result = await generateImage(target, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    rec.latency_ms = Date.now() - start;

    if (gerr) {
        rec.ok = false;
        rec.status = 502;
        rec.via = 'images';
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        ctx.logf(`[Gen] Sinh ảnh thất bại (${rec.latency_ms}ms): ${gerr.message}`);
        return sendJSON(res, 502, { message: truncate(gerr.message, 500), statusCode: 502 });
    }

    rec.ok = true;
    rec.status = 200;
    rec.via = result.via;
    genLog.Add(rec);
    ctx.logf(`[Gen] Sinh ảnh thành công (${rec.latency_ms}ms via ${result.via}): ${size} ${result.ext} ${Math.floor((result.data?.length ?? 0) / 1024)}KB`);

    // Lấy byte của ảnh trước (Ở local có sẵn thì dùng trực tiếp; Chỉ khi nào là link từ xa mới do server thay mặt download một lần)
    let bytes = null;
    try {
        if (result.data) {
            bytes = result.data;
        } else if (result.remoteUrl) {
            // Giáng cấp do cross-domain (CORS): Local không lấy được byte, server sẽ thay mặt download một lần (Server không bị giới hạn cross-domain, thường sẽ thành công)
            const dl = await fetch(result.remoteUrl);
            if (!dl.ok) throw new Error(`Thay mặt download ảnh thất bại: HTTP ${dl.status}`);
            bytes = new Uint8Array(await dl.arrayBuffer());
        } else {
            throw new Error('Kết quả sinh ảnh bị rỗng');
        }
    } catch (err) {
        ctx.logf(`[Gen] Lấy ảnh thất bại: ${err.message}`);
        return sendJSON(res, 502, { message: 'Lấy ảnh thất bại: ' + err.message });
    }

    // -- Chế độ xuất thẳng (Raw Mode): Khi client khai báo chỉ cần hình ảnh (`Accept: image/*` hoặc chuỗi truy vấn có mang `raw=1`),
    //    sẽ trực tiếp stream byte của PNG/JPEG trả về cho nó, **không bọc vỏ ZIP** -- Client nhận được là có thể hiển thị trực tiếp,
    //    tiết kiệm được bước giải nén (unpack). Mặc định vẫn trả về ZIP, vì đó là định dạng response của giao thức NovelAI
    //    (SillyTavern helper cũng như bất kỳ client NAI tiêu chuẩn nào đều dựa vào nó). --
    if (wantsRawImage(req)) {
        const buf = Buffer.from(bytes);
        ctx.logf(`[Gen] Xuất thẳng ảnh (${result.ext}, ${Math.floor(buf.length / 1024)}KB, chưa bọc vỏ ZIP)`);
        res.writeHead(200, {
            'Content-Type': mimeForExt(result.ext),
            'Content-Length': buf.length,
            'Content-Disposition': `inline; filename="image_0.${result.ext}"`,
            'X-Illust-Via': result.via ?? '',
            ...promptHeaders(prompt, expandFlag),
        });
        res.end(buf);
        return;
    }

    // Đóng gói thành ZIP để trả về (Định dạng giao thức NovelAI: Sau khi client giải nén sẽ lấy file ảnh đầu tiên)
    const zip = createZip('image_0.' + result.ext, bytes);

    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="image_0.zip"',
        'Content-Length': zip.length,
        'X-Illust-Via': result.via ?? '',
        ...promptHeaders(prompt, expandFlag),
    });
    res.end(zip);
}

// wantsRawImage Client có muốn "Ảnh không bọc vỏ" hay không.
//   - Trong `Accept` có image/ và không chủ động yêu cầu zip  -> Xuất thẳng ảnh
//   - Chuỗi truy vấn (query string) có mang `raw=1`            -> Ép buộc xuất thẳng
//   - Còn lại (`*/*` của trình duyệt, `application/zip` của client cũ) -> Đi qua ZIP tiêu chuẩn, giữ tương thích giao thức
function wantsRawImage(req) {
    const url = String(req?.url ?? '');
    if (/[?&]raw=1(?:&|$)/.test(url)) return true;
    const accept = String(req?.headers?.accept ?? '').toLowerCase();
    if (!accept) return false;
    return accept.includes('image/') && !accept.includes('zip');
}

// handleSubscription GET /ai/user/subscription -> Thông tin gói đăng ký (Dùng cho "Test kết nối" của client).
export function handleSubscription(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJSON(res, 405, { message: 'Chỉ hỗ trợ GET' });
    }
    sendJSON(res, 200, {
        tier: 0,
        active: true,
        subscription: { tier: 0, active: true, expiresAt: 0 },
    });
}

// handleEncodeVibe POST /ai/encode-vibe -> Khẳng định rõ là không hỗ trợ (404).
export function handleEncodeVibe(req, res) {
    sendJSON(res, 404, {
        message: 'Dịch vụ này không hỗ trợ mã hóa ảnh tham khảo vibe (Backend là sinh ảnh tuyến trên, không có năng lực vibe); Vui lòng tắt ảnh tham khảo vibe trong client',
        statusCode: 404,
    });
}