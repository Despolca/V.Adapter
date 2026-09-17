// pipeline.js — Gọi interface sinh ảnh tương thích OpenAI của tuyến trên (Phiên bản tích hợp trong extension).
// Port 1:1 từ V.Adapter (Go) qwen_client.go, logic và văn bản được giữ nguyên từng chữ:
//   1. Ưu tiên response_format=b64_json lấy data[0].b64_json để decode;
//   2. Nếu không có b64 thì lấy data[0].url để download;
//   3. Khi request có kèm negative_prompt bị thất bại, tự động bỏ đi và thử lại 1 lần;
//   4. Khi trả về nội dung không phải hình ảnh (Trang mã xác nhận kiểm soát rủi ro / Trang lỗi HTML) sẽ đưa ra lỗi có thể đọc được, và (chế độ auto)
//      tự động chuyển sang interface chat để sinh ảnh dự phòng (fallback);
//   5. Khi kích thước bị tuyến trên từ chối, lùi về kích thước mặc định đã cấu hình và thử lại 1 lần;
//   6. Interface sinh ảnh tiêu chuẩn liên tục gặp sự cố sẽ ngắt mạch (Trong 30 phút chuyển thẳng sang chat), đổi tuyến trên/thay đổi cài đặt sẽ tự động gỡ bỏ.
//
// Tương thích tương đương trên môi trường trình duyệt (Không thay đổi ngữ nghĩa hành vi):
//   - Cross-domain: API tuyến trên cần cho phép trình duyệt cross-domain (CORS); Nếu URL hình ảnh không thể download do CORS,
//     trả về kết quả giáng cấp remoteUrl (Hình ảnh vẫn có thể sử dụng trực tiếp, chỉ là không đi qua xử lý byte cục bộ và xóa watermark).

import { removeWatermark } from './watermark.js';

// -- Loại lỗi (Tương ứng với upstreamError / notImageError của Go) --

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

// imageResult Kết quả sinh: Byte hình ảnh + Đuôi mở rộng thực tế + Luồng đã đi qua.
// Khi remoteUrl tồn tại, biểu thị kết quả giáng cấp "Không thể download byte, nhưng link có thể sử dụng trực tiếp".
export class ImageResult {
    constructor(data, ext, via, remoteUrl) {
        this.data = data;      // Uint8Array | null
        this.ext = ext;        // png/jpg/webp/gif/bmp
        this.via = via;        // images / chat / images->chat dự phòng
        this.remoteUrl = remoteUrl ?? null;
    }
}

// chatImageInstruction Chỉ thị sinh ảnh bằng chat.
export const chatImageInstruction = 'Vui lòng trực tiếp tạo một hình ảnh, không xuất ra văn bản thừa thãi.';

// Trích xuất link ảnh trong phản hồi chat (Ảnh Markdown + Link trần).
const mdImageRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const bareURLRe = /https?:\/\/[^\s"'<>)\]]+/g;

// -- Ngắt mạch interface sinh ảnh tiêu chuẩn (Dành riêng cho chế độ auto) --
let imagesBrokenCount = 0;
let imagesBrokenUntil = 0; // epoch ms; 0 = Chưa ngắt mạch

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
        logf(`[Upstream] Interface sinh ảnh tiêu chuẩn đã thất bại liên tục ${IMAGES_BROKEN_THRESHOLD} lần, ngắt mạch 30m0s, trong thời gian này đi thẳng qua interface chat`);
    }
}

function markImagesOK() {
    imagesBrokenCount = 0;
    imagesBrokenUntil = 0;
}

// logf Log console của extension (Việc render màu đỏ giao cho bản thân console).
export function logf(line) {
    console.log(`[V.Adapter] ${line}`);
}

// -- Cổng vào (Entry) chính hướng ra bên ngoài --

// target Tham số tuyến trên cần thiết cho một lần gọi (Snapshot cấu hình nóng trên bảng điều khiển / Giá trị ghi đè khi test).
function targetFromSettings() {
    return {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
}

// generateImage Sinh một bức ảnh theo chế độ (auto/off/chat_only/openai).
export async function generateImage(target, prompt, neg, size, mode) {
    mode = normalizeChatFallbackMode(mode);
    if (mode === 'chat_only') {
        try {
            return await generateViaChat(target, prompt, neg);
        } catch (err) {
            // chat_only hiện đang là luồng mặc định. Nếu tuyến trên thực chất là model sinh ảnh (interface chat không thể vẽ ảnh),
            // bắt buộc phải viết rõ lối thoát ở đây, tránh bị đánh giá nhầm thành lỗi plugin.
            throw new Error(`${err.message}; Luồng sinh ảnh hiện tại là "Chỉ interface chat" (chat_only).` +
                'Nếu tuyến trên là model sinh ảnh (như qwen-image / dall-e-3...), vui lòng vào "Trung tâm cài đặt" đổi luồng sinh ảnh thành auto hoặc off');
        }
    }
    if (mode === 'openai') {
        // Chế độ openai: Thuần interface Text-to-Image tiêu chuẩn OpenAI (/images/generations),
        // Hướng tới các loại API tương thích OpenAI (Chính thức/Bên thứ ba), không làm proxy ngược dự phòng sang chat; thất bại là báo lỗi ngay.
        const res = await generateViaImages(target, prompt, neg, size);
        markImagesOK();
        return res;
    }
    if (mode === 'auto' && imagesBroken()) {
        logf('[Upstream] Interface sinh ảnh tiêu chuẩn đang trong thời gian ngắt mạch, đi thẳng qua interface chat');
        const res = await generateViaChat(target, prompt, neg);
        res.via = 'chat (Interface tiêu chuẩn bị ngắt mạch)';
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
            logf(`[Upstream] Sinh ảnh tiêu chuẩn không nhận được ảnh (${err.message}), chuyển sang interface chat để dự phòng ...`);
            try {
                const res2 = await generateViaChat(target, prompt, neg);
                res2.via = 'images->chat dự phòng';
                return res2;
            } catch (err2) {
                throw new Error(`${err.message}; Sinh ảnh bằng chat dự phòng cũng thất bại: ${err2.message}`);
            }
        }
        throw err;
    }
}

// normalizeChatFallbackMode (Tương ứng với normalizeChatFallback của Go, để pipeline và settings dùng chung ngữ nghĩa).
export function normalizeChatFallbackMode(s) {
    switch (String(s ?? '').toLowerCase().trim()) {
        case 'off': return 'off';
        case 'chat_only': return 'chat_only';
        case 'openai': return 'openai';
        default: return 'auto';
    }
}

// generateViaImages Interface sinh ảnh tiêu chuẩn, thử nghiệm theo tổ hợp "Lùi kích thước + Giáng cấp negative_prompt".
async function generateViaImages(target, prompt, neg, size) {
    if (!size) size = target.defaultSize;
    const queue = [{ size, neg }];
    const tried = new Set();
    let lastErr = null;
    // Giới hạn 6 lần (Sau khi lọc trùng thực tế tối đa 4 loại tổ hợp: Kích thước gốc/Kích thước mặc định x Có/Không negative_prompt)
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
                // Kích thước không được chấp nhận: Lùi về kích thước mặc định đã cấu hình rồi thử lại
                if (sizeRelated(err.body) && a.size !== target.defaultSize && target.defaultSize) {
                    logf(`[Upstream] Kích thước ${a.size} bị tuyến trên từ chối, lùi về kích thước mặc định ${target.defaultSize} và thử lại`);
                    queue.push({ size: target.defaultSize, neg: a.neg });
                }
                // negative_prompt là trường không tiêu chuẩn: Thất bại thì bỏ đi rồi thử lại
                if (a.neg) {
                    logf(`[Upstream] Request có kèm negative_prompt thất bại (HTTP ${err.statusCode}), bỏ trường này đi và thử lại`);
                    queue.push({ size: a.size, neg: '' });
                }
            }
        }
    }
    throw lastErr ?? new Error('Request sinh ảnh tuyến trên thất bại');
}

// imagesOnce Một lần request sinh ảnh tiêu chuẩn (Một lần thử).
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
        throw new UpstreamError(status, raw, `Interface sinh ảnh tuyến trên trả về HTTP ${status}: ${snippet(raw, 300)}`);
    }
    let resp;
    try { resp = JSON.parse(raw); } catch {
        throw new NotImageError(`Phản hồi của interface sinh ảnh tuyến trên không phải là JSON hợp lệ (Đoạn trích: ${snippet(raw, 150)})`);
    }
    if (!resp.data || !resp.data.length) {
        throw new NotImageError(`Trong phản hồi của interface sinh ảnh tuyến trên không có data[0] (Đoạn trích: ${snippet(raw, 150)})`);
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
        throw new NotImageError('b64_json do interface sinh ảnh tuyến trên trả về không thể giải mã base64');
    }
    const u = String(item.url ?? '').trim();
    if (u) {
        const dl = await downloadImage(u);
        if (dl.bytes) return decodeImageBytes(dl.bytes, 'images');
        // Download thất bại do CORS: Trả về kết quả giáng cấp link từ xa (Ảnh có thể sử dụng trực tiếp)
        return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'images', dl.url);
    }
    throw new NotImageError('Trong phản hồi API không có cả b64_json lẫn url, vui lòng kiểm tra lại dịch vụ tương thích');
}

// generateViaChat Dự phòng sinh ảnh bằng interface chat.
async function generateViaChat(target, prompt, neg) {
    let instruction = chatImageInstruction;
    if (neg) instruction += '\nVui lòng bắt buộc tránh các yếu tố sau: ' + neg;
    const messages = [{ role: 'user', content: instruction + '\n' + prompt }];

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
            logf('[Upstream] Interface chat gặp sự cố chốc lát, 6s sau sẽ thử lại ...');
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
            const ue = new UpstreamError(status, raw, `Interface chat tuyến trên trả về HTTP ${status}: ${snippet(raw, 300)}`);
            lastErr = ue;
            if (transientErr(ue)) continue;
            throw ue;
        }
        let cr;
        try { cr = JSON.parse(raw); } catch { cr = null; }
        if (!cr || !cr.choices || !cr.choices.length) {
            throw new NotImageError(`Phản hồi của interface chat tuyến trên thiếu choices (Đoạn trích: ${snippet(raw, 150)})`);
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
                // Ảnh từ luồng chat của trang web chính thức tuyến trên có logo "Qwen" ở góc dưới bên phải, thống nhất xóa đi
                res.data = await removeWatermark(res.data, res.ext);
                return res;
            }
            if (dl.remoteUrl) {
                // Download thất bại do CORS: Giáng cấp link từ xa (Bỏ qua xóa watermark, ảnh có thể hiển thị trực tiếp)
                logf('[Upstream] Ảnh không thể xử lý cục bộ do giới hạn cross-domain, trực tiếp sử dụng link gốc');
                return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'chat', dl.remoteUrl);
            }
            lastErr = dl.error ?? new Error('Download ảnh thất bại');
        }
        throw new NotImageError('Tất cả link ảnh trả về từ sinh ảnh chat đều không thể download hoặc phân tích');
    }
    throw lastErr ?? new Error('Request sinh ảnh bằng chat thất bại');
}

// -- Nền tảng HTTP --

// postJSON POST một đoạn JSON đến target.url+path, trả về text body phản hồi và status code.
// translate.js cũng có thể dùng lại (Cùng một kênh tuyến trên).
export async function postJSON(target, path, body, timeoutMs) {
    const base = String(target.url ?? '').trim().replace(/\/+$/, '');
    if (!base) {
        throw new Error('Chưa cấu hình địa chỉ API tuyến trên: Vui lòng điền địa chỉ API tại "Trung tâm cài đặt" trong Bảng quản lý');
    }
    const key = String(target.key ?? '').trim();
    // Header request chỉ cho phép ký tự ISO-8859-1: Key mặc định ban đầu có chứa tiếng Trung, trình duyệt sẽ trực tiếp từ chối gửi request
    // (Báo lỗi "String contains non ISO-8859-1 code point"). Chặn trước và đưa ra hướng dẫn dễ đọc.
    if (/[^\x00-\xFF]/.test(key)) {
        throw new Error('API Key vẫn đang là giá trị mặc định ban đầu (có chứa tiếng Trung): Vui lòng mở "Trung tâm cài đặt" trong Bảng quản lý, điền địa chỉ tuyến trên, key và model của riêng bạn rồi thử lại');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(base + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (key || 'EMPTY'), // Dịch vụ cục bộ miễn xác thực dùng placeholder
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`Timeout interface tuyến trên (${base + path} không phản hồi trong vòng ${formatDuration(timeoutMs)})`);
        }
        throw new Error(`Request interface tuyến trên thất bại (${base + path}): ${err.message} (Nếu là lỗi cross-domain, vui lòng yêu cầu API tuyến trên cho phép trình duyệt truy cập CORS)`);
    } finally {
        clearTimeout(timer);
    }
    const raw = await resp.text();
    return { raw, status: resp.status };
}

// downloadImage Download data[0].url hoặc link ảnh trong phản hồi chat.
// Trả về { bytes } (Thành công) / { remoteUrl } (Giáng cấp CORS) / { error } (Thất bại).
async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180 * 1000);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (resp.status !== 200) {
            return { error: new Error(`Download ảnh đã sinh thất bại: HTTP ${resp.status} (${url})`) };
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        return { bytes: buf };
    } catch (err) {
        // Đa số là do giới hạn CORS của trình duyệt: Đưa ra link từ xa có thể trực tiếp sử dụng để giáng cấp
        if (controller.signal.aborted) {
            return { error: new Error(`Download ảnh đã sinh thất bại: Timeout (${url})`) };
        }
        return { remoteUrl: url };
    } finally {
        clearTimeout(timer);
    }
}

// -- Nhận diện và chẩn đoán hình ảnh --

// sniffImage Nhận diện định dạng hình ảnh theo magic number, trả về đuôi mở rộng (png/jpg/webp/gif/bmp).
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

// decodeImageBytes Xác minh byte đúng là hình ảnh; nếu không thì đưa ra chẩn đoán dễ đọc.
export function decodeImageBytes(raw, via) {
    const ext = sniffImage(raw);
    if (!ext) throw new NotImageError(nonImageDiag(raw));
    return new ImageResult(raw, ext, via, null);
}

// nonImageDiag Câu văn chẩn đoán đối với nội dung không phải hình ảnh (Từ ngữ dễ đọc hướng tới người dùng).
function nonImageDiag(raw) {
    const head = raw.slice(0, Math.min(raw.length, 2048));
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(head); } catch { text = ''; }
    const low = text.trimStart().toLowerCase();
    if (low.startsWith('<!doctype') || low.startsWith('<html') || (low.length > 0 && low[0] === '<')) {
        return 'API trả về không phải là hình ảnh, mà là một trang web/HTML (Nguyên nhân phổ biến: Trang mã xác nhận kiểm soát rủi ro của dịch vụ trung gian, trang báo lỗi đăng nhập hết hạn hoặc lỗi 502, vui lòng kiểm tra xem bản thân dịch vụ API đó có thể sinh ảnh hay không)';
    }
    if (low.includes('error') || low.includes('exception')) {
        return `API trả về không phải là hình ảnh, nghi ngờ là thông báo lỗi: ${JSON.stringify(snippet(text, 200))}`;
    }
    return 'Dữ liệu API trả về không thể phân tích thành hình ảnh (Loại nội dung bất thường, vui lòng kiểm tra dịch vụ API)';
}

// extractImageURLs Trích xuất link ảnh từ phản hồi chat, và nhận diện trang punish kiểm soát rủi ro.
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

// noImageURLDiag Chẩn đoán thống nhất khi không lấy được link ảnh bằng chat.
function noImageURLDiag(content, seenPunish) {
    if (seenPunish) {
        return 'Tuyến trên bị hệ thống kiểm soát rủi ro tuyến trên chặn lại (Trả về trang xác minh punish), quá trình sinh không tạo ra ảnh.' +
            'Kiểm soát rủi ro thường tự động gỡ bỏ sau vài phút: Vui lòng đợi một lát rồi thử lại, giảm tốc độ sinh ảnh liên tục, hoặc đổi từ khóa mô tả khác rồi thử lại';
    }
    let sn = truncate(content.trim(), 150);
    if (!sn) sn = '(Model không trả về bất kỳ link ảnh nào)';
    for (const m of ['không thể sinh', 'không thể trực tiếp sinh', 'không thể tạo', 'không tạo được',
        'chính sách nội dung', 'tiêu chuẩn an toàn', 'không phù hợp', 'khiêu dâm', 'hở hang', 'vi phạm']) {
        if (content.includes(m)) {
            return 'Model sinh ảnh tuyến trên đã từ chối request này dựa trên chính sách an toàn nội dung của nó, model phản hồi: ' + sn +
                '. Đây là chính sách của dịch vụ tuyến trên chứ không phải lỗi công cụ cục bộ; có thể điều chỉnh mô tả để lách các yếu tố nhạy cảm rồi thử lại';
        }
    }
    return 'Sinh ảnh bằng chat không trả về link ảnh, model phản hồi: ' + sn;
}

// -- Công cụ phán đoán --

// imagesEndpointUnavailable Phán đoán "Interface sinh ảnh tiêu chuẩn hiện không khả dụng" -- Căn cứ để đếm ngắt mạch.
//
// Căn chỉnh (align) với quy ước lỗi của gateway tuyến trên (qwen2api), ưu tiên nhìn vào các trường cấu trúc, không đoán mò bằng chữ:
//   code:  upstream_waf_challenge (Tuyến trên bị Aliyun WAF chặn, trả về trang mã xác nhận)
//          quota_limit / upstream_business_error / upstream_unavailable
//   type:  rate_limit_error (429) / server_error (5xx)
// Chữ dự phòng chỉ nhận diện các từ đặc trưng WAF mà bản thân gateway sử dụng (Cùng nguồn gốc với WAF_BODY_RE trong chat.image.video.js của nó).
const IMAGES_BROKEN_CODES = new Set([
    'upstream_waf_challenge',
    'quota_limit',
    'upstream_business_error',
    'upstream_unavailable',
]);
const IMAGES_WAF_TEXT_RE = /upstream_waf_challenge|aliyun_waf|AliyunCaptcha|FAIL_SYS_USER_VALIDATE|RGV587|Aliyun\s*WAF|captcha|mã xác nhận/i;

function imagesEndpointUnavailable(err) {
    if (!(err instanceof UpstreamError)) return false;
    const status = Number(err.statusCode) || 0;
    if (status === 429 || status >= 500) return true;

    const raw = String(err.body ?? '');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* Body phản hồi không phải JSON, đi vào phần dự phòng bằng chữ */ }
    const e = (parsed && (parsed.error || parsed)) || null;
    const code = String(e?.code ?? '').trim();
    const type = String(e?.type ?? '').trim();
    if (code && IMAGES_BROKEN_CODES.has(code)) return true;
    if (type === 'rate_limit_error' || type === 'server_error') return true;

    return IMAGES_WAF_TEXT_RE.test(raw.slice(0, 4096));
}

// shouldTryChat Sau khi sinh ảnh tiêu chuẩn thất bại có đáng để chuyển sang dự phòng bằng chat không (Khớp với phán đoán của bản Go).
function shouldTryChat(err) {
    if (err instanceof NotImageError) return true;
    if (err instanceof UpstreamError) {
        if ([401, 402, 403].includes(err.statusCode)) return false;
        return true;
    }
    return false;
}

// transientErr Phán đoán sự cố chốc lát (Transient).
function transientErr(err) {
    if (!err) return false;
    const msg = String(err.message ?? err).toLowerCase();
    return msg.includes('502') || msg.includes('429') ||
        msg.includes('timeout') || msg.includes('timeout') ||
        msg.includes('upstream');
}

// sizeRelated Lỗi tuyến trên có liên quan đến kích thước không (Dùng để lùi về kích thước mặc định rồi thử lại).
function sizeRelated(body) {
    const low = String(body ?? '').toLowerCase();
    return ['size', 'resolution', 'width', 'height', 'kích thước', 'độ phân giải'].some(k => low.includes(k));
}

// snippet Nén khoảng trắng và cắt ngắn, dùng để kẹp một đoạn ngắn phản hồi tuyến trên vào trong thông báo lỗi.
function snippet(raw, n) {
    const s = String(raw ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!s) return '(Phản hồi rỗng)';
    return truncate(s, n);
}

// truncate Cắt ngắn theo số lượng ký tự (An toàn với tiếng Trung), quá dài thì thêm ...
export function truncate(s, n) {
    s = String(s ?? '');
    const r = [...s];
    if (r.length <= n) return s;
    return r.slice(0, n).join('') + '...';
}

// mimeForExt Đuôi mở rộng hình ảnh -> MIME (Dùng cho bảng điều khiển test preview).
export function mimeForExt(ext) {
    switch (String(ext ?? '').toLowerCase()) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        default: return 'image/png';
    }
}

// -- Công cụ tiện ích chung --

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