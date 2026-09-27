#!/usr/bin/env node
// install-loader.mjs -- Tự động deploy loader của plugin server V.Adapter.
//
// Thực hiện 3 việc, tất cả đều tự động, không cần chỉnh sửa thủ công bất kỳ file nào:
//   1) Định vị thư mục gốc SillyTavern (mặc định tìm ngược lên trên từ vị trí script này, cũng có thể chỉ định bằng tham số dòng lệnh hoặc ST_ROOT)
//   2) Copy bootstrap/ vào <SillyTavern>/plugins/V.Adapter/
//   3) Sửa enableServerPlugins trong config.yaml thành true (Tự động sao lưu file gốc)
//
// Cách dùng:
//   node install-loader.mjs                 // Tự động định vị
//   node install-loader.mjs /path/to/ST     // Chỉ định thủ công thư mục gốc SillyTavern
//
// Sau khi hoàn tất cần khởi động lại SillyTavern một lần, sau đó "Service giao thức" sẽ tự động khởi động cùng SillyTavern, không cần cấu hình thêm.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bootDir = path.join(here, 'bootstrap');
const PLUGIN_NAME = 'V.Adapter';

const log = (s) => console.log(s);

function isStRoot(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    const hasConfig = fs.existsSync(path.join(dir, 'config.yaml'));
    const hasServer = fs.existsSync(path.join(dir, 'server.js'));
    return hasConfig && hasServer;
}

// 1) Định vị thư mục gốc SillyTavern
function findStRoot() {
    const arg = process.argv[2];
    if (arg) {
        const p = path.resolve(arg);
        return isStRoot(p) ? p : null;
    }
    if (process.env.ST_ROOT && isStRoot(process.env.ST_ROOT)) {
        return path.resolve(process.env.ST_ROOT);
    }
    // Khi script này nằm ở <ST>/data/<user>/extensions/<extension>/, lùi lên trên 4 cấp sẽ là thư mục gốc
    let cur = here;
    for (let i = 0; i < 6; i++) {
        cur = path.dirname(cur);
        if (isStRoot(cur)) return cur;
    }
    return null;
}

const stRoot = findStRoot();
if (!stRoot) {
    log('[Thất bại] Không thể tự động tìm thấy thư mục gốc SillyTavern.');
    log('       Vui lòng chỉ định thủ công, ví dụ:');
    log('         node install-loader.mjs "C:\\SillyTavern"');
    log('         node install-loader.mjs /root/SillyTavern');
    process.exit(1);
}

log('Thư mục SillyTavern: ' + stRoot);

// 2) Copy loader
if (!fs.existsSync(path.join(bootDir, 'index.js'))) {
    log('[Thất bại] Không tìm thấy bootstrap/index.js, vui lòng chạy script này từ bên trong thư mục extension.');
    process.exit(1);
}

const pluginDir = path.join(stRoot, 'plugins', PLUGIN_NAME);
fs.mkdirSync(path.join(pluginDir, 'data'), { recursive: true });
fs.copyFileSync(path.join(bootDir, 'index.js'), path.join(pluginDir, 'index.js'));
fs.copyFileSync(path.join(bootDir, 'package.json'), path.join(pluginDir, 'package.json'));
log('Loader đã được cài đặt: ' + pluginDir);

// 3) Bật plugin server
const cfgPath = path.join(stRoot, 'config.yaml');
let cfg = fs.readFileSync(cfgPath, 'utf8');
const m = cfg.match(/^(\s*enableServerPlugins:\s*)(false|true)\s*$/m);

if (!m) {
    log('[Chú ý] Trong config.yaml không có mục enableServerPlugins, đã tự động thêm vào.');
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/\s*$/, '\n') + '\nenableServerPlugins: true\n';
    fs.writeFileSync(cfgPath, cfg);
    log('Đã thêm enableServerPlugins: true (Bản backup: ' + bak + ')');
} else if (m[2] === 'true') {
    log('config.yaml đã bật plugin server, không cần thay đổi.');
} else {
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/^(\s*enableServerPlugins:\s*)false\s*$/m, '$1true');
    fs.writeFileSync(cfgPath, cfg);
    log('config.yaml đã được sửa thành enableServerPlugins: true (Bản backup: ' + bak + ')');
}

log('');
log('Hoàn tất. Bước tiếp theo: Khởi động lại SillyTavern một lần.');
log('Sau khi khởi động lại, "Service giao thức" trong ngăn kéo extension sẽ tự động khởi động cùng SillyTavern;');
log('Chỉ cần nó khi sử dụng plugin tạo ảnh SillyTavern của bên thứ ba, V.Canvas mặc định kết nối trực tiếp trong trang.');