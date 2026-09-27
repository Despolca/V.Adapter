// pipeline.js - Gọi API tạo ảnh tương thích OpenAI tuyến trên (Phiên bản tích hợp sẵn trong extension).
// Port 1:1 từ V.Adapter (Go) qwen_client.go, logic và văn bản được giữ nguyên từng chữ:
//   1. Ưu tiên response_format=b64_json, lấy data[0].b64_json để decode;
//   2. Nếu không có b64 thì lấy data[0].url để tải xuống;
//   3. Nếu request chứa negative_prompt thất bại, tự động bỏ đi và thử lại một lần;
//   4. Nếu trả về nội dung không phải ảnh (trang captcha kiểm soát rủi ro / trang lỗi HTML), sẽ đưa ra thông báo lỗi có thể đọc được, và (chế độ auto)
//      tự động chuyển sang API chat để tạo ảnh dự phòng;
//   5. Nếu tuyến trên từ chối kích thước, lùi về kích thước mặc định trong cấu hình và thử lại một lần;
//   6. API tạo ảnh tiêu chuẩn lỗi liên tục sẽ kích hoạt ngắt mạch (chạy thẳng qua chat trong 30 phút), tự động giải trừ khi đổi tuyến trên/thay đổi cài đặt.
//
// Tương thích tương đương trên môi trường trình duyệt (không thay đổi ngữ nghĩa hành vi):
//   - Cross-Origin: API tuyến trên cần cho phép trình duyệt gọi cross-origin (CORS); nếu URL ảnh không thể tải xuống do CORS,
//     trả về kết quả giáng cấp remoteUrl (ảnh vẫn dùng được trực tiếp, chỉ là không xử lý byte cục bộ và không xóa watermark).

import { removeWatermark } from './watermark.js';
import { settingsGet } from './settings.js';

// -- Loại lỗi (tương ứng với upstreamError / notImageError của Go) --

export class UpstreamError extends Error {
    constructor(statusCode, body, msg) {
        super(msg);
        this.name = 'UpstreamError';
        this.statusCode = statusCode;
        this.body = body ?? '';
    }
}

export class NotImageError extends Error {
    constructor(msg) {
        super(msg);
        this.name = 'NotImageError';
    }
}

// imageResult Kết quả tạo ảnh: byte của ảnh + đuôi file thực tế + luồng đã chạy qua.
// Khi remoteUrl tồn tại, biểu thị kết quả giáng cấp "không thể tải byte, nhưng link có thể sử dụng trực tiếp".
export class ImageResult {
    constructor(data, ext, via, remoteUrl) {
        this.data = data;      // Uint8Array | null
        this.ext = ext;        // png/jpg/webp/gif/bmp
        this.via = via;        // images / chat / images->chat dự phòng
        this.remoteUrl = remoteUrl ?? null;
    }
}

// chatImageInstruction Chỉ thị tạo ảnh qua chat.
export const chatImageInstruction = 'Vui lòng tạo trực tiếp một bức ảnh, không xuất ra văn bản thừa.';

// Trích xuất link ảnh trong phản hồi chat (Ảnh Markdown + Link trần).
const mdImageRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const bareURLRe = /https?:\/\/[^\s"'<>)\]]+/g;

// -- Ngắt mạch API tạo ảnh tiêu chuẩn (chỉ dành cho chế độ auto) --
let imagesBrokenCount = 0;
let imagesBrokenUntil = 0; // epoch ms; 0 = chưa ngắt mạch

const IMAGES_BROKEN_THRESHOLD = 3;
const IMAGES_BROKEN_COOLDOWN = 30 * 60 * 1000;

export function resetImagesBroken() {
    imagesBrokenCount = 0;
    imagesBrokenUntil = 0;
}

function imagesBroken() {
    return imagesBrokenUntil > 0 && Date.now() < imagesBrokenUntil;
}

function markImagesBroken() {
    imagesBrokenCount++;
    if (imagesBrokenCount >= IMAGES_BROKEN_THRESHOLD) {
        imagesBrokenUntil = Date.now() + IMAGES_BROKEN_COOLDOWN;
        logf(`[Upstream] API tạo ảnh tiêu chuẩn đã thất bại liên tiếp ${IMAGES_BROKEN_THRESHOLD} lần, ngắt mạch 30m0s, trong thời gian này sẽ chạy thẳng qua API chat`);
    }
}

function markImagesOK() {
    imagesBrokenCount = 0;
    imagesBrokenUntil = 0;
}

// logf log trên console của extension (việc render màu đỏ giao cho chính console).
export function logf(line) {
    console.log(`[V.Adapter] ${line}`);
}

// -- Cổng vào chính dành cho bên ngoài --

// target Các tham số tuyến trên cần cho một lần gọi (snapshot cài đặt nóng từ bảng điều khiển / giá trị ghi đè khi test).
// Đồng thời cung cấp cho /admin/test, /admin/translate của admin.js sử dụng (Tương ứng với targetFromSettings của qwen_client.go bản Go).
export function targetFromSettings() {
    return {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
}

// generateImage Tạo một bức ảnh theo chế độ (auto/off/chat_only/openai).
export async function generateImage(target, prompt, neg, size, mode) {
    mode = normalizeChatFallbackMode(mode);
    if (mode === 'chat_only') {
        try {
            return await generateViaChat(target, prompt, neg);
        } catch (err) {
            // chat_only hiện đang là luồng mặc định. Nếu tuyến trên thực chất là model tạo ảnh (API chat không thể vẽ ảnh),
            // chỗ này phải ghi rõ cách giải quyết, tránh bị đánh giá nhầm là lỗi plugin.
            throw new Error(`${err.message}; Luồng tạo ảnh hiện tại là "Chỉ API chat" (chat_only). ` +
                'Nếu tuyến trên là model tạo ảnh (như qwen-image / dall-e-3), vui lòng đổi luồng tạo ảnh thành auto hoặc off trong "Trung tâm cài đặt"');
        }
    }
    if (mode === 'openai') {
        // Chế độ openai: API tạo ảnh chuẩn OpenAI thuần túy (/images/generations),
        // hướng tới các loại API tương thích OpenAI (chính thức/bên thứ ba), không làm dự phòng chat qua reverse proxy; thất bại sẽ báo lỗi ngay.
        const res = await generateViaImages(target, prompt, neg, size);
        markImagesOK();
        return res;
    }
    if (mode === 'auto' && imagesBroken()) {
        logf('[Upstream] API tạo ảnh tiêu chuẩn đang trong thời gian ngắt mạch, chạy thẳng qua API chat');
        const res = await generateViaChat(target, prompt, neg);
        res.via = 'chat (Ngắt mạch API tiêu chuẩn)';
        return res;
    }
    let res;
    try {
        res = await generateViaImages(target, prompt, neg, size);
        markImagesOK();
        return res;
    } catch (err) {
        if (mode === 'auto' && shouldTryChat(err)) {
            if (imagesEndpointUnavailable(err)) {
                markImagesBroken();
            }
            logf(`[Upstream] Tạo ảnh tiêu chuẩn không lấy được ảnh (${err.message}), chuyển sang API chat dự phòng...`);
            try {
                const res2 = await generateViaChat(target, prompt, neg);
                res2.via = 'images->chat dự phòng';
                return res2;
            } catch (err2) {
                throw new Error(`${err.message}; Tạo ảnh dự phòng qua chat cũng thất bại: ${err2.message}`);
            }
        }
        throw err;
    }
}

// normalizeChatFallbackMode (Tương ứng với normalizeChatFallback của Go, dùng chung ngữ nghĩa cho pipeline và settings).
export function normalizeChatFallbackMode(s) {
    switch (String(s ?? '').toLowerCase().trim()) {
        case 'off': return 'off';
        case 'chat_only': return 'chat_only';
        case 'openai': return 'openai';
        default: return 'auto';
    }
}

// generateViaImages API tạo ảnh tiêu chuẩn, thử theo tổ hợp "Lùi kích thước + Giáng cấp negative_prompt".
async function generateViaImages(target, prompt, neg, size) {
    if (!size) size = target.defaultSize;
    const queue = [{ size, neg }];
    const tried = new Set();
    let lastErr = null;
    // Giới hạn 6 lần (Sau khi khử trùng lặp thực tế tối đa 4 tổ hợp: Kích thước gốc/Kích thước mặc định x Có/Không có negative_prompt)
    for (let i = 0; i < queue.length && i < 6; i++) {
        const a = queue[i];
        const key = a.size + '|' + a.neg;
        if (tried.has(key)) continue;
        tried.add(key);
        try {
            return await imagesOnce(target, prompt, a.neg, a.size);
        } catch (err) {
            lastErr = err;
            if (err instanceof UpstreamError) {
                // Kích thước không được chấp nhận: lùi về kích thước mặc định trong cấu hình và thử lại
                if (sizeRelated(err.body) && a.size !== target.defaultSize && target.defaultSize) {
                    logf(`[Upstream] Kích thước ${a.size} bị tuyến trên từ chối, lùi về kích thước mặc định ${target.defaultSize} và thử lại`);
                    queue.push({ size: target.defaultSize, neg: a.neg });
                }
                // negative_prompt là trường không tiêu chuẩn: thất bại sẽ bỏ đi và thử lại
                if (a.neg) {
                    logf(`[Upstream] Request chứa negative_prompt thất bại (HTTP ${err.statusCode}), bỏ trường này và thử lại`);
                    queue.push({ size: a.size, neg: '' });
                }
            }
        }
    }
    throw lastErr ?? new Error('Request tạo ảnh tuyến trên thất bại');
}

// imagesOnce Request tạo ảnh tiêu chuẩn đơn lẻ (Một lần thử).
async function imagesOnce(target, prompt, neg, size) {
    const body = {
        model: target.model,
        prompt: prompt,
        size: size,
        n: 1,
        response_format: 'b64_json',
    };
    if (neg) body.negative_prompt = neg;

    const { raw, status } = await postJSON(target, '/images/generations', body, 300 * 1000);
    if (status < 200 || status >= 300) {
        throw new UpstreamError(status, raw, `API tạo ảnh tuyến trên trả về HTTP ${status}: ${snippet(raw, 300)}`);
    }
    let resp;
    try { resp = JSON.parse(raw); } catch {
        throw new NotImageError(`Phản hồi của API tạo ảnh tuyến trên không phải là JSON hợp lệ (Đoạn trích: ${snippet(raw, 150)})`);
    }
    if (!resp.data || !resp.data.length) {
        throw new NotImageError(`Trong phản hồi của API tạo ảnh tuyến trên không có data[0] (Đoạn trích: ${snippet(raw, 150)})`);
    }
    const item = resp.data[0];
    const b64 = String(item.b64_json ?? '').trim();
    if (b64) {
        let b = b64;
        if (b.startsWith('data:')) {
            const i = b.indexOf(',');
            if (i >= 0) b = b.slice(i + 1);
        }
        let bytes = null;
        try { bytes = b64ToBytes(b); } catch { bytes = null; }
        if (bytes) return decodeImageBytes(bytes, 'images');
        throw new NotImageError('b64_json do API tạo ảnh tuyến trên trả về không thể decode base64');
    }
    const u = String(item.url ?? '').trim();
    if (u) {
        const dl = await downloadImage(u);
        if (dl.bytes) return decodeImageBytes(dl.bytes, 'images');
        // Tải xuống thất bại do CORS: Trả về kết quả giáng cấp là link từ xa (ảnh có thể dùng trực tiếp)
        return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'images', dl.url);
    }
    throw new NotImageError('Trong phản hồi API không có b64_json cũng không có url, vui lòng kiểm tra service tương thích');
}

// generateViaChat Tạo ảnh qua API chat dự phòng.
async function generateViaChat(target, prompt, neg) {
    let instruction = chatImageInstruction;
    if (neg) instruction += '\nVui lòng tuyệt đối tránh các yếu tố sau: ' + neg;
    const messages = [{ role: 'user', content: instruction + '\n' + prompt }];

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
            logf('[Upstream] API chat bị lỗi chớp nhoáng, thử lại sau 6s...');
            await delay(6000);
        }
        const body = { model: target.model, messages: messages, max_tokens: 2000 };
        let raw, status, err;
        try {
            ({ raw, status } = await postJSON(target, '/chat/completions', body, 320 * 1000));
        } catch (e) {
            err = e;
        }
        if (err) {
            lastErr = err;
            if (transientErr(err)) continue;
            throw err;
        }
        if (status < 200 || status >= 300) {
            const ue = new UpstreamError(status, raw, `API chat tuyến trên trả về HTTP ${status}: ${snippet(raw, 300)}`);
            lastErr = ue;
            if (transientErr(ue)) continue;
            throw ue;
        }
        let cr;
        try { cr = JSON.parse(raw); } catch { cr = null; }
        if (!cr || !cr.choices || !cr.choices.length) {
            throw new NotImageError(`Phản hồi của API chat tuyến trên thiếu choices (Đoạn trích: ${snippet(raw, 150)})`);
        }
        const content = cr.choices[0].message?.content ?? '';
        const { urls, seenPunish } = extractImageURLs(content);
        if (!urls.length) {
            throw new NotImageError(noImageURLDiag(content, seenPunish));
        }
        for (const u of urls) {
            const dl = await downloadImage(u);
            if (dl.bytes) {
                const res = decodeImageBytes(dl.bytes, 'chat');
                // Luồng chat từ web chính thức tuyến trên có ảnh kèm logo "Qwen" ở góc dưới bên phải, tiến hành xóa đồng loạt
                res.data = await removeWatermark(res.data, res.ext);
                return res;
            }
            if (dl.remoteUrl) {
                // Tải xuống thất bại do CORS: Giáng cấp thành link từ xa (bỏ qua xóa watermark, ảnh có thể hiển thị trực tiếp)
                logf('[Upstream] Ảnh không thể xử lý cục bộ do giới hạn cross-origin, sử dụng trực tiếp link gốc');
                return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'chat', dl.remoteUrl);
            }
            lastErr = dl.error ?? new Error('Tải ảnh thất bại');
        }
        throw new NotImageError('Tất cả link ảnh trả về từ tạo ảnh qua chat đều không thể tải xuống hoặc parse');
    }
    throw lastErr ?? new Error('Request tạo ảnh qua chat thất bại');
}

// -- HTTP Cơ bản --

// postJSON POST một đoạn JSON tới target.url+path, trả về text của body phản hồi và HTTP status code.
// Cũng được tái sử dụng cho translate.js (Cùng một kênh tuyến trên).
export async function postJSON(target, path, body, timeoutMs) {
    const base = String(target.url ?? '').trim().replace(/\/+$/, '');
    if (!base) {
        throw new Error('Chưa cấu hình địa chỉ API tuyến trên: Vui lòng điền qwen_url trong "Trung tâm cài đặt" của bảng điều khiển');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(base + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (String(target.key ?? '').trim() || 'EMPTY'), // Placeholder cho service không cần xác thực cục bộ
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`API tuyến trên quá thời gian chờ (${base + path} không phản hồi trong ${formatDuration(timeoutMs)})`);
        }
        throw new Error(`Yêu cầu API tuyến trên thất bại (${base + path}): ${err.message} (Nếu là lỗi cross-origin, vui lòng để API tuyến trên cho phép trình duyệt truy cập CORS)`);
    } finally {
        clearTimeout(timer);
    }
    const raw = await resp.text();
    return { raw, status: resp.status };
}

// downloadImage Tải xuống data[0].url hoặc link ảnh trong phản hồi chat.
// Trả về { bytes } (Thành công) / { remoteUrl } (Giáng cấp CORS) / { error } (Thất bại).
async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180 * 1000);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (resp.status !== 200) {
            return { error: new Error(`Tải ảnh đã tạo thất bại: HTTP ${resp.status} (${url})`) };
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        return { bytes: buf };
    } catch (err) {
        // Phần lớn là do giới hạn CORS của trình duyệt: Trả về link từ xa có thể dùng trực tiếp để giáng cấp
        if (controller.signal.aborted) {
            return { error: new Error(`Tải ảnh đã tạo thất bại: Quá thời gian chờ (${url})`) };
        }
        return { remoteUrl: url };
    } finally {
        clearTimeout(timer);
    }
}

// -- Nhận diện và chẩn đoán ảnh --

// sniffImage Nhận diện định dạng ảnh dựa trên magic number, trả về đuôi file (png/jpg/webp/gif/bmp).
export function sniffImage(b) {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'png';
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
    if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
    if (b.length >= 6) {
        const six = String.fromCharCode(...b.slice(0, 6));
        if (six === 'GIF87a' || six === 'GIF89a') return 'gif';
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
    return null;
}

function sniffExtFromUrl(u) {
    const m = /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.exec(u);
    if (!m) return null;
    return m[1].toLowerCase().replace('jpeg', 'jpg');
}

// decodeImageBytes Xác minh byte thực sự là ảnh; nếu không thì đưa ra chẩn đoán có thể đọc được.
export function decodeImageBytes(raw, via) {
    const ext = sniffImage(raw);
    if (!ext) throw new NotImageError(nonImageDiag(raw));
    return new ImageResult(raw, ext, via, null);
}

// nonImageDiag Nội dung chẩn đoán cho nội dung không phải ảnh (Văn bản dễ hiểu hướng tới người dùng).
function nonImageDiag(raw) {
    const head = raw.slice(0, Math.min(raw.length, 2048));
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(head); } catch { text = ''; }
    const low = text.trimStart().toLowerCase();
    if (low.startsWith('<!doctype') || low.startsWith('<html') || (low.length > 0 && low[0] === '<')) {
        return 'API trả về không phải là ảnh, mà là một trang web/HTML (Nguyên nhân phổ biến: trang captcha kiểm soát rủi ro của service trung gian, trang hết hạn đăng nhập hoặc trang lỗi 502, vui lòng kiểm tra xem bản thân service API đó có khả năng tạo ảnh không)';
    }
    if (low.includes('error') || low.includes('exception')) {
        return `API trả về không phải là ảnh, nghi ngờ là thông báo lỗi: ${JSON.stringify(snippet(text, 200))}`;
    }
    return 'Dữ liệu API trả về không thể parse thành ảnh (Content-Type bất thường, vui lòng kiểm tra service API)';
}

// extractImageURLs Trích xuất link ảnh từ phản hồi chat và nhận diện trang punish kiểm soát rủi ro.
function extractImageURLs(content) {
    const all = [];
    for (const m of content.matchAll(mdImageRe)) all.push(m[1]);
    for (const m of content.matchAll(bareURLRe)) all.push(m[0]);

    const urls = [];
    const seen = new Set();
    let seenPunish = false;
    for (const u of all) {
        if (seen.has(u)) continue;
        seen.add(u);
        const lu = u.toLowerCase();
        if (lu.includes('punish') || lu.includes('captcha')) {
            seenPunish = true;
            continue;
        }
        urls.push(u);
    }
    return { urls, seenPunish };
}

// noImageURLDiag Chẩn đoán chung khi chat không lấy được link ảnh.
function noImageURLDiag(content, seenPunish) {
    if (seenPunish) {
        return 'Tuyến trên bị hệ thống kiểm soát rủi ro chặn (trả về trang xác thực punish), quá trình tạo ảnh không sinh ra ảnh. ' +
            'Kiểm soát rủi ro thường tự động giải trừ sau vài phút: Vui lòng đợi một lát rồi thử lại, làm chậm nhịp độ tạo ảnh liên tục, hoặc đổi từ khóa mô tả khác rồi thử lại';
    }
    let sn = truncate(content.trim(), 150);
    if (!sn) sn = '(Model không trả về bất kỳ link ảnh nào)';
    for (const m of ['无法生成', '无法直接生成', '不能生成', '无法创建',
        '内容政策', '安全规范', '不适宜', '色情', '裸露', '违反']) {
        if (content.includes(m)) {
            return 'Model tạo ảnh tuyến trên đã từ chối request lần này dựa trên chính sách an toàn nội dung của nó, model phản hồi: ' + sn +
                '. Đây là chính sách của service tuyến trên chứ không phải lỗi của tool cục bộ; có thể điều chỉnh mô tả để né tránh các yếu tố nhạy cảm rồi thử lại';
        }
    }
    return 'Tạo ảnh qua chat không trả về link ảnh, model phản hồi: ' + sn;
}

// -- Tiện ích đánh giá --

// imagesEndpointUnavailable Đánh giá "API tạo ảnh tiêu chuẩn hiện không khả dụng" - Căn cứ để đếm ngắt mạch.
//
// Khớp với giao kèo lỗi của gateway tuyến trên (qwen2api), ưu tiên xem các trường cấu trúc, không đoán mò văn bản:
//   code:  upstream_waf_challenge (Tuyến trên bị Aliyun WAF chặn, trả về trang captcha)
//          quota_limit / upstream_business_error / upstream_unavailable
//   type:  rate_limit_error (429) / server_error (5xx)
// Dự phòng bằng text chỉ nhận diện các từ khóa đặc trưng WAF mà gateway tự sử dụng (Cùng nguồn với WAF_BODY_RE trong chat.image.video.js của nó).
const IMAGES_BROKEN_CODES = new Set([
    'upstream_waf_challenge',
    'quota_limit',
    'upstream_business_error',
    'upstream_unavailable',
]);
const IMAGES_WAF_TEXT_RE = /upstream_waf_challenge|aliyun_waf|AliyunCaptcha|FAIL_SYS_USER_VALIDATE|RGV587|阿里云\s*WAF|captcha|验证码/i;

function imagesEndpointUnavailable(err) {
    if (!(err instanceof UpstreamError)) return false;
    const status = Number(err.statusCode) || 0;
    if (status === 429 || status >= 500) return true;

    const raw = String(err.body ?? '');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* Body phản hồi không phải JSON, chạy dự phòng bằng text */ }
    const e = (parsed && (parsed.error || parsed)) || null;
    const code = String(e?.code ?? '').trim();
    const type = String(e?.type ?? '').trim();
    if (code && IMAGES_BROKEN_CODES.has(code)) return true;
    if (type === 'rate_limit_error' || type === 'server_error') return true;

    return IMAGES_WAF_TEXT_RE.test(raw.slice(0, 4096));
}

// shouldTryChat Sau khi tạo ảnh tiêu chuẩn thất bại có đáng để chuyển sang chat dự phòng không (Logic đánh giá giống hệt bản Go).
function shouldTryChat(err) {
    if (err instanceof NotImageError) return true;
    if (err instanceof UpstreamError) {
        if ([401, 402, 403].includes(err.statusCode)) return false;
        return true;
    }
    return false;
}

// transientErr Đánh giá lỗi chớp nhoáng.
function transientErr(err) {
    if (!err) return false;
    const msg = String(err.message ?? err).toLowerCase();
    return msg.includes('502') || msg.includes('429') ||
        msg.includes('timeout') || msg.includes('quá thời gian chờ') || msg.includes('超时') ||
        msg.includes('upstream');
}

// sizeRelated Lỗi tuyến trên có liên quan đến kích thước không (Dùng để lùi về kích thước mặc định và thử lại).
function sizeRelated(body) {
    const low = String(body ?? '').toLowerCase();
    return ['size', 'resolution', 'width', 'height', '尺寸', '分辨率'].some(k => low.includes(k));
}

// snippet Nén khoảng trắng và cắt ngắn, dùng để kèm theo một đoạn nhỏ phản hồi tuyến trên vào thông báo lỗi.
function snippet(raw, n) {
    const s = String(raw ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!s) return '(Phản hồi trống)';
    return truncate(s, n);
}

// truncate Cắt ngắn theo số lượng ký tự (An toàn với tiếng Trung), nếu quá dài thì thêm ...
export function truncate(s, n) {
    s = String(s ?? '');
    const r = [...s];
    if (r.length <= n) return s;
    return r.slice(0, n).join('') + '…';
}

// mimeForExt Đuôi file ảnh -> MIME (Dùng cho preview test trên bảng điều khiển).
export function mimeForExt(ext) {
    switch (String(ext ?? '').toLowerCase()) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        default: return 'image/png';
    }
}

// -- Tiện ích chung --

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
    return `${s}s`;
}