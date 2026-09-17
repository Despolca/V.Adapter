// index.js — Cổng vào extension SillyTavern của V.Adapter.
// Port từ V.Adapter (Go) v1.1.4: Bản thân extension chính là engine xuất ảnh (kết nối tuyến trên / fallback bằng chat /
// ngắt mạch / xóa watermark / biên dịch nhân vật / lịch sử sinh ảnh / bảng quản lý), cài đặt xong là xuất ảnh được ngay.
// Tương ứng: Khối chính handleGenerateImage của bản Go -> runGeneration() của file này;
// Endpoint bảng quản lý -> lib/virtual-api.js; UI bảng điều khiển -> panel.html.
//
// Ranh giới trách nhiệm: Extension này là engine và tầng điều khiển, phụ trách "vẽ như thế nào" (kết nối tuyến trên, chuyển đổi giao thức,
//           xóa watermark, lịch sử sinh ảnh, cổng giao thức 8888). Việc lắng nghe AI phản hồi để tự động xuất ảnh thuộc trách nhiệm của tầng trình diễn (presentation layer),
//           do V.Canvas đảm nhận, extension này không can thiệp.
//
// Art style: Extension này không cung cấp preset art style nữa. Art style do bên tiêu thụ (trang "Prompt" của V.Canvas,
//       plugin sinh ảnh của bên thứ ba) tự quyết định, request chuyển tiếp qua :8888 sẽ gửi nguyên vẹn input mà client cung cấp.

import { eventSource, event_types, systemUserName, getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { saveBase64AsFile } from '/scripts/utils.js';
import { getMessageTimeStamp } from '/scripts/RossAscends-mods.js';
import { MEDIA_TYPE, MEDIA_SOURCE, MEDIA_DISPLAY } from '/scripts/constants.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '/scripts/slash-commands/SlashCommandArgument.js';

import { initSettings, bindResetImagesBroken, settingsGet, normalizeSizeStr } from './lib/settings.js';
import { genLog, newRecord } from './lib/genlog.js';
import { generateImage, resetImagesBroken, truncate, bytesToBase64, logf } from './lib/pipeline.js';
import { translateCharacter } from './lib/translate.js';
import { handleApi } from './lib/virtual-api.js';

// Thiết lập namespace (Giữ identifier in thường, làm key lưu trữ cho extension_settings, không thay đổi theo tên hiển thị).
export const MODULE_NAME = 'v-adapter';
const version = 'v1.1.5-st.1';

// -- Khởi tạo --
export async function init() {
    initSettings();
    bindResetImagesBroken(resetImagesBroken);

    addSettingsUI();
    registerSlashCommand();
    logf(`Đã load (${version}): Bản thân extension chính là engine xuất ảnh, cài đặt xong là dùng được ngay`);
}

export async function exit() {
    $(`#v_adapter_drawer`).remove();
    $('#v_adapter_panel_overlay').remove();
}

// -- Luồng xuất ảnh chính (Tương ứng với khối chính handleGenerateImage của bản Go) --

// runGeneration Sinh ra một bức ảnh và lưu lại lịch sử.
//   prompt       Từ khóa tích cực (Bắt buộc)
//   neg          Từ khóa phủ định (Có thể để trống; pipeline sẽ tự động giáng cấp loại bỏ khi interface tiêu chuẩn thất bại)
//   size         "RộngxCao" (Có thể để trống = dùng kích thước mặc định)
// Trả về { result } hoặc throw exception (Thông báo lỗi đều là văn bản dễ đọc hướng đến người dùng).
async function runGeneration(prompt, neg, size) {
    const start = Date.now();
    prompt = String(prompt ?? '').trim();
    neg = String(neg ?? '').trim();

    // Kích thước: Fallback về kích thước mặc định, clamp 64..2048 (Giống với endpoint NAI bản Go)
    const defWH = parseWH(settingsGet.defaultSize());
    let width = defWH.w, height = defWH.h;
    const given = normalizeSizeStr(size);
    if (given) {
        const g = parseWH(given);
        width = Math.min(2048, Math.max(64, g.w));
        height = Math.min(2048, Math.max(64, g.h));
    }
    size = `${width}x${height}`;

    const target = {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
    const rec = newRecord({
        kind: 'generate', endpoint: '/ai/generate-image', model: target.model,
        prompt: truncate(prompt, 80), size,
    });

    if (!prompt) {
        rec.status = 400;
        rec.error = 'Từ khóa tích cực (input) bị rỗng';
        genLog.Add(rec);
        throw new Error('Từ khóa tích cực (input) bị rỗng, client chưa ghép được từ khóa tích cực');
    }

    logf(`[Gen] Request sinh ảnh size=${size} Từ khóa phủ định=${[...neg].length} chữ Từ khóa tích cực=${[...prompt].length} chữ`);

    let result, gerr = null;
    try {
        result = await generateImage(target, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    rec.latency_ms = Date.now() - start;
    if (gerr) {
        rec.ok = false;
        rec.status = 502;
        rec.via = 'images';
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        logf(`[Gen] Sinh ảnh thất bại (${rec.latency_ms}ms): ${gerr.message}`);
        throw gerr;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = result.via;
    genLog.Add(rec);
    logf(`[Gen] Sinh ảnh thành công (${rec.latency_ms}ms via ${result.via}): ${size} ${result.ext} ${Math.floor((result.data?.length ?? 0) / 1024)}KB`);
    return result;
}

function parseWH(s) {
    const [w, h] = String(s ?? '1024x1024').split('x').map(v => parseInt(v, 10) || 0);
    return { w: w > 0 ? w : 1024, h: h > 0 ? h : 1024 };
}

// -- Kết quả xuất ảnh đưa vào khung chat (Theo tư thế tin nhắn media chính thức, giống với extension sd của SillyTavern) --

async function deliverToChat(result, title) {
    const context = getContext();
    const name = context.groupId ? systemUserName : context.name2;

    let url;
    if (result.data) {
        const b64 = bytesToBase64(result.data);
        const filename = `${name}_${Date.now()}`;
        url = await saveBase64AsFile(b64, name, filename, result.ext);
    } else if (result.remoteUrl) {
        url = result.remoteUrl; // Giáng cấp CORS: Trực tiếp trích dẫn ảnh từ xa (Trình duyệt hiển thị không cần cross-domain)
    } else {
        throw new Error('Kết quả sinh ảnh bị rỗng');
    }

    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: title ?? '',
        extra: {
            media: [{
                url: url,
                type: MEDIA_TYPE.IMAGE,
                title: title ?? '',
                source: MEDIA_SOURCE.GENERATED,
            }],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    try { context.scrollOnMediaLoad?.(); } catch { /* Phiên bản cũ không có phương thức này */ }
    return url;
}

// Sinh ảnh và chèn vào (Dùng chung cho /vgen, ngăn extension, tự động xuất ảnh).
async function generateAndDeliver({ text, translate = false, size = '' }) {
    if (!text || !text.trim()) {
        toastr.error('Vui lòng nhập prompt hoặc mô tả', 'V.Adapter');
        return;
    }
    let prompt = text.trim();
    let neg = '';
    if (translate) {
        toastr.info('Đang biên dịch mô tả ...', 'V.Adapter');
        const target = {
            url: settingsGet.qwenURL(),
            key: settingsGet.qwenKey(),
            model: settingsGet.qwenModel(),
        };
        const r = await translateCharacter(target, prompt);
        prompt = r.prompt;
        neg = r.negative_prompt;
        if (size === '') size = `${r.width}x${r.height}`;
    }
    toastr.info('Đang sinh ảnh, vui lòng đợi (Mỗi tấm khoảng 30~60s)...', 'V.Adapter');
    const result = await runGeneration(prompt, neg, size);
    await deliverToChat(result, truncate(prompt, 100));
    toastr.success(`Xuất ảnh hoàn tất (Luồng ${result.via})`, 'V.Adapter');
}

// -- Lệnh /vgen --

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vgen',
        callback: async (namedArgs, unnamedArgs) => {
            const text = String(unnamedArgs ?? '').trim();
            const translate = !(namedArgs.translate === 'false');
            const size = namedArgs.size ?? '';
            try {
                await generateAndDeliver({ text, translate, size });
            } catch (err) {
                toastr.error(String(err?.message ?? err), 'V.Adapter Xuất ảnh thất bại', { timeout: 10000 });
            }
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'translate',
                description: 'Trước tiên coi nội dung là mô tả để biên dịch thành prompt (Mặc định true); false = Trực tiếp coi nội dung là prompt để xuất ảnh',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'size',
                description: 'Kích thước ảnh (RộngxCao, ví dụ 832x1216); Mặc định dùng kích thước mặc định trong trung tâm cài đặt',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Prompt hoặc mô tả (Là mô tả ngôn ngữ tự nhiên khi translate=true)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                Dùng V.Adapter (Sinh ảnh tương thích OpenAI tuyến trên) sinh ra một bức ảnh và gửi vào khung chat.<br />
                Ví dụ: /vgen Một chú mèo mập màu cam nằm phơi nắng trên bệ cửa sổ &nbsp;&nbsp; /vgen translate=false size=832x1216 1girl, silver hair, school uniform
            </div>
        `,
    }));
}

// -- Popup bảng quản lý (Giữ lại panel.html 1:1, gọi endpoint tích hợp thông qua cầu nối) --
//
// Mở theo cách nhúng iframe: Không đi qua window.open, tránh bị chặn popup trên điện thoại.
// Địa chỉ bảng điều khiển dùng URL thật (src), không dùng srcdoc -- srcdoc bị hạn chế trên một số trình duyệt điện thoại và
// WebView trong app, sẽ dẫn đến nội dung bảng bị trắng bóc. Chiều cao overlay được fallback bằng 100vh của CSS,
// và được gán giá trị pixel chính xác theo viewport hiển thị bằng bindPanelFit, khi nhúng thất bại sẽ đưa ra thông báo và cung cấp cổng vào mở tab mới.

let panelFitHandler = null;

// Chiều cao overlay được gán chính xác theo viewport hiển thị: Thanh địa chỉ trình duyệt mobile thu gọn/mở ra, chuyển đổi xoay ngang dọc màn hình đều sẽ làm thay đổi chiều cao hiển thị.
function fitPanelHeight(el) {
    const h = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight || 0);
    if (h > 0) el.style.height = h + 'px';
}

function bindPanelFit(el) {
    panelFitHandler = () => fitPanelHeight(el);
    fitPanelHeight(el);
    window.addEventListener('resize', panelFitHandler);
    window.addEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', panelFitHandler);
}

function unbindPanelFit() {
    if (!panelFitHandler) return;
    window.removeEventListener('resize', panelFitHandler);
    window.removeEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', panelFitHandler);
    panelFitHandler = null;
}

async function openPanel() {
    closePanel();
    const overlay = $(`
        <div id="v_adapter_panel_overlay">
            <div class="v_adapter_panel_chrome">
                <span>Bảng quản lý V.Adapter</span>
                <div class="v_adapter_panel_actions">
                    <button class="menu_button" id="v_adapter_panel_newtab">Tab mới</button>
                    <button class="menu_button" id="v_adapter_panel_close">Đóng</button>
                </div>
            </div>
            <iframe id="v_adapter_panel_iframe" title="Bảng quản lý V.Adapter"></iframe>
            <div id="v_adapter_panel_fallback">
                <div class="v_adapter_panel_fallback_card">
                    <b>Bảng điều khiển không thể hiển thị dạng nhúng</b>
                    <p>Môi trường duyệt web hiện tại có thể đã cấm nhúng trang (Một số trình duyệt mobile và WebView trong app sẽ hạn chế iframe).
                       Hãy đổi sang mở bảng điều khiển ở tab mới, chức năng hoàn toàn giống với cách nhúng.</p>
                    <button class="menu_button" id="v_adapter_panel_fallback_open">Mở bảng điều khiển trong tab mới</button>
                </div>
            </div>
        </div>`);
    $('body').append(overlay);
    bindPanelFit(overlay[0]);

    // Cầu nối: __V_ADAPTER_API__ -> Endpoint /admin/* của bảng điều khiển (Trung tâm cài đặt / Art style / Biên dịch / Lịch sử).
    window.__V_ADAPTER_API__ = handleApi;

    const url = new URL('./panel.html', import.meta.url).href + '?v=' + encodeURIComponent(version);
    const frame = overlay.find('#v_adapter_panel_iframe')[0];

    // Cổng vào tab mới: Trang bảng điều khiển sẽ chuyển sang lấy hàm cầu nối từ window.opener, do đó vẫn có thể sử dụng bình thường.
    const openInNewTab = () => {
        const w = window.open(url, '_blank');
        if (!w) overlay.find('#v_adapter_panel_fallback').addClass('show');
    };

    let loaded = false;
    frame.addEventListener('load', () => {
        // Khi chưa set src cũng sẽ kích hoạt load một lần (about:blank), phân biệt dựa trên việc body có rỗng hay không.
        try {
            const doc = frame.contentDocument;
            if (doc && doc.body && doc.body.childElementCount > 0) loaded = true;
        } catch {
            loaded = true; // Không thể đọc nội dung do cross-domain thì coi như đã load
        }
    });
    frame.src = url;

    overlay.find('#v_adapter_panel_close').on('click', closePanel);
    overlay.find('#v_adapter_panel_newtab').on('click', openInNewTab);
    overlay.find('#v_adapter_panel_fallback_open').on('click', openInNewTab);

    setTimeout(() => {
        if (!loaded && document.body.contains(frame)) {
            overlay.find('#v_adapter_panel_fallback').addClass('show');
        }
    }, 8000);
}

function closePanel() {
    $('#v_adapter_panel_overlay').remove();
    unbindPanelFit();
    try { delete window.__V_ADAPTER_API__; } catch { /* Bỏ qua */ }
}


// -- Cầu nối gọi trong trang: Dành cho các extension khác trong cùng trang SillyTavern gọi trực tiếp --
//
// V.Canvas và extension này thường được cài chung trong một instance SillyTavern, cả hai nằm trong cùng một ngữ cảnh (context) trang,
// do đó có thể hoàn thành request và response của giao thức NAI trực tiếp bằng cách gọi hàm: Không cần listen port,
// cũng không cần deploy bản triển khai server xuống <SillyTavern>/plugins/, càng không cần khởi động lại SillyTavern.
// Từ đó, hai extension này sau khi cài đặt trên bất kỳ SillyTavern nào (Local / Server / Mobile) là có thể sử dụng ngay.
//
// Tham số truyền vào: Request body NAI tiêu chuẩn; tham số thứ hai { expand } biểu thị có mở rộng prompt trước hay không.
// Trả về: { status, contentType, bytes }; Khi thất bại là { status, error }.
// Ngữ nghĩa nhất quán với HTTP response, bên gọi chỉ cần xử lý theo cùng một bộ rẽ nhánh là được.

window.__V_ADAPTER_NAI__ = async function (naiBody, options) {
    try {
        const p = naiBody?.parameters ?? {};
        let prompt = String(naiBody?.input ?? '').trim();
        let neg = String(p.negative_prompt ?? '').trim();
        const w = Number(p.width) || 0;
        const h = Number(p.height) || 0;
        let size = (w > 0 && h > 0) ? `${w}x${h}` : '';

        if (options?.expand) {
            const target = {
                url: settingsGet.qwenURL(),
                key: settingsGet.qwenKey(),
                model: settingsGet.qwenModel(),
            };
            const t = await translateCharacter(target, prompt);
            prompt = t.prompt;
            neg = t.negative_prompt;
            if (size === '') size = `${t.width}x${t.height}`;
        }

        const r = await runGeneration(prompt, neg, size);
        // Kết quả giáng cấp CORS: Tuyến trên chỉ đưa ra link từ xa, phía trình duyệt không download được byte do cross-domain.
        // Lúc này sẽ chuyển nguyên vẹn link qua trường url về cho bên gọi, để bên gọi trích dẫn trực tiếp ảnh từ xa;
        // Nếu không phân biệt, bên gọi sẽ hiểu lầm "Kết quả thành công nhưng không có byte" thành thất bại.
        if (!r.data && r.remoteUrl) {
            return {
                status: 200,
                contentType: `image/${r.ext === 'jpg' ? 'jpeg' : r.ext}`,
                bytes: null,
                url: r.remoteUrl,
                via: r.via,
            };
        }
        return {
            status: 200,
            contentType: `image/${r.ext === 'jpg' ? 'jpeg' : r.ext}`,
            bytes: r.data,
            via: r.via,
        };
    } catch (err) {
        return {
            status: 502,
            contentType: 'application/json',
            error: String(err?.message ?? err),
        };
    }
};

// -- UI ngăn extension (Khởi động/Dừng dịch vụ giao thức + Tên + Phiên bản + Mở bảng quản lý) --
//
// Ngăn extension chỉ giữ lại các thao tác một bước ăn ngay như công tắc dịch vụ. Các chức năng dạng tham số vẫn nằm trong bảng quản lý (panel.html),
// tránh việc ngăn extension bị kéo quá dài.

function addSettingsUI() {
    const html = `
    <div id="v_adapter_drawer" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>V.Adapter <span class="v_adapter_version">${version}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content v_adapter_content">
                <div class="v_adapter_row v_adapter_svc">
                    <span class="v_adapter_svc_label">Engine xuất ảnh</span>
                    <span id="v_adapter_svc_state" class="v_adapter_svc_state v_adapter_svc_on">Sẵn sàng</span>
                </div>
                <div id="v_adapter_svc_block" class="v_adapter_svc_block">
                    <div class="v_adapter_row v_adapter_svc">
                        <span class="v_adapter_svc_label">Dịch vụ giao thức</span>
                        <span id="v_adapter_svc_detail" class="v_adapter_svc_state">—</span>
                    </div>
                    <div class="v_adapter_row">
                        <button id="v_adapter_svc_toggle" class="menu_button">
                            <i class="fa-solid fa-power-off"></i><span>Khởi động dịch vụ giao thức</span>
                        </button>
                    </div>
                    <div class="v_adapter_row">
                        <button id="v_adapter_svc_reload" class="menu_button"
                                title="Sau khi cập nhật file plugin, bấm vào đây là có hiệu lực ngay, không cần khởi động lại SillyTavern">
                            <i class="fa-solid fa-rotate"></i><span>Áp dụng cập nhật</span>
                        </button>
                    </div>
                    <div id="v_adapter_svc_hint" class="v_adapter_row v_adapter_svc_hint">
                        <small>Dịch vụ giao thức là khả năng <b>tùy chọn</b>: Chỉ dành cho các plugin sinh ảnh bên thứ ba của SillyTavern kết nối.
                        V.Canvas mặc định kết nối trực tiếp trong trang, không cần khởi động dịch vụ này.</small>
                    </div>
                </div>
                <div class="v_adapter_row">
                    <button id="v_adapter_open_panel" class="menu_button">
                        <i class="fa-solid fa-sliders"></i><span>Mở bảng quản lý</span>
                    </button>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    $('#v_adapter_open_panel').on('click', openPanel);
    $('#v_adapter_svc_toggle').on('click', onServiceToggle);
    $('#v_adapter_svc_reload').on('click', onServiceReload);

    // Khi ngăn extension mở ra sẽ làm mới một lần, tránh hiển thị trạng thái còn sót lại từ session trước.
    $('#v_adapter_drawer .inline-drawer-toggle').on('click', refreshServiceState);
    refreshServiceState();
}

// -- Khởi động/Dừng dịch vụ giao thức --
//
// Bản triển khai phía server nằm trong server-plugin/ bên trong thư mục extension, do bootloader nằm trong <SillyTavern>/plugins/V.Adapter/
// load theo nhu cầu. Chỗ này chỉ chịu trách nhiệm gọi 3 endpoint do bootloader cung cấp.
//
//   GET  /status   Kiểm tra xem bản triển khai có tồn tại không, có đang chạy không
//   POST /start    Load bản triển khai và lắng nghe port
//   POST /stop     Giải phóng port và tài nguyên
//   POST /reload   stop trước rồi start, dùng để load bản triển khai sau khi cập nhật

const SVC_API = '/api/plugins/v-adapter';

// serviceRequest Gọi endpoint của bootloader; lỗi mạng hoặc nghiệp vụ đều thống nhất ném ra lỗi dễ đọc.
async function serviceRequest(action) {
    const res = await fetch(`${SVC_API}/${action}`, {
        method: action === 'status' ? 'GET' : 'POST',
        headers: getRequestHeaders(),
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Bootloader chưa được cài đặt`);
    }
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

// toastError Hiển thị lỗi; khi thiếu component thông báo thì giáng cấp im lặng (silent fallback).
function toastError(msg) {
    try {
        toastr.error(msg, 'V.Adapter', { timeOut: 5000, preventDuplicates: true });
    } catch {
        console.error('[V.Adapter]', msg);
    }
}

// renderServiceState Làm mới ngăn extension theo kết quả trả về của bootloader.
//
// Dịch vụ giao thức là một khả năng tùy chọn (Dành cho client NAI bên thứ ba trong cùng mạng), luồng xuất ảnh chính là kết nối trực tiếp trong trang.
// Khi chưa deploy bootloader, khối này vẫn hiển thị nhưng bị xám đi, đồng thời cung cấp hướng dẫn deploy -- việc ẩn đi sẽ khiến những người cần chức năng này không tìm thấy lối vào.
function renderServiceState(st) {
    const block = $('#v_adapter_svc_block');
    const detail = $('#v_adapter_svc_detail');
    const toggle = $('#v_adapter_svc_toggle');
    const reload = $('#v_adapter_svc_reload');
    const hint = $('#v_adapter_svc_hint');
    if (!block.length) return;

    block.show();

    if (!st || !st.installed) {
        detail.text('Chưa deploy (Tùy chọn)').removeClass('v_adapter_svc_on').addClass('v_adapter_svc_off');
        toggle.prop('disabled', true).find('span').text('Khởi động dịch vụ giao thức');
        reload.prop('disabled', true);
        if (hint.length) {
            hint.html('<small>Chưa deploy server -- Chỉ <b>plugin sinh ảnh SillyTavern bên thứ ba</b> mới cần nó, ' +
                'V.Canvas mặc định kết nối trực tiếp trong trang, không cần thiết.<br>' +
                'Cách bật: Chạy <code>install-loader</code> trong thư mục extension ' +
                '(Windows click đúp <code>.bat</code>, Linux/Termux thực thi <code>.sh</code>), ' +
                'nó sẽ tự động hoàn tất deploy, khởi động lại SillyTavern 1 lần là xong, không cần chỉnh sửa thủ công bất kỳ cấu hình nào.</small>');
        }
        return;
    }

    toggle.prop('disabled', false);
    reload.prop('disabled', !st.running);

    if (st.running) {
        detail.text(st.listen ? `Đang chạy · ${st.listen}` : 'Đang chạy')
            .removeClass('v_adapter_svc_off').addClass('v_adapter_svc_on');
        toggle.find('span').text('Dừng dịch vụ giao thức');
        toggle.find('i').removeClass('fa-power-off').addClass('fa-stop');
        if (hint.length) {
            hint.html('<small>Plugin sinh ảnh SillyTavern bên thứ ba vui lòng điền địa chỉ API là <code>' +
                String(st.listen ?? '').replace(/^0\.0\.0\.0/, '127.0.0.1') +
                '</code>, API Key giống với server. ' +
                'Sau khi cập nhật file plugin, bấm vào "Áp dụng cập nhật" là có hiệu lực, không cần khởi động lại SillyTavern.</small>');
        }
    } else {
        detail.text('Đã dừng').removeClass('v_adapter_svc_on').addClass('v_adapter_svc_off');
        toggle.find('span').text('Khởi động dịch vụ giao thức');
        toggle.find('i').removeClass('fa-stop').addClass('fa-power-off');
        if (hint.length) {
            hint.html('<small>Dịch vụ là khả năng <b>tùy chọn</b>: Sau khi khởi động, plugin sinh ảnh SillyTavern bên thứ ba mới có thể kết nối; ' +
                'Chỉ dùng V.Canvas thì không cần khởi động.</small>');
        }
    }
}

async function refreshServiceState() {
    try {
        renderServiceState(await serviceRequest('status'));
    } catch (err) {
        renderServiceState(null);
        console.warn('[V.Adapter] Đọc trạng thái dịch vụ giao thức thất bại: ', err.message);
    }
}

async function onServiceToggle() {
    const btn = $('#v_adapter_svc_toggle');
    const running = $('#v_adapter_svc_state').hasClass('v_adapter_svc_on');
    btn.prop('disabled', true);
    try {
        await serviceRequest(running ? 'stop' : 'start');
        await refreshServiceState();
    } catch (err) {
        toastError(`${running ? 'Dừng' : 'Khởi động'} thất bại: ${err.message}`);
        await refreshServiceState();
    }
}

async function onServiceReload() {
    const btn = $('#v_adapter_svc_reload');
    btn.prop('disabled', true);
    try {
        await serviceRequest('reload');
        await refreshServiceState();
    } catch (err) {
        toastError(`Tải lại thất bại: ${err.message}`);
        await refreshServiceState();
    }
}

// -- Tự khởi động --
// Trình load extension của SillyTavern chỉ chịu trách nhiệm gắn <script type="module">, không tự gọi init(),
// do đó sau khi module được load xong sẽ tự khởi tạo (Giống với hành vi của extension hệ thống chính thức).
init().catch(err => console.error('[V.Adapter] Khởi tạo thất bại:', err));