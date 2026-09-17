// index.js — Bootloader server của V.Adapter (vị trí triển khai <SillyTavern>/plugins/V.Adapter/).
//
// SillyTavern có hai giới hạn nền tảng: plugin server chỉ được load một lần khi tiến trình (process) khởi động, và không cung cấp bất kỳ cổng vào (entry) cài đặt nào.
// Tác dụng của file này là cách ly hai giới hạn đó ra - bản thân nó không chứa logic nghiệp vụ, cũng không thay đổi theo phiên bản,
// chỉ load bản triển khai (implementation) thực sự bên dưới extensions/<thư mục extension>/server-plugin/ theo nhu cầu trong tiến trình của SillyTavern.
//
// Hiệu quả đạt được từ việc này:
//   - Bản triển khai server được phân phối cùng với extension, sau khi pull thông qua "Install Extension" thì không cần copy lại code plugin nữa;
//   - Sau khi cập nhật bản triển khai, chỉ cần reload là có hiệu lực, không cần khởi động lại tiến trình SillyTavern;
//   - Dữ liệu hoạt động được giữ lại ở plugins/V.Adapter/data/, tách biệt (decouple) với vị trí chứa code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'Bootloader dịch vụ tương thích giao thức NovelAI: Load bản triển khai server bên trong extension V.Adapter theo nhu cầu.',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');

let impl = null;
let busy = false;

// safeReaddir Đọc các mục trong thư mục; trả về mảng rỗng khi không thể đọc.
function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// candidateRoots Liệt kê các thư mục có thể chứa extension.
// Khi context request khả dụng thì ưu tiên dùng nó; trong giai đoạn auto-start không có request, lùi về (fallback) data/<user>/extensions dưới thư mục làm việc của tiến trình.
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

// findImplFile Tìm kiếm server-plugin/index.js.
// Tên thư mục extension lấy từ tên repo, ở đây quét từng lớp để tương thích với các cách đặt tên khác nhau.
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

// loadImpl Load động (dynamic load) bản triển khai server.
// Đính kèm timestamp vào URL để vượt qua (bypass) cache module ESM, giúp code sau khi cập nhật có thể sử dụng ngay trong cùng một lần chạy.
async function loadImpl(file) {
    process.env.VADAPTER_DATA_DIR = DATA_DIR;
    return await import(pathToFileURL(file).href + '?v=' + Date.now());
}

// statusOf Đọc trạng thái hoạt động do bản triển khai báo cáo; xử lý như trạng thái đã dừng khi bản triển khai chưa được load.
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

    // reload Dùng để load bản triển khai sau khi cập nhật: giải phóng port và tài nguyên trước, sau đó đọc code mới trên cùng đường dẫn.
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

// autoStart Cố gắng gọi (pull up) dịch vụ giao thức khi SillyTavern khởi động, giúp hành vi của server nhất quán với các plugin thông thường:
// Sau khi khởi động lại, có thể cung cấp port :8888 ra bên ngoài mà không cần can thiệp thủ công.
// Thất bại cũng không cản trở SillyTavern khởi động, lúc này ngăn extension (drawer) sẽ hiển thị dịch vụ không khả dụng, để người dùng tự xử lý.
// Thiết lập VADAPTER_AUTOSTART=0 có thể tắt hành vi này, chuyển sang khởi động/dừng hoàn toàn thủ công.
async function autoStart() {
    if (String(process.env.VADAPTER_AUTOSTART ?? '1') === '0') return;
    try {
        await startImpl({});
        console.info('[V.Adapter] Dịch vụ giao thức đã khởi động cùng SillyTavern');
    } catch (err) {
        console.warn(`[V.Adapter] Dịch vụ giao thức không khởi động cùng SillyTavern: ${err?.message ?? err}`);
    }
}

/** Giải phóng port và tài nguyên khi SillyTavern thoát. */
export async function exit() {
    await stopImpl({});
}