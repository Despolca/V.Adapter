// index.js - Loader service của V.Adapter (Vị trí deploy <SillyTavern>/plugins/V.Adapter/).
//
// SillyTavern có hai giới hạn nền tảng: plugin server chỉ được load một lần khi khởi động tiến trình, và không cung cấp bất kỳ cổng cài đặt nào.
// Tác dụng của file này là cách ly hai giới hạn đó - bản thân nó không chứa business logic, cũng không thay đổi theo phiên bản,
// mà chỉ load các implementation thực tế nằm trong extensions/<thư mục extension>/server-plugin/ theo nhu cầu bên trong tiến trình của SillyTavern.
//
// Hiệu quả đạt được:
//   - Implementation của server được phân phối cùng với extension, sau khi pull về qua "Install Extension" thì không cần copy code của plugin nữa;
//   - Sau khi implementation cập nhật, chỉ cần reload là có tác dụng, không cần khởi động lại tiến trình SillyTavern;
//   - Dữ liệu chạy được giữ lại trong plugins/V.Adapter/data/, tách biệt (decoupled) với vị trí chứa code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'Loader service tương thích giao thức NovelAI: Load implementation của server nằm trong extension V.Adapter theo nhu cầu.',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');

let impl = null;
let busy = false;

// safeReaddir đọc các mục trong thư mục; khi không thể đọc thì trả về mảng rỗng.
function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// candidateRoots liệt kê các thư mục có thể chứa extension.
// Ưu tiên sử dụng request context nếu có sẵn; trong giai đoạn tự động khởi động (auto-start) không có request, sẽ lùi về data/<user>/extensions dưới thư mục làm việc của tiến trình.
function candidateRoots(req) {
    const roots = [];
    const fromRequest = String(req?.user?.directories?.extensions ?? '');
    if (fromRequest) roots.push(fromRequest);

    const fromEnv = String(process.env.VADAPTER_EXT_DIR ?? '');
    if (fromEnv) roots.push(fromEnv);

    const usersData = path.join(process.cwd(), 'data');
    for (const entry of safeReaddir(usersData)) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(usersData, entry.name, 'extensions');
        if (fs.existsSync(candidate)) roots.push(candidate);
    }
    return roots;
}

// findImplFile tìm kiếm server-plugin/index.js.
// Tên thư mục extension lấy từ tên repository, ở đây quét từng lớp để tương thích với các cách đặt tên khác nhau.
function findImplFile(req) {
    for (const root of candidateRoots(req)) {
        if (!root || !fs.existsSync(root)) continue;
        for (const entry of safeReaddir(root)) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(root, entry.name, 'server-plugin', 'index.js');
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return '';
}

// loadImpl load động implementation của server.
// Thêm timestamp vào URL để bypass cache module ESM, giúp code sau khi cập nhật có thể sử dụng ngay trong cùng một lần chạy.
async function loadImpl(file) {
    process.env.VADAPTER_DATA_DIR = DATA_DIR;
    return await import(pathToFileURL(file).href + '?v=' + Date.now());
}

// statusOf đọc trạng thái hoạt động do implementation báo cáo; nếu implementation chưa được load thì xử lý như trạng thái đã dừng.
function statusOf(req) {
    const file = findImplFile(req);
    const base = {
        installed: Boolean(file),
        implFile: file,
        dataDir: DATA_DIR,
        running: false,
        listen: '',
        version: '',
    };
    if (!impl || typeof impl.getAdapterStatus !== 'function') return base;
    try {
        const st = impl.getAdapterStatus() || {};
        return {
            ...base,
            running: Boolean(st.running),
            listen: st.listen || '',
            version: st.version || '',
            upstream: st.upstream || '',
            model: st.model || '',
        };
    } catch {
        return base;
    }
}

async function startImpl(req) {
    const file = findImplFile(req);
    if (!file) throw new Error('Không tìm thấy server-plugin/index.js trong thư mục extension');
    impl = await loadImpl(file);
    await impl.init(null);
    return statusOf(req);
}

async function stopImpl(req) {
    if (impl && typeof impl.exit === 'function') {
        await impl.exit();
    }
    impl = null;
    return statusOf(req);
}

export async function init(router) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    router.get('/status', (req, res) => {
        res.json({ ok: true, ...statusOf(req) });
    });

    router.post('/start', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: 'Thao tác trước đó vẫn chưa kết thúc' });
        busy = true;
        try {
            if (statusOf(req).running) {
                return res.json({ ok: true, already: true, ...statusOf(req) });
            }
            const st = await startImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            impl = null;
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    router.post('/stop', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: 'Thao tác trước đó vẫn chưa kết thúc' });
        busy = true;
        try {
            const st = await stopImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    // reload dùng để load implementation đã cập nhật: giải phóng port và tài nguyên trước, sau đó đọc code mới trên cùng một đường dẫn.
    router.post('/reload', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: 'Thao tác trước đó vẫn chưa kết thúc' });
        busy = true;
        try {
            await stopImpl(req);
            const st = await startImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            impl = null;
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    await autoStart();
}

// autoStart cố gắng khởi chạy service giao thức khi SillyTavern khởi động, giúp hành vi của server đồng nhất với các plugin thông thường:
// Sau khi khởi động lại, không cần can thiệp thủ công vẫn có thể cung cấp port :8888 ra bên ngoài.
// Nếu thất bại cũng không chặn việc khởi động của SillyTavern, lúc này ngăn kéo sẽ hiển thị service không khả dụng, do người dùng tự xử lý.
// Đặt VADAPTER_AUTOSTART=0 có thể tắt hành vi này, chuyển sang bật/tắt hoàn toàn thủ công.
async function autoStart() {
    if (String(process.env.VADAPTER_AUTOSTART ?? '1') === '0') return;
    try {
        await startImpl({});
        console.info('[V.Adapter] Service giao thức đã khởi động cùng SillyTavern');
    } catch (err) {
        console.warn(`[V.Adapter] Service giao thức không khởi động cùng SillyTavern: ${err?.message ?? err}`);
    }
}

/** Giải phóng port và tài nguyên khi SillyTavern thoát. */
export async function exit() {
    await stopImpl({});
}