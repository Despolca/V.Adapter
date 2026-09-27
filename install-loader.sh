#!/bin/sh
# ============================================================
#  V.Adapter - Triển khai loader của server bằng một click (Linux / macOS / Termux)
#
#  Tự động hoàn thành 3 việc, không cần chỉnh sửa thủ công bất kỳ file nào:
#    1. Tìm thư mục gốc của SillyTavern
#    2. Cài đặt loader vào <SillyTavern>/plugins/V.Adapter/
#    3. Đổi enableServerPlugins trong config.yaml thành true (Tự động backup)
#
#  Sau khi chạy xong chỉ cần khởi động lại SillyTavern một lần.
#
#  Cách dùng: sh install-loader.sh
#        sh install-loader.sh /root/SillyTavern
# ============================================================

DIR=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  if [ -x "$DIR/../../../../node/bin/node" ]; then
    NODE="$DIR/../../../../node/bin/node"
  elif [ -x "$DIR/../../../../node/node" ]; then
    NODE="$DIR/../../../../node/node"
  else
    echo "[Lỗi] Không tìm thấy node. Vui lòng cài đặt Node.js trước (Termux: pkg install nodejs)."
    exit 1
  fi
else
  NODE=node
fi

"$NODE" "$DIR/install-loader.mjs" "$@"
CODE=$?

echo
if [ "$CODE" = "0" ]; then
  echo "[Hoàn tất] Vui lòng khởi động lại SillyTavern một lần, sau đó không cần làm thêm bất kỳ cấu hình nào."
else
  echo "[Thất bại] Xem thông báo bên trên. Có thể chỉ định thủ công thư mục SillyTavern:"
  echo "       sh install-loader.sh /root/SillyTavern"
fi
exit $CODE