// settings.js — Cài đặt có thể thay đổi lúc runtime (Có hiệu lực ngay (Hot-reload) + Lưu trữ persistence bằng extension settings của SillyTavern).
// Port 1:1 từ V.Adapter (Go) settings.go:
//   - Bản Go ghi vào data/settings.json, bản extension ghi vào extension_settings.v_adapter của SillyTavern
//     (Lưu trữ persistence theo file cài đặt của SillyTavern, khởi động lại không bị mất);
//   - Quy tắc chuẩn hóa (normalization), quy tắc che giấu (masking), ngữ nghĩa các trường hoàn toàn nhất quán với bản Go;
//   - Trường listen của bản Go không có ý nghĩa trong hình thái extension (không có port độc lập), giữ nguyên trường, giao diện vẫn hiển thị bình thường,
//     quy tắc lưu giữ nguyên nhưng không cần khởi động lại nữa.

import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

const MODULE_KEY = 'v_adapter';

// persistedSettings tương ứng 1:1 với các trường trong settings.json của bản Go.
const FIELDS = [
    'qwen_url', 'qwen_key', 'qwen_model', 'default_size',
    'nai_key', 'chat_fallback', 'listen',
];

export function defaultSettings() {
    return {
        qwen_url: 'http://127.0.0.1:4000/v1',
        qwen_key: 'sk-Key_tuyến_trên_của_bạn',
        qwen_model: 'qwen3.8-max',
        default_size: '1024x1024',
        nai_key: 'v-adapter-8888',
        // Mặc định đi qua interface chat để sinh ảnh: Interface sinh ảnh tiêu chuẩn (/images/generations) khi bị Aliyun WAF của tuyến trên
        // chặn lại vì rủi ro sẽ không khả dụng (trả về 429), trong khi interface chat lại ổn định khả dụng và cũng có thể sinh ảnh.
        // Người dùng cần interface tiêu chuẩn có thể vào "Trung tâm cài đặt" để đổi lại thành auto / off / openai.
        chat_fallback: 'chat_only',
        listen: '0.0.0.0:8888', // Hình thái extension chỉ giữ lại trường này (không có port độc lập)
    };
}

// -- Snapshot bộ nhớ lúc runtime (Điểm đọc có hiệu lực ngay sẽ đọc trực tiếp tại đây) --
let rt = defaultSettings();

// initSettings Khởi tạo lúc khởi động: Giá trị mặc định -> Dữ liệu lưu trữ persistence của SillyTavern ghi đè lên các trường đã tồn tại.
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

// -- Công cụ chuẩn hóa (Nhất quán với bản Go) --

// normalizeSizeStr Xác thực chuỗi "RộngxCao" (Cũng chấp nhận dấu x và khoảng trắng), trả về định dạng chuẩn.
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

// maskKey Che giấu Key: Key ngắn chỉ giữ lại ký tự đầu (Ví dụ 1 -> 1***), Key dài giữ 3 ký tự đầu và 2 ký tự cuối.
export function maskKey(k) {
    k = String(k ?? '').trim();
    if (!k) return '';
    const r = [...k];
    if (r.length <= 4) return r[0] + '***';
    return r.slice(0, 3).join('') + '***' + r.slice(-2).join('');
}

// -- Getter an toàn luồng (Thread-safe) (Điểm đọc có hiệu lực ngay thống nhất đi qua đây) --
export const settingsGet = {
    qwenURL: () => rt.qwen_url,
    qwenKey: () => rt.qwen_key,
    qwenModel: () => rt.qwen_model,
    defaultSize: () => rt.default_size,
    naiKey: () => rt.nai_key,
    chatFallback: () => rt.chat_fallback,
    listen: () => rt.listen,
};

// settingsView Snapshot hiển thị cho Trung tâm cài đặt. Key thống nhất bị che giấu (GET /admin/settings
// không trả về key dạng plain text (văn bản thuần)), chỉ cung cấp cờ boolean *_set để frontend biết đã cấu hình hay chưa.
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

// applySettings Áp dụng cặp key-value do bảng điều khiển submit: Xác thực và có hiệu lực ngay, trả về (changed, notes).
//
// Ngữ nghĩa đặc biệt của trường Key (Không lưu plain text trên bảng điều khiển):
//   - Submit giá trị rỗng / Giống với giá trị đã che giấu hiện tại -> Coi như "Chưa sửa đổi", bỏ qua;
//   - Để thực sự làm trống thì dùng "clear": ["qwen_key"|"nai_key"] trong body.
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
            else notes.push('Định dạng default_size không hợp lệ (Nên là RộngxCao, ví dụ 832x1216), đã bỏ qua');
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
            notes.push('listen đã được lưu (Chế độ tích hợp trong extension thực tế không sử dụng port độc lập)');
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
                    notes.push('nai_key đã bị làm trống: Client điền key bất kỳ đều có thể gọi (call)');
                }
            }
        }
    }

    if (changed.length > 0) persist();
    return [changed, notes];
}

// resetImagesBrokenCompat Xóa trạng thái ngắt mạch (circuit breaker) sau khi đổi tuyến trên (Được inject khi pipeline.js khởi động).
let _resetImagesBroken = () => {};
export function bindResetImagesBroken(fn) { _resetImagesBroken = fn; }
function resetImagesBrokenCompat() { _resetImagesBroken(); }