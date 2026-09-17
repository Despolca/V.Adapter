#!/usr/bin/env node
// install-loader.mjs -- Tự động triển khai bootloader server V.Adapter.
//
// Làm ba việc, tất cả đều tự động hoàn thành, không cần chỉnh sửa thủ công bất kỳ file nào:
//   1) Định vị thư mục gốc của SillyTavern (Mặc định tìm ngược lên từ vị trí của script này, cũng có thể dùng tham số dòng lệnh hoặc ST_ROOT để chỉ định)
//   2) Copy bootstrap/ vào <SillyTavern>/plugins/V.Adapter/
//   3) Đổi enableServerPlugins của config.yaml thành true (File gốc sẽ tự động backup)
//
// Cách dùng:
//   node install-loader.mjs                 // Tự động định vị
//   node install-loader.mjs /path/to/ST     // Chỉ định thủ công thư mục gốc SillyTavern
//
// Hoàn tất xong cần khởi động lại SillyTavern một lần, sau đó "Dịch vụ giao thức" sẽ tự động khởi động cùng SillyTavern, không cần thêm bất kỳ cấu hình nào nữa.

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
    // Khi script này nằm ở <ST>/data/<user>/extensions/<extension>/, lùi lên 4 cấp chính là thư mục gốc
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

// 2) Copy bootloader
if (!fs.existsSync(path.join(bootDir, 'index.js'))) {
    log('[Thất bại] Không tìm thấy bootstrap/index.js, vui lòng chạy script này từ bên trong thư mục extension.');
    process.exit(1);
}

const pluginDir = path.join(stRoot, 'plugins', PLUGIN_NAME);
fs.mkdirSync(path.join(pluginDir, 'data'), { recursive: true });
fs.copyFileSync(path.join(bootDir, 'index.js'), path.join(pluginDir, 'index.js'));
fs.copyFileSync(path.join(bootDir, 'package.json'), path.join(pluginDir, 'package.json'));
log('Bootloader đã được cài đặt: ' + pluginDir);

// 3) Bật server plugin
const cfgPath = path.join(stRoot, 'config.yaml');
let cfg = fs.readFileSync(cfgPath, 'utf8');
const m = cfg.match(/^(\s*enableServerPlugins:\s*)(false|true)\s*$/m);

if (!m) {
    log('[Chú ý] Trong config.yaml không có mục enableServerPlugins, đã tự động thêm vào.');
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/\s*$/, '\n') + '\nenableServerPlugins: true\n';
    fs.writeFileSync(cfgPath, cfg);
    log('Đã thêm vào enableServerPlugins: true (Backup: ' + bak + ')');
} else if (m[2] === 'true') {
    log('config.yaml đã bật server plugin, không cần thay đổi gì thêm.');
} else {
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/^(\s*enableServerPlugins:\s*)false\s*$/m, '$1true');
    fs.writeFileSync(cfgPath, cfg);
    log('config.yaml đã được đổi thành enableServerPlugins: true (Backup: ' + bak + ')');
}

log('');
log('Hoàn tất. Bước tiếp theo: Khởi động lại SillyTavern một lần.');
log('Sau khi khởi động lại, "Dịch vụ giao thức" trong ngăn extension sẽ tự động khởi động cùng SillyTavern;');
log('Chỉ khi nào cần dùng plugin sinh ảnh SillyTavern của bên thứ ba thì mới cần đến nó, V.Canvas mặc định sẽ đi qua kết nối trực tiếp trong trang.');