// settings.js — Cài đặt có thể thay đổi lúc runtime (Bản Node server-side).
// Port 1:1 từ V.Adapter (Go) settings.go:
//   - Giá trị mặc định lúc khởi động config.json (Plugin này dùng data/config.json) + Ghi đè bằng biến môi trường (environment variables),
//     Sau đó bị ghi đè bởi data/settings.json (Thay đổi trên bảng điều khiển có độ ưu tiên cao nhất, có hiệu lực ngay (hot-reload));
//   - Quy tắc chuẩn hóa (normalization), quy tắc che giấu (masking), ngữ nghĩa các trường hoàn toàn nhất quán với bản Go.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// VADAPTER_DATA_DIR do bootloader server inject, giúp giải phóng (decouple) dữ liệu hoạt động khỏi vị trí chứa code:
// Code có thể cập nhật cùng extension vào thư mục bất kỳ, cấu hình luôn nằm ở vị trí do biến môi trường này trỏ tới.
const dataDir = process.env.VADAPTER_DATA_DIR
    ? path.resolve(process.env.VADAPTER_DATA_DIR)
    : path.join(pluginDir, 'data');
const settingsPath = path.join(dataDir, 'settings.json');
const configPath = path.join(dataDir, 'config.json');

// Tương ứng 1:1 với các trường của startupConfig bản Go.
const DEFAULTS = {
    listen: '0.0.0.0:8888',
    qwen_url: 'http://127.0.0.1:4000/v1',
    qwen_key: 'sk-Key_tuyến_trên_của_bạn',
    qwen_model: 'qwen3.8-max',
    default_size: '1024x1024',
    nai_key: 'v-adapter-8888',
    // Mặc định đi qua interface chat để sinh ảnh: Interface sinh ảnh tiêu chuẩn (/images/generations) khi bị Aliyun WAF của tuyến trên
    // chặn lại vì rủi ro sẽ không khả dụng (trả về 429), trong khi interface chat lại ổn định khả dụng và cũng có thể sinh ảnh.
    // Người dùng cần interface tiêu chuẩn có thể đổi lại thành auto / off / openai.
    chat_fallback: 'chat_only',
};

let rt = { ...DEFAULTS };

function readJSON(p) {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// initSettings Khởi tạo lúc khởi động: Mặc định -> data/config.json -> Biến môi trường -> data/settings.json.
export function initSettings() {
    rt = { ...DEFAULTS };

    const cfg = readJSON(configPath);
    if (cfg && typeof cfg === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (cfg[k] !== undefined && cfg[k] !== null) rt[k] = cfg[k];
        }
    }

    const env = process.env;
    const envMap = [
        ['qwen_url', ['VADAPTER_QWEN_URL', 'OPENAI_BASE_URL']],
        ['qwen_key', ['VADAPTER_QWEN_KEY', 'OPENAI_API_KEY']],
        ['qwen_model', ['VADAPTER_QWEN_MODEL', 'OPENAI_IMAGE_MODEL']],
        ['listen', ['VADAPTER_LISTEN']],
        ['default_size', ['VADAPTER_DEFAULT_SIZE']],
        ['nai_key', ['VADAPTER_NAI_KEY']],
    ];
    for (const [field, names] of envMap) {
        for (const n of names) {
            const v = String(env[n] ?? '').trim();
            if (v) { rt[field] = v; break; }
        }
    }

    const saved = readJSON(settingsPath);
    if (saved && typeof saved === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (saved[k] !== undefined && saved[k] !== null) rt[k] = saved[k];
        }
    }

    // Chuẩn hóa
    rt.qwen_url = String(rt.qwen_url).trim();
    rt.qwen_key = String(rt.qwen_key).trim();
    rt.qwen_model = String(rt.qwen_model).trim();
    rt.default_size = normalizeSizeOrDefault(rt.default_size);
    rt.nai_key = String(rt.nai_key).trim();
    rt.chat_fallback = normalizeChatFallback(rt.chat_fallback);
    rt.listen = normalizeListenOrDefault(rt.listen);
}

// -- Công cụ chuẩn hóa (Nhất quán với bản Go) --

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

export function normalizeListen(s) {
    s = String(s ?? '').trim();
    if (!s) return null;
    if (!s.includes(':')) s = ':' + s;
    const idx = s.lastIndexOf(':');
    const port = parseInt(s.slice(idx + 1), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return s;
}

export function normalizeListenOrDefault(s) {
    return normalizeListen(s) ?? '0.0.0.0:8888';
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

// -- getter --
export const settingsGet = {
    qwenURL: () => rt.qwen_url,
    qwenKey: () => rt.qwen_key,
    qwenModel: () => rt.qwen_model,
    defaultSize: () => rt.default_size,
    naiKey: () => rt.nai_key,
    chatFallback: () => rt.chat_fallback,
    listen: () => rt.listen,
};

// settingsView Snapshot hiển thị cho Trung tâm cài đặt (Key thống nhất bị che giấu).
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

function persist() {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(rt, null, 2), 'utf8');
    } catch (e) {
        console.log(`[V.Adapter] Ghi cài đặt thất bại: ${e.message}`);
    }
}

// applySettings Áp dụng cặp key-value do bảng điều khiển submit: Xác thực và có hiệu lực ngay, trả về [changed, notes].
export function applySettings(body) {
    const changed = [], notes = [];
    const toStr = v => (typeof v === 'string' ? v : '');

    if ('qwen_url' in body) {
        const s = toStr(body.qwen_url).trim();
        if (s && s !== rt.qwen_url) { rt.qwen_url = s; changed.push('qwen_url'); resetImagesBroken(); }
    }
    if ('qwen_key' in body) {
        const s = toStr(body.qwen_key).trim();
        if (s && s !== maskKey(rt.qwen_key)) { rt.qwen_key = s; changed.push('qwen_key'); resetImagesBroken(); }
    }
    if ('qwen_model' in body) {
        const s = toStr(body.qwen_model).trim();
        if (s && s !== rt.qwen_model) { rt.qwen_model = s; changed.push('qwen_model'); resetImagesBroken(); }
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
        const s = normalizeListen(toStr(body.listen));
        if (s && s !== rt.listen) {
            rt.listen = s;
            changed.push('listen');
            notes.push('listen đã được lưu, khởi động lại SillyTavern để có hiệu lực');
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

// Hook reset trạng thái ngắt mạch (circuit breaker) (Được inject khi server.js khởi động, tránh phụ thuộc vòng tròn (circular dependency))
let _resetImagesBroken = () => {};
export function bindResetImagesBroken(fn) { _resetImagesBroken = fn; }
function resetImagesBroken() { try { _resetImagesBroken(); } catch { /* ignore */ } }