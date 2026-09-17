// admin.js — Endpoint của bảng quản lý (Tổng quan hoạt động / Trung tâm cài đặt / Test kết nối / Preset art style / Biên dịch nhân vật / Lịch sử sinh ảnh)
//             + Đăng nhập bảng điều khiển (Lần đầu miễn mật khẩu, có thể đặt mật khẩu).
// Port 1:1 từ admin.go + auth.go + handleAdminSettings trong settings.go của V.Adapter (Go).
//
// Danh sách route (5 route đầu yêu cầu đăng nhập bảng điều khiển; khi chưa đặt mật khẩu thì cho qua (pass) toàn bộ, do bảng điều khiển hướng dẫn thiết lập):
//   GET    /admin/status            Trạng thái hoạt động + Cấu hình đã che giấu (masked) + Lịch sử gần nhất (**Công khai**, cùng cấp với /health)
//   GET    /admin/settings          Đọc cài đặt (Key đã che giấu)
//   POST   /admin/settings          Ghi cài đặt (Có hiệu lực ngay (hot-reload) và lưu vào ổ đĩa data/settings.json)
//   POST   /admin/test              Gọi thực tế API sinh ảnh tuyến trên 1 lần, trả về ảnh xem trước
//   POST   /admin/translate         Biên dịch nhân vật (Tùy chọn kèm theo xuất ảnh)
//   GET    /admin/logs?limit=N      Lịch sử sinh ảnh   /  DELETE /admin/logs  Xóa sạch
//   GET    /admin/auth/status       Trạng thái đăng nhập (Công khai, dùng cho mặt nạ đăng nhập)
//   POST   /admin/auth/login        Đăng nhập          /admin/auth/setup  Thiết lập/Sửa đổi/Tắt mật khẩu
//   POST   /admin/auth/logout       Đăng xuất

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { settingsGet, settingsView, applySettings, normalizeSizeStr } from './settings.js';
import { genLog, genLogCap, newRecord } from './genlog.js';
import { targetFromSettings, generateImage, truncate, mimeForExt, bytesToBase64 } from './pipeline.js';
import { translateCharacter, mergeNegative, translateDefaultNegative } from './translate.js';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // plugins/V.Adapter
const dataDir = path.join(pluginDir, 'data');
const authPath = path.join(dataDir, 'auth.json');

// -- Thông tin lúc runtime (Inject khi server.js khởi động, tránh phụ thuộc vòng tròn (circular dependency)) --
let runtime = { version: '-', startedAt: new Date() };
export function setRuntime(info) {
    runtime = { ...runtime, ...info };
}

// -- Công cụ tiện ích response --

// writeJSON Thống nhất output JSON (Lỗi endpoint NovelAI dùng {"message": ...}, endpoint bảng điều khiển dùng {success,error}).
export function writeJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function writeAdminErr(res, code, msg) {
    writeJSON(res, code, { success: false, error: msg });
}

// readJsonBody Đọc request body và phân tích JSON (Body rỗng trả về null).
function readJsonBody(req, maxBytes = 8 << 20) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
                reject(new Error('Request body quá lớn'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text.trim()) return resolve(null);
            try {
                resolve(JSON.parse(text));
            } catch (e) {
                reject(new Error('Request body không phải là JSON hợp lệ: ' + e.message));
            }
        });
        req.on('error', reject);
    });
}

function toStr(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    return String(v);
}

// -- Đăng nhập bảng điều khiển (Tương ứng auth.go) --

const PANEL_COOKIE = 'v_adapter_panel';
const PANEL_TTL_MS = 24 * 60 * 60 * 1000;

let authHash = '';                  // Rỗng = Chưa đặt mật khẩu (Cho qua toàn bộ /admin/*)
const sessions = new Map();         // token -> Timestamp hết hạn(ms)

function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex');
}

function readCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// initAuth Load mật khẩu bảng điều khiển khi khởi động (Được gọi trước khi route tiếp quản).
export function initAuth() {
    try {
        if (fs.existsSync(authPath)) {
            const d = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            authHash = toStr(d?.password_hash).trim();
        } else {
            authHash = '';
        }
    } catch (e) {
        authHash = '';
        console.log(`[V.Adapter] Đọc mật khẩu bảng điều khiển thất bại (Xử lý như chưa thiết lập): ${e.message}`);
    }
}

function saveAuthHash(h) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ password_hash: h }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function panelPasswordSet() {
    return authHash !== '';
}

function panelOK(req) {
    if (!panelPasswordSet()) return true;
    const token = readCookies(req)[PANEL_COOKIE];
    if (!token) return false;
    const expiry = sessions.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function newSessionToken() {
    return crypto.randomBytes(24).toString('hex');
}

function setPanelCookie(res, token) {
    const parts = [
        `${PANEL_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(PANEL_TTL_MS / 1000)}`,
    ];
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearPanelCookie(res) {
    res.setHeader('Set-Cookie', `${PANEL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// -- Các endpoint --

// GET /admin/auth/status -> {success, setup_required, locked} (Công khai)
function handleAuthStatus(req, res) {
    const set = panelPasswordSet();
    writeJSON(res, 200, {
        success: true,
        setup_required: !set,
        locked: set && !panelOK(req),
    });
}

// POST /admin/auth/login {password}
async function handleAuthLogin(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!panelPasswordSet()) {
        writeAdminErr(res, 400, 'Chưa thiết lập mật khẩu bảng điều khiển, vui lòng hoàn thành thiết lập lần đầu trước');
        return;
    }
    if (hashPassword(toStr(body?.password)) !== authHash) {
        writeAdminErr(res, 401, 'Sai mật khẩu');
        return;
    }
    const token = newSessionToken();
    sessions.set(token, Date.now() + PANEL_TTL_MS);
    setPanelCookie(res, token);
    writeJSON(res, 200, { success: true });
}

// POST /admin/auth/setup {password} -> Thiết lập/Sửa đổi/Tắt mật khẩu bảng điều khiển (password rỗng = Tắt)
async function handleAuthSetup(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    const password = toStr(body?.password).trim();
    const set = panelPasswordSet();

    if (set && !panelOK(req)) {
        writeAdminErr(res, 401, 'Vui lòng đăng nhập trước rồi mới sửa đổi mật khẩu bảng điều khiển');
        return;
    }
    if (password === '') {
        if (!set) {
            writeAdminErr(res, 400, 'Mật khẩu không được để trống');
            return;
        }
        try {
            saveAuthHash('');
        } catch (e) {
            writeAdminErr(res, 500, 'Lưu thất bại: ' + e.message);
            return;
        }
        authHash = '';
        writeJSON(res, 200, { success: true, closed: true });
        return;
    }
    if (password.length < 4) {
        writeAdminErr(res, 400, 'Mật khẩu phải có ít nhất 4 ký tự');
        return;
    }
    const hash = hashPassword(password);
    try {
        saveAuthHash(hash);
    } catch (e) {
        writeAdminErr(res, 500, 'Lưu thất bại: ' + e.message);
        return;
    }
    authHash = hash;
    if (!set) {
        // Thiết lập lần đầu thành công coi như đã đăng nhập (Không cần nhập lại lần nữa)
        const token = newSessionToken();
        sessions.set(token, Date.now() + PANEL_TTL_MS);
        setPanelCookie(res, token);
    }
    writeJSON(res, 200, { success: true });
}

// POST /admin/auth/logout
function handleAuthLogout(req, res) {
    const token = readCookies(req)[PANEL_COOKIE];
    if (token) sessions.delete(token);
    clearPanelCookie(res);
    writeJSON(res, 200, { success: true });
}

// GET /admin/status (Công khai)
function handleAdminStatus(req, res) {
    const [success, fail] = genLog.Counters();
    writeJSON(res, 200, {
        status: 'ok',
        version: runtime.version,
        started_at: formatTime(runtime.startedAt),
        uptime_seconds: Math.floor((Date.now() - runtime.startedAt.getTime()) / 1000),
        listen: settingsGet.listen(),
        settings: settingsView(),
        counters: { success, fail, total: success + fail },
        recent: genLog.Snapshot(10),
    });
}

// GET/POST /admin/settings
async function handleAdminSettings(req, res) {
    if (req.method === 'GET') {
        writeJSON(res, 200, { success: true, settings: settingsView() });
        return;
    }
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, 'Method không được hỗ trợ');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') body = {};
    if (body.settings && typeof body.settings === 'object') body = body.settings;

    const [changed, notes] = applySettings(body);
    for (const k of changed) {
        if (k === 'nai_key' && settingsGet.naiKey() !== '') console.log('[V.Adapter] [Settings] nai_key đã được cập nhật (Client phải đồng bộ đổi Key)');
        if (k === 'qwen_key') console.log('[V.Adapter] [Settings] qwen_key đã được cập nhật');
    }
    writeJSON(res, 200, { success: true, changed, notes, settings: settingsView() });
}

// POST /admin/test -> Gọi thực tế API sinh ảnh tuyến trên 1 lần (body có thể ghi đè url/key/model/size/prompt, không lưu vào ổ đĩa)
async function handleAdminTest(req, res) {
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, 'Method không được hỗ trợ');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') body = {};

    const tgt = targetFromSettings();
    if (toStr(body.url).trim()) tgt.url = toStr(body.url).trim();
    if (toStr(body.key).trim()) tgt.key = toStr(body.key).trim();
    if (toStr(body.model).trim()) tgt.model = toStr(body.model).trim();
    const size = normalizeSizeStr(toStr(body.size)) ?? settingsGet.defaultSize();
    let prompt = toStr(body.prompt).trim();
    if (!prompt) prompt = 'Một quả táo màu đỏ đặt trên bàn gỗ, ánh sáng dịu nhẹ, nhiếp ảnh tĩnh vật, ảnh test';

    const start = Date.now();
    let img = null;
    let err = null;
    try {
        img = await generateImage(tgt, prompt, '', size, settingsGet.chatFallback());
    } catch (e) {
        err = e;
    }
    const latency = Date.now() - start;

    const rec = newRecord({
        kind: 'test', endpoint: '/admin/test', model: tgt.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (err) {
        rec.status = 502;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        console.log(`[V.Adapter] [Test] Test kết nối thất bại (${latency}ms): ${err.message}`);
        writeAdminErr(res, 502, truncate(err.message, 500));
        return;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    const bytes = img.data ? img.data.length : 0;
    console.log(`[V.Adapter] [Test] Test kết nối thành công (${latency}ms via ${img.via}): ${size} ${img.ext} ${Math.floor(bytes / 1024)}KB`);

    writeJSON(res, 200, {
        success: true,
        latency_ms: latency,
        model: tgt.model,
        size,
        via: img.via,
        ext: img.ext,
        bytes,
        preview: previewOf(img),
        message: `Sinh ảnh thành công: Thời gian ${latency}ms, luồng ${img.via}`,
    });
}

// GET /admin/logs?limit=N   /   DELETE /admin/logs
function handleAdminLogs(req, res, url) {
    if (req.method === 'GET') {
        let limit = 100;
        const q = parseInt(url.searchParams.get('limit') ?? '', 10);
        if (Number.isFinite(q) && q > 0) limit = q;
        const [success, fail] = genLog.Counters();
        writeJSON(res, 200, {
            success: true,
            logs: genLog.Snapshot(limit),
            cap: genLogCap,
            counters: { success, fail, total: success + fail },
        });
        return;
    }
    if (req.method === 'DELETE') {
        genLog.Clear();
        writeJSON(res, 200, { success: true });
        return;
    }
    writeAdminErr(res, 405, 'Method không được hỗ trợ');
}

// POST /admin/translate -> Biên dịch nhân vật (Tùy chọn kèm theo xuất ảnh)
async function handleAdminTranslate(req, res) {
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, 'Method không được hỗ trợ');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') {
        writeAdminErr(res, 400, 'Phân tích request body thất bại');
        return;
    }

    const wantGenerate = !!body.generate;
    const reqSize = toStr(body.size);

    let result;
    const givenPrompt = toStr(body.prompt).trim();
    if (givenPrompt) {
        // "Vẽ thêm tấm nữa": Tiếp tục dùng prompt của lần trước, không đi qua biên dịch nữa
        let neg = toStr(body.negative).trim();
        if (!neg) neg = mergeNegative(translateDefaultNegative);
        const [dw, dh] = defaultSizeWH();
        result = {
            prompt: givenPrompt, character_prompt: '', main_prompt: '',
            negative_prompt: neg, width: dw, height: dh, steps: 28, cfg_scale: 7.0,
        };
    } else {
        try {
            result = await translateCharacter(targetFromSettings(), toStr(body.text));
        } catch (e) {
            console.log(`[V.Adapter] [Translate] Biên dịch thất bại: ${e.message}`);
            writeAdminErr(res, 502, truncate(e.message, 300));
            return;
        }
        console.log(`[V.Adapter] [Translate] Biên dịch thành công: ${truncate(toStr(body.text).trim(), 40)} -> Tổng prompt ${[...result.prompt].length} chữ`);
    }

    const out = { success: true, data: result };
    if (!wantGenerate) {
        writeJSON(res, 200, out);
        return;
    }

    const tgt = targetFromSettings();
    let prompt = toStr(result.prompt).trim();
    if (!prompt) prompt = `${toStr(result.character_prompt).trim()}, ${toStr(result.main_prompt).trim()}`;
    let neg = toStr(result.negative_prompt);
    let size = `${result.width}x${result.height}`;
    const norm = normalizeSizeStr(reqSize);
    if (norm) size = norm;

    const start = Date.now();
    let img = null;
    let gerr = null;
    try {
        img = await generateImage(tgt, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    const latency = Date.now() - start;

    out.latency_ms = latency;
    out.used_size = size;
    out.used_prompt = prompt;

    const rec = newRecord({
        kind: 'translate', endpoint: '/admin/translate', model: tgt.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (gerr) {
        rec.status = 502;
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        console.log(`[V.Adapter] [Translate] Xuất ảnh thất bại (${latency}ms): ${gerr.message}`);
        // Biên dịch thành công nhưng xuất ảnh thất bại: Vẫn là 200, lỗi để ở image_error (Tránh xóa mất prompt đã lấy được)
        out.image_error = truncate(gerr.message, 500);
        writeJSON(res, 200, out);
        return;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    const bytes = img.data ? img.data.length : 0;
    console.log(`[V.Adapter] [Translate] Xuất ảnh thành công (${latency}ms via ${img.via}): ${size} ${img.ext} ${Math.floor(bytes / 1024)}KB`);

    out.preview = previewOf(img);
    out.via = img.via;
    out.ext = img.ext;
    out.bytes = bytes;
    out.used_negative = neg;
    writeJSON(res, 200, out);
}

// -- Công cụ tiện ích --

// previewOf Bảng điều khiển xem trước (preview): Có byte thì dùng data URL; Chỉ có link từ xa (giáng cấp (fallback) do cross-domain) thì đưa thẳng link.
function previewOf(img) {
    if (img.data && img.data.length) {
        return `data:${mimeForExt(img.ext)};base64,${bytesToBase64(img.data)}`;
    }
    return img.remoteUrl ?? '';
}

// defaultSizeWH Phân tích kích thước mặc định, dự phòng (fallback) là 1024x1024 (Tương ứng defaultSizeWH bản Go).
function defaultSizeWH() {
    const s = normalizeSizeStr(settingsGet.defaultSize()) ?? '1024x1024';
    const [w, h] = s.split('x').map(v => parseInt(v, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [1024, 1024];
    return [w, h];
}

function formatTime(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// -- Lối vào tổng --

/**
 * handleAdminRequest Xử lý request /admin/*.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} Đã xử lý hay chưa
 */
export async function handleAdminRequest(req, res, url) {
    const p = normalizePath(url.pathname);

    // Endpoint công khai
    if (p === '/admin/status') return handleAdminStatus(req, res), true;
    if (p === '/admin/auth/status') return handleAuthStatus(req, res), true;

    // Liên quan đến đăng nhập (Tự phán đoán trạng thái đăng nhập)
    if (p === '/admin/auth/login') { await handleAuthLogin(req, res); return true; }
    if (p === '/admin/auth/setup') { await handleAuthSetup(req, res); return true; }
    if (p === '/admin/auth/logout') return handleAuthLogout(req, res), true;

    // Các phần còn lại yêu cầu đăng nhập bảng điều khiển (Khi chưa đặt mật khẩu thì cho qua)
    const routes = {
        '/admin/settings': handleAdminSettings,
        '/admin/test': handleAdminTest,
        '/admin/translate': handleAdminTranslate,
        '/admin/logs': (rq, rs) => handleAdminLogs(rq, rs, url),
    };
    const handler = routes[p];
    if (!handler) return false;

    if (!panelOK(req)) {
        writeAdminErr(res, 401, 'Bảng điều khiển đã bị khóa: Vui lòng đăng nhập trước');
        return true;
    }
    await handler(req, res);
    return true;
}

function normalizePath(p) {
    const s = String(p ?? '/');
    const t = s.replace(/\/+$/, '');
    return t === '' ? '/' : t;
}