// server.js — Dịch vụ HTTP nhúng (Gộp route + CORS).
//
// Tương ứng với main() của main.go bản Go: Gộp các endpoint giao thức NAI, endpoint bảng quản lý, bảng điều khiển nhúng single-file
// vào một **port lắng nghe độc lập** (Mặc định 8888, có thể đổi trên bảng điều khiển, khởi động lại sẽ có hiệu lực).
//
// Nguyên nhân sử dụng port lắng nghe độc lập thay vì route của chính SillyTavern: Phía server của SillyTavern có bảo vệ CSRF, client bên thứ ba
// trực tiếp gửi request đến route plugin của SillyTavern sẽ bị chặn 403. Việc plugin tự mở port có thể lách giới hạn này, đồng thời **giữ nguyên cách kết nối của bản gốc**
// (URL kênh NovelAI của client vẫn điền IP:8888, không cần sửa).
//
// Danh sách route:
//   POST /ai/generate-image     NAI Sinh ảnh -> ZIP (Cần nai_key)
//   GET  /ai/user/subscription  Test kết nối (Cần nai_key)
//   POST /ai/encode-vibe        Không hỗ trợ -> 404
//   GET  /admin/*               Endpoint bảng quản lý (Xem admin.js)
//   GET  /health                Kiểm tra sức khỏe (Health check)
//   GET  /                      Bảng quản lý nhúng (panel.html)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSettings, settingsGet, bindResetImagesBroken } from './settings.js';
import { handleGenerateImage, handleSubscription, handleEncodeVibe, naiKeyGate } from './nai.js';
import { resetImagesBroken, logf } from './pipeline.js';
import { initAuth, handleAdminRequest, setRuntime, writeJSON } from './admin.js';

export const version = 'v1.1.5-st.1';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // plugins/V.Adapter
const panelPath = path.join(pluginDir, 'panel.html');

const startedAt = new Date();
let server = null;
let boundListen = '';
let started = false;

// -- Ngữ cảnh request (Processor của nai.js gọi theo (req, res, ctx)) --

// readBody Đọc toàn bộ request body (Giới hạn maxBytes), trả về Buffer.
function readBody(req, maxBytes = 32 << 20) {
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
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// ctxFor Khởi tạo ngữ cảnh processor theo request (Trong nai.js gọi là ctx.readBody(giới hạn), không truyền req) --
// Do đó readBody bắt buộc phải bind trước với request hiện tại.
function ctxFor(req) {
    return {
        readBody: (maxBytes) => readBody(req, maxBytes),
        logf,
    };
}

// -- Bảng điều khiển nhúng: Inject cầu nối API --

let panelHTMLCache = null;

// panel.html vốn dĩ dành cho "Bản extension", nó gửi request qua window.parent.__V_ADAPTER_API__.
// Dưới hình thái server-side, bảng điều khiển được mở trực tiếp (window.parent === window), do đó trong HTML trả về
// sẽ inject trước một cầu nối cùng tên (Chuyển sang đi qua HTTP thực sự), **bản thân panel.html không cần sửa một dòng nào**.
const API_SHIM = `<script>
window.__V_ADAPTER_API__ = (function () {
    return async function (path, method, body) {
        var opts = { method: method || 'GET', headers: { 'Accept': 'application/json' }, credentials: 'same-origin' };
        if (method && method !== 'GET' && method !== 'HEAD' && body !== null && body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        try {
            var r = await fetch(path, opts);
            var data = null;
            try { data = await r.json(); } catch (e) { data = null; }
            return { ok: r.ok, status: r.status, data: data };
        } catch (e) {
            return { ok: false, status: 0, data: { success: false, error: 'Kết nối dịch vụ local thất bại: ' + e.message } };
        }
    };
})();
</script>`;

function loadPanel() {
    if (panelHTMLCache !== null) return panelHTMLCache;
    try {
        let html = fs.readFileSync(panelPath, 'utf8');
        const headRe = /<head[^>]*>/i;
        if (headRe.test(html)) {
            html = html.replace(headRe, m => m + '\n' + API_SHIM);
        } else {
            html = API_SHIM + '\n' + html;
        }
        panelHTMLCache = html;
    } catch (e) {
        panelHTMLCache = `<pre>Đọc bảng quản lý thất bại: ${e.message}\nFile kỳ vọng: ${panelPath}</pre>`;
    }
    return panelHTMLCache;
}

// -- Route --

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    // Trình duyệt (Bảng điều khiển V.Canvas, v.v...) cần đọc các header này mới có thể lấy được prompt và thông tin luồng thực tế gửi lên tuyến trên.
    res.setHeader('Access-Control-Expose-Headers', 'X-Illust-Via, X-Illust-Prompt, X-Illust-Expand');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function normalizePath(p) {
    const s = String(p ?? '/');
    const t = s.replace(/\/+$/, '');
    return t === '' ? '/' : t;
}

async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = normalizePath(url.pathname);
    const ctx = ctxFor(req);

    if (p === '/health') {
        writeJSON(res, 200, { status: 'ok', version });
        return;
    }

    // -- Endpoint giao thức NovelAI (Client gọi) --
    if (p === '/ai/generate-image') {
        await naiKeyGate(handleGenerateImage)(req, res, ctx);
        return;
    }
    if (p === '/ai/user/subscription') {
        await naiKeyGate(handleSubscription)(req, res, ctx);
        return;
    }
    if (p === '/ai/encode-vibe') {
        handleEncodeVibe(req, res, ctx);
        return;
    }

    // -- Endpoint bảng quản lý --
    if (p === '/admin' || p.startsWith('/admin/')) {
        const handled = await handleAdminRequest(req, res, url);
        if (!handled) writeJSON(res, 404, { success: false, error: `Không tìm thấy endpoint: ${p}` });
        return;
    }

    // -- Bảng điều khiển nhúng --
    if (p === '/') {
        const html = loadPanel();
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
    }

    writeJSON(res, 404, { message: `Không tìm thấy endpoint: ${p}` });
}

// -- Khởi động / Dừng --

/**
 * startAdapterService Khởi động dịch vụ adapter nhúng (Do init của server plugin SillyTavern gọi).
 * Port lấy từ listen của settings (Mặc định 0.0.0.0:8888).
 */
export async function startAdapterService() {
    if (started) return { listen: boundListen };

    initSettings();
    initAuth();
    bindResetImagesBroken(resetImagesBroken);
    setRuntime({ version, startedAt });

    const listen = settingsGet.listen();
    const { host, port } = splitListen(listen);

    server = http.createServer((req, res) => {
        applyCors(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        route(req, res).catch(err => {
            logf(`[HTTP] Xử lý ${req.method} ${req.url} gặp lỗi: ${err?.message ?? err}`);
            if (!res.headersSent) writeJSON(res, 500, { message: 'Lỗi nội bộ: ' + (err?.message ?? err) });
            else res.end();
        });
    });

    server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        server.once('error', (err) => {
            const hint = (err && err.code === 'EADDRINUSE')
                ? `: Port ${port} đã bị chiếm dụng (Có thể bản Go V.Adapter hoặc instance khác vẫn đang chạy, vui lòng dừng lại rồi khởi động lại SillyTavern)`
                : `: ${err?.message ?? err}`;
            logf(`[Startup] ✗ Dịch vụ adapter khởi động thất bại${hint}`);
            server = null;
            finish();
        });

        server.listen(port, host, () => {
            boundListen = listen;
            started = true;
            logf(`[Startup] ✓ Dịch vụ adapter đã khởi động: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/  (Bảng quản lý)`);
            logf(`[Startup] Kết nối client: URL kênh NovelAI điền http://<IP máy bạn>:${port} (Không kèm /ai), Key điền nai_key của server`);
            logf(`[Startup] Tuyến trên: ${settingsGet.qwenURL() || '(Chưa cấu hình)'} | Model: ${settingsGet.qwenModel() || '-'} | Luồng: ${settingsGet.chatFallback()}`);
            finish();
        });
    });

    return { listen: boundListen };
}

/** stopAdapterService Dừng dịch vụ nhúng (Gọi khi SillyTavern thoát). */
export async function stopAdapterService() {
    if (!server) {
        started = false;
        return;
    }
    const s = server;
    server = null;
    started = false;
    boundListen = '';
    await new Promise((resolve) => {
        try {
            s.close(() => resolve());
        } catch {
            resolve();
        }
        // Dự phòng: Trong 1.5s chưa đóng sạch thì ép ngắt kết nối (Nếu không SillyTavern khi thoát sẽ bị treo)
        setTimeout(() => {
            try { s.closeAllConnections?.(); } catch { /* Bỏ qua */ }
            resolve();
        }, 1500);
    });
}

/** getAdapterStatus Trạng thái read-only dành cho route /api/plugins/v-adapter/status của SillyTavern sử dụng. */
export function getAdapterStatus() {
    return {
        running: started,
        listen: boundListen || settingsGet.listen(),
        version,
        upstream: settingsGet.qwenURL(),
        model: settingsGet.qwenModel(),
        chat_fallback: settingsGet.chatFallback(),
    };
}

// splitListen Tách "0.0.0.0:8888" / "127.0.0.1:8888" / ":8888" thành host + port.
function splitListen(listen) {
    const s = String(listen ?? '').trim() || '0.0.0.0:8888';
    const idx = s.lastIndexOf(':');
    let host = idx >= 0 ? s.slice(0, idx).trim() : '';
    const port = parseInt(idx >= 0 ? s.slice(idx + 1) : s, 10);
    if (!host) host = '0.0.0.0';
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { host: '0.0.0.0', port: 8888 };
    return { host, port };
}