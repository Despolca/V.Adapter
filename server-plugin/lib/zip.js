// zip.js — Đóng gói byte hình ảnh thành file ZIP mà client NovelAI mong đợi (bên trong chứa một bức ảnh).
// Tương ứng với writeImageZip của nai_handler.go bản Go (Bản Go dùng archive/zip).
// Ở đây viết tay ZIP "kiểu lưu trữ (store, không nén)": Bản thân hình ảnh đã được nén rồi, thực hiện deflate thêm cũng không có ý nghĩa gì nhiều,
// hơn nữa lại không có dependency (zero-dependency), có thể kiểm soát byte, logic giải nén của client (SillyTavern/Helper, v.v...) đối xử bình đẳng với cả store và deflate.

// Bảng tra cứu (Lookup table) CRC32
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { date: date & 0xFFFF, time: time & 0xFFFF };
}

/**
 * Tạo file ZIP chỉ chứa một file duy nhất.
 * @param {string} fileName Tên file bên trong ZIP (ví dụ: image_0.png)
 * @param {Uint8Array} data Byte của file
 * @returns {Buffer} Byte của file ZIP
 */
export function createZip(fileName, data) {
    const nameBuf = Buffer.from(fileName, 'utf8');
    const crc = crc32(data);
    const size = data.length;
    const { date, time } = dosDateTime(new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);        // version needed
    localHeader.writeUInt16LE(0x0800, 6);    // flags: Tên file UTF-8
    localHeader.writeUInt16LE(0, 8);         // method: store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);     // compressed size
    localHeader.writeUInt32LE(size, 22);     // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);        // extra len

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);      // version made by
    centralHeader.writeUInt16LE(20, 6);      // version needed
    centralHeader.writeUInt16LE(0x0800, 8);  // flags
    centralHeader.writeUInt16LE(0, 10);      // method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);      // extra len
    centralHeader.writeUInt16LE(0, 32);      // comment len
    centralHeader.writeUInt16LE(0, 34);      // disk number start
    centralHeader.writeUInt16LE(0, 36);      // internal attrs
    centralHeader.writeUInt32LE(0, 38);      // external attrs
    centralHeader.writeUInt32LE(0, 42);      // local header offset

    const cdOffset = localHeader.length + nameBuf.length + data.length;
    const cdSize = centralHeader.length + nameBuf.length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);                // disk number
    eocd.writeUInt16LE(0, 6);                // disk with CD
    eocd.writeUInt16LE(1, 8);                // entries on this disk
    eocd.writeUInt16LE(1, 10);               // total entries
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);               // comment len

    return Buffer.concat([localHeader, nameBuf, Buffer.from(data), centralHeader, nameBuf, eocd]);
}