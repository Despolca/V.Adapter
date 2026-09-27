// genlog.js - Circular buffer cho lịch sử tạo (trong memory, 200 mục gần nhất), phục vụ cho tổng quan hoạt động của bảng điều khiển và hiển thị ở trang lịch sử.
// Port 1:1 từ genlog.go của V.Adapter (Go).

const GEN_LOG_CAP = 200;

class GenLogStore {
    constructor() {
        this.records = [];
        this.success = 0;
        this.fail = 0;
    }

    Add(r) {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        r.time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        if (r.ok) this.success++; else this.fail++;
        this.records.push(r);
        if (this.records.length > GEN_LOG_CAP) {
            this.records = this.records.slice(this.records.length - GEN_LOG_CAP);
        }
    }

    // Lấy limit mục đầu tiên, mới nhất xếp trước.
    Snapshot(limit) {
        const n = this.records.length;
        if (!limit || limit <= 0 || limit > n) limit = n;
        const out = [];
        for (let i = n - 1; i >= n - limit; i--) out.push(this.records[i]);
        return out;
    }

    Counters() {
        return [this.success, this.fail];
    }

    Clear() {
        this.records = [];
    }
}

export const genLog = new GenLogStore();
export const genLogCap = GEN_LOG_CAP;

// Constructor của GenRecord (các trường giống hệt JSON tag của GenRecord bản Go, bảng điều khiển tiêu thụ trực tiếp).
export function newRecord(fields) {
    return Object.assign({
        time: '', kind: '', endpoint: '', model: '', prompt: '',
        size: '', via: '', ok: false, status: 0, latency_ms: 0, error: undefined,
    }, fields);
}