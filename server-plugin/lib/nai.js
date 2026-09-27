// nai.js - Endpoint tương thích giao thức NovelAI (Mặt gọi API của channel NovelAI phía client).
// Port 1:1 từ nai_handler.go của V.Adapter (Go):
//
//	POST /ai/generate-image    Tạo ảnh: Request là JSON định dạng NovelAI, phản hồi bắt buộc là ZIP (Bên trong chứa một bức ảnh)
//	GET  /ai/user/subscription Test kết nối: Trả về 200+JSON đăng ký (Client sẽ hiển thị "Kết nối bình thường:Free")
//	POST /ai/encode-vibe       Mã hóa vibe: Service này không hỗ trợ, trả về 404
//
// Khi có lỗi bắt buộc phải sử dụng mã khác 2xx + {"message": "..."}: Client sẽ lấy trường message để hiển thị cho người dùng,
// do đó thông báo lỗi phải là văn bản đọc được, không được chỉ trả về mỗi status code trần.
//
// Các tham số mở rộng phi tiêu chuẩn (Query string, không ảnh hưởng đến client NAI tiêu chuẩn):
//
//	raw=1     Phản hồi xuất trực tiếp byte của ảnh, không bọc vỏ ZIP
//	expand=1  Ưu tiên giao input cho model chat để mở rộng thành prompt hình ảnh hoàn chỉnh rồi mới xuất ảnh (Xem expandInput)

import crypto from 'node:crypto';
import { settingsGet, normalizeSizeOrDefault } from './settings.js';
import { genLog, newRecord } from './genlog.js';
import { generateImage, truncate, mimeForExt } from './pipeline.js';
import { translateCharacter } from './translate.js';
import { createZip } from './zip.js';

// naiKeyGate Xác minh Bearer key mà client mang tới (nai_key của server rỗng = không xác minh).
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
                    message: 'API Key không chính xác: Vui lòng điền Key ở channel NovelAI phía client giống với giá trị trên server (Có thể xem/sửa trong bảng quản lý)',
                    statusCode: 401,
                });
            }
        }
        return handler(req, res, ctx);
    };
}

// -- Tiện ích lấy giá trị từ body request NAI (Tương ứng với các hàm cùng tên trong nai_handler.go của bản Go) --

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

// v4BaseNegative Một số model đặt từ tiêu cực vào v4_negative_prompt.caption.base_caption.
function v4BaseNegative(params) {
    if (!params) return '';
    const v4 = params.v4_negative_prompt;
    if (!v4 || typeof v4 !== 'object') return '';
    const cap = v4.caption;
    if (!cap || typeof cap !== 'object') return '';
    return typeof cap.base_caption === 'string' ? cap.base_caption.trim() : '';
}

// defaultSizeWH Parse kích thước mặc định, dự phòng 1024x1024.
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

// promptHeaders Truyền về prompt thực tế gửi lên tuyến trên và trạng thái mở rộng vào header của phản hồi,
// cung cấp cho các bên gọi dạng bảng điều khiển (panel) hiển thị và đối chiếu. Client NAI tiêu chuẩn sẽ không đọc các header này, không ảnh hưởng đến tính tương thích của giao thức.
// Giá trị header bắt buộc phải là ASCII, do đó prompt được truyền đi dưới dạng URL encode, và sẽ bị cắt ngắn trước khi encode (để tránh vượt quá giới hạn độ dài header).
function promptHeaders(prompt, expandFlag) {
    const h = {};
    if (expandFlag) h['X-Illust-Expand'] = expandFlag;
    const s = String(prompt ?? '');
    const cut = s.length > 600 ? s.slice(0, 600) + '…' : s;
    const enc = encodeURIComponent(cut);
    if (enc) h['X-Illust-Prompt'] = enc;
    return h;
}

/**
 * expandInput Dùng model chat để mở rộng mô tả ngắn gọn thành prompt hình ảnh hoàn chỉnh (Tái sử dụng "Dịch nhân vật" của lib/translate.js).
 *
 * Mọi thất bại đều trả về { ok:false }, để bên gọi API tự lùi về việc gửi nguyên xi input, do đó hàm này không ném ra exception (throw).
 * Nguyên nhân lùi về dự phòng (fallback) sẽ được ghi vào lịch sử tạo: Request mở rộng thất bại, quá thời gian chờ, trả về rỗng, độ dài bất thường (Vượt quá 5 lần input gốc và lớn hơn 400 ký tự).
 *
 * @param {{url:string,key:string,model:string}} target API chat tuyến trên
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
            throw new Error(`Độ dài kết quả mở rộng bất thường (${expanded.length} ký tự, giới hạn trên ${limit})`);
        }

        rec.ok = true;
        rec.status = 200;
        rec.latency_ms = Date.now() - t0;
        rec.prompt = truncate(expanded, 80);
        rec.size = `${r.width}x${r.height}`;
        genLog.Add(rec);
        ctx.logf(`[Expand] Mở rộng thành công (${rec.latency_ms}ms): ${[...text].length} chữ -> ${[...expanded].length} chữ, đề xuất ${rec.size}`);
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
        ctx.logf(`[Expand] Mở rộng thất bại, lùi về gửi nguyên xi input: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

// wantsExpand Xem client có yêu cầu mở rộng input trước không (Query string có chứa `expand=1`).
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
        return sendJSON(res, 400, { message: 'Đọc body request thất bại: ' + err.message });
    }

    // Khoan dung với UTF-8 BOM từ một số client/tool
    let text = Buffer.from(raw).toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    let body;
    try {
        body = JSON.parse(text);
        // Tương tự với parse khoan dung của bản Go (Nếu struct thiếu trường thì lấy giá trị zero)
        body = body && typeof body === 'object' ? body : {};
    } catch (err) {
        return sendJSON(res, 400, { message: 'Body request không phải JSON hợp lệ: ' + err.message });
    }

    let prompt = String(body.input ?? '').trim();
    let params = body.parameters && typeof body.parameters === 'object' ? body.parameters : null;
    let neg = strFromMap(params, 'negative_prompt');
    if (!neg) neg = v4BaseNegative(params);

    // Kích thước do client chỉ định rõ (Khi bị thiếu có thể được bù đắp bằng kích thước đề xuất từ bản mở rộng, xem recSize bên dưới)
    const reqW = numFromMap(params, 'width');
    const reqH = numFromMap(params, 'height');

    const target = {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };

    // -- Tùy chọn: Mở rộng input (Kích hoạt khi query string của client có chứa `expand=1`) --
    // Giao input cho model chat để mở rộng thành prompt hình ảnh hoàn chỉnh, cung cấp cho các cổng vào kích hoạt bằng mô tả ngắn gọn như "Dịch xuất ảnh" của V.Canvas.
    // Khi thất bại, quá thời gian chờ, trả về rỗng hoặc độ dài bất thường sẽ lùi về việc gửi nguyên xi input, không cản trở quá trình tạo ảnh; Sự kiện lùi về dự phòng (fallback) sẽ được ghi vào lịch sử tạo.
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
        rec.error = 'Prompt tích cực (input) bị rỗng';
        genLog.Add(rec);
        return sendJSON(res, 400, { message: 'Prompt tích cực (input) bị rỗng, client chưa nối được từ tích cực' });
    }

    ctx.logf(`[Gen] Request tạo ảnh model=${JSON.stringify(body.model ?? '')} size=${size} steps=${numStr(params, 'steps')} seed=${numStr(params, 'seed')} Từ tiêu cực=${[...neg].length} chữ Từ tích cực=${[...prompt].length} chữ`);

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
        ctx.logf(`[Gen] Tạo ảnh thất bại (${rec.latency_ms}ms): ${gerr.message}`);
        return sendJSON(res, 502, { message: truncate(gerr.message, 500), statusCode: 502 });
    }

    rec.ok = true;
    rec.status = 200;
    rec.via = result.via;
    genLog.Add(rec);
    ctx.logf(`[Gen] Tạo ảnh thành công (${rec.latency_ms}ms via ${result.via}): ${size} ${result.ext} ${Math.floor((result.data?.length ?? 0) / 1024)}KB`);

    // Lấy byte của ảnh trước (Đã có cục bộ thì dùng luôn; Nếu chỉ có link từ xa thì server sẽ tải hộ một lần)
    let bytes = null;
    try {
        if (result.data) {
            bytes = result.data;
        } else if (result.remoteUrl) {
            // Giáng cấp cross-origin: Không lấy được byte ở cục bộ, server sẽ tải hộ một lần (Server không bị giới hạn cross-origin, thường sẽ thành công)
            const dl = await fetch(result.remoteUrl);
            if (!dl.ok) throw new Error(`Tải hộ ảnh thất bại: HTTP ${dl.status}`);
            bytes = new Uint8Array(await dl.arrayBuffer());
        } else {
            throw new Error('Kết quả tạo ảnh bị rỗng');
        }
    } catch (err) {
        ctx.logf(`[Gen] Lấy ảnh thất bại: ${err.message}`);
        return sendJSON(res, 502, { message: 'Lấy ảnh thất bại: ' + err.message });
    }

    // -- Chế độ xuất trực tiếp: Khi client tuyên bố chỉ cần ảnh (`Accept: image/*` hoặc query string chứa `raw=1`),
    //    sẽ trả thẳng luồng byte PNG/JPEG về cho nó, **không bọc vỏ ZIP** - Client nhận được là hiển thị ngay,
    //    tiết kiệm được bước giải nén. Mặc định vẫn trả về ZIP, vì đó là định dạng phản hồi của giao thức NovelAI
    //    (Trợ lý SillyTavern cũng như mọi client NAI tiêu chuẩn đều phụ thuộc vào nó). --
    if (wantsRawImage(req)) {
        const buf = Buffer.from(bytes);
        ctx.logf(`[Gen] Xuất ảnh trực tiếp (${result.ext}, ${Math.floor(buf.length / 1024)}KB, không bọc ZIP)`);
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

    // Đóng gói ZIP để trả về (Định dạng giao thức NovelAI: Sau khi client giải nén sẽ lấy file ảnh đầu tiên)
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

// wantsRawImage Xem client có muốn "ảnh không bọc vỏ" không.
//   - Trong `Accept` có chứa image/ và không chủ động xin zip  -> Xuất ảnh trực tiếp
//   - Query string có chứa `raw=1`                        -> Bắt buộc xuất trực tiếp
//   - Các trường hợp còn lại (`*/*` của trình duyệt, `application/zip` của client cũ) -> Đi theo luồng ZIP tiêu chuẩn, giữ tính tương thích giao thức
function wantsRawImage(req) {
    const url = String(req?.url ?? '');
    if (/[?&]raw=1(?:&|$)/.test(url)) return true;
    const accept = String(req?.headers?.accept ?? '').toLowerCase();
    if (!accept) return false;
    return accept.includes('image/') && !accept.includes('zip');
}

// handleSubscription GET /ai/user/subscription -> Thông tin đăng ký (Dùng cho tính năng "Test kết nối" của client).
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

// handleEncodeVibe POST /ai/encode-vibe -> Tuyên bố rõ là không hỗ trợ (404).
export function handleEncodeVibe(req, res) {
    sendJSON(res, 404, {
        message: 'Service này không hỗ trợ mã hóa ảnh tham chiếu vibe (Backend là tạo ảnh tuyến trên, không có khả năng xử lý vibe); Vui lòng tắt tính năng ảnh tham chiếu vibe trên client',
        statusCode: 404,
    });
}