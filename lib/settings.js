// settings.js - Cài đặt có thể thay đổi lúc chạy (Áp dụng nóng + Lưu trữ bằng extension settings của SillyTavern).
// Port 1:1 từ V.Adapter (Go) settings.go:
//   - Bản Go ghi vào data/settings.json, bản extension ghi vào extension_settings.v_adapter của SillyTavern
//     (Lưu trữ cùng với file cấu hình của SillyTavern, khởi động lại không bị mất);
//   - Quy tắc chuẩn hóa, quy tắc che giấu (mask), ngữ nghĩa của các trường hoàn toàn giống hệt bản Go;
//   - Trường listen của bản Go không có ý nghĩa trong hình thái extension (không có port độc lập), giữ nguyên trường, giao diện vẫn hiển thị bình thường,
//     quy tắc lưu vẫn giữ nguyên nhưng không cần khởi động lại nữa.

import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

const MODULE_KEY = 'v_adapter';

// persistedSettings tương ứng 1:1 với các trường của settings.json trong bản Go.
const FIELDS = [
    'qwen_url', 'qwen_key', 'qwen_model', 'default_size',
    'nai_key', 'chat_fallback', 'listen',
];

export function defaultSettings() {
    return {
        qwen_url: 'http://127.0.0.1:4000/v1',
        qwen_key: 'sk-Secret key tuyến trên của bạn',
        qwen_model: 'qwen3.8-max',
        default_size: '1024x1024',
        nai_key: 'v-adapter-8888',
        // Mặc định chạy qua API chat để tạo ảnh: API tạo ảnh tiêu chuẩn (/images/generations) khi bị Aliyun WAF
        // của tuyến trên chặn kiểm soát rủi ro sẽ không khả dụng (trả về 429), trong khi API chat hoạt động ổn định và vẫn có thể tạo ảnh.
        // Người dùng cần API tiêu chuẩn có thể đổi lại thành auto / off / openai trong "Trung tâm cài đặt".
        chat_fallback: 'chat_only',
        listen: '0.0.0.0:8888', // Hình thái extension chỉ giữ lại trường (Không có port độc lập)
    };
}

// -- Snapshot bộ nhớ lúc chạy (Các điểm đọc cấu hình áp dụng nóng đọc trực tiếp ở đây) --
let rt = defaultSettings();

// initSettings Khởi tạo lúc khởi động: Giá trị mặc định -> Ghi đè bằng các trường đã tồn tại trong lưu trữ của SillyTavern.
export function initSettings() {
    const saved = extension_settings[MODULE_KEY] ?? {};
    rt = defaultSettings();
    for (const k of FIELDS) {
        if (saved[k] !== undefined && saved[k] !== null) rt[k] = saved[k];
    }
    rt.qwen_url = String(rt.qwen_url).trim();
    rt.qwen_key = String(rt.qwen_key).trim();
    rt.qwen_model = String(rt.qwen_model).trim();
    rt.default_size = normalizeSizeOrDefault(rt.default_size);
    rt.nai_key = String(rt.nai_key).trim();
    rt.chat_fallback = normalizeChatFallback(rt.chat_fallback);
}

function persist() {
    extension_settings[MODULE_KEY] = JSON.parse(JSON.stringify(rt));
    saveSettingsDebounced();
}

// -- Công cụ chuẩn hóa (Giống hệt bản Go) --

// normalizeSizeStr Xác minh chuỗi "RộngxCao" (Cũng chấp nhận dấu x (nhân) và dấu cách), trả về định dạng chuẩn.
export function normalizeSizeStr(s) {
    s = String(s ?? '').toLowerCase().trim().replaceAll('×', 'x');
    const parts = s.split('x');
    if (parts.length !== 2) return null;
    const w = parseInt(parts[0].trim(), 10);
    const h = parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 4096 || h > 4096) return null;
    return `${w}x${h}`;
}

export function normalizeSizeOrDefault(s) {
    return normalizeSizeStr(s) ?? '1024x1024';
}

export function normalizeChatFallback(s) {
    switch (String(s ?? '').toLowerCase().trim()) {
        case 'off': return 'off';
        case 'chat_only': return 'chat_only';
        case 'openai': return 'openai';
        default: return 'auto';
    }
}

// maskKey Che giấu Key: Key ngắn chỉ giữ lại ký tự đầu (ví dụ 1 -> 1***), key dài giữ 3 đầu 2 đuôi.
export function maskKey(k) {
    k = String(k ?? '').trim();
    if (!k) return '';
    const r = [...k];
    if (r.length <= 4) return r[0] + '***';
    return r.slice(0, 3).join('') + '***' + r.slice(-2).join('');
}

// -- Getter an toàn luồng (Các điểm đọc cấu hình áp dụng nóng đồng loạt đi qua đây) --
export const settingsGet = {
    qwenURL: () => rt.qwen_url,
    qwenKey: () => rt.qwen_key,
    qwenModel: () => rt.qwen_model,
    defaultSize: () => rt.default_size,
    naiKey: () => rt.nai_key,
    chatFallback: () => rt.chat_fallback,
    listen: () => rt.listen,
};

// settingsView Snapshot hiển thị của trung tâm cài đặt. Toàn bộ Key đều bị che (GET /admin/settings
// Không trả về key dạng văn bản rõ), chỉ cung cấp boolean *_set để frontend biết là đã cấu hình hay chưa.
export function settingsView() {
    return {
        qwen_url: rt.qwen_url,
        qwen_key_masked: maskKey(rt.qwen_key),
        qwen_key_set: rt.qwen_key !== '',
        qwen_model: rt.qwen_model,
        default_size: rt.default_size,
        nai_key_masked: maskKey(rt.nai_key),
        nai_key_required: rt.nai_key !== '',
        chat_fallback: rt.chat_fallback,
        listen: rt.listen,
    };
}

// applySettings Áp dụng cặp key-value do bảng điều khiển submit: Xác minh và áp dụng nóng, trả về (changed, notes).
//
// Ngữ nghĩa đặc biệt của trường Key (Bảng điều khiển không lưu giữ văn bản rõ):
//   - Submit rỗng / giống với giá trị đã che hiện tại -> Coi như "Chưa sửa", bỏ qua;
//   - Muốn xóa trắng thực sự thì dùng "clear": ["qwen_key"|"nai_key"] trong body.
export function applySettings(body) {
    const changed = [], notes = [];
    const toStr = v => (typeof v === 'string' ? v : '');

    if ('qwen_url' in body) {
        const s = toStr(body.qwen_url).trim();
        if (s && s !== rt.qwen_url) { rt.qwen_url = s; changed.push('qwen_url'); resetImagesBrokenCompat(); }
    }
    if ('qwen_key' in body) {
        const s = toStr(body.qwen_key).trim();
        if (s && s !== maskKey(rt.qwen_key)) { rt.qwen_key = s; changed.push('qwen_key'); resetImagesBrokenCompat(); }
    }
    if ('qwen_model' in body) {
        const s = toStr(body.qwen_model).trim();
        if (s && s !== rt.qwen_model) { rt.qwen_model = s; changed.push('qwen_model'); resetImagesBrokenCompat(); }
    }
    if ('default_size' in body) {
        const s = toStr(body.default_size).trim();
        if (!s) { /* Giữ nguyên giá trị rỗng */ }
        else {
            const n = normalizeSizeStr(s);
            if (n) { if (n !== rt.default_size) { rt.default_size = n; changed.push('default_size'); } }
            else notes.push('Định dạng default_size không hợp lệ (Phải là RộngxCao, ví dụ 832x1216), đã bỏ qua');
        }
    }
    if ('nai_key' in body) {
        const s = toStr(body.nai_key).trim();
        if (s && s !== maskKey(rt.nai_key)) { rt.nai_key = s; changed.push('nai_key'); }
    }
    if ('chat_fallback' in body) {
        const s = normalizeChatFallback(toStr(body.chat_fallback));
        if (s !== rt.chat_fallback) { rt.chat_fallback = s; changed.push('chat_fallback'); }
    }
    if ('listen' in body) {
        const s = toStr(body.listen).trim();
        if (s && s !== rt.listen) {
            rt.listen = s;
            changed.push('listen');
            notes.push('Đã lưu listen (Chế độ tích hợp trong extension thực tế không sử dụng port độc lập)');
        }
    }
    if (Array.isArray(body.clear)) {
        for (const c of body.clear) {
            if (c === 'qwen_key') {
                if (rt.qwen_key !== '') { rt.qwen_key = ''; changed.push('qwen_key'); }
            } else if (c === 'nai_key') {
                if (rt.nai_key !== '') {
                    rt.nai_key = '';
                    changed.push('nai_key');
                    notes.push('Đã xóa trắng nai_key: Client điền key bất kỳ đều có thể gọi API');
                }
            }
        }
    }

    if (changed.length > 0) persist();
    return [changed, notes];
}

// resetImagesBrokenCompat Xóa ngắt mạch sau khi đổi tuyến trên (Được inject khi pipeline.js khởi động).
let _resetImagesBroken = () => {};
export function bindResetImagesBroken(fn) { _resetImagesBroken = fn; }
function resetImagesBrokenCompat() { _resetImagesBroken(); }