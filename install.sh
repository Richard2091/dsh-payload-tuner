#!/bin/sh
# dsh-session-load-tuner 安装脚本（幂等，可重复执行）。
#
# 做的事（只碰这两个位置，全部先备份）：
#   1. 把插件包复制到 ~/.dsh/profiles/web/plugins/dsh-session-load-tuner
#   2. 在 ~/.dsh/profiles/web/node_modules 里建一个同名软链
#   3. 在 ~/.dsh/profiles/web/cordis.patch.yml 末尾追加一段带标记的 insert 条目
#
# 不重启服务、不跑 pnpm install、不联网。
# 回滚：sh uninstall.sh（或把备份目录里的文件拷回去）。
#
# 用法：sh install.sh

set -eu

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PLUGIN_NAME="dsh-session-load-tuner"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/.dsh-backup-$STAMP"

if [ ! -d "$PROFILE_DIR" ]; then
	echo "找不到 profile 目录：$PROFILE_DIR" >&2
	exit 1
fi

echo "== 备份 =="
mkdir -p "$BACKUP_DIR"
for file in cordis.patch.yml package.json; do
	if [ -f "$PROFILE_DIR/$file" ]; then
		cp -a "$PROFILE_DIR/$file" "$BACKUP_DIR/$file"
		echo "  $PROFILE_DIR/$file -> $BACKUP_DIR/$file"
	fi
done

echo "== 复制插件包 =="
mkdir -p "$PROFILE_DIR/plugins"
rm -rf "$PROFILE_DIR/plugins/$PLUGIN_NAME"
mkdir -p "$PROFILE_DIR/plugins/$PLUGIN_NAME"
cp -a "$SRC_DIR/package.json" "$SRC_DIR/cordis.patch.yml" "$SRC_DIR/README.md" "$PROFILE_DIR/plugins/$PLUGIN_NAME/"
cp -a "$SRC_DIR/lib" "$PROFILE_DIR/plugins/$PLUGIN_NAME/lib"
echo "  $PROFILE_DIR/plugins/$PLUGIN_NAME"

echo "== 链接到 profile 的 node_modules =="
ln -sfn "../plugins/$PLUGIN_NAME" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
echo "  $PROFILE_DIR/node_modules/$PLUGIN_NAME -> ../plugins/$PLUGIN_NAME"

echo "== 写入 cordis.patch.yml =="
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if grep -q ">>> dsh-session-load-tuner >>>" "$PATCH_FILE" 2>/dev/null; then
	echo "  已存在安装块，跳过（改参数请直接编辑该块）"
else
	cat >>"$PATCH_FILE" <<'YAML'

# >>> dsh-session-load-tuner >>>（由插件自带的 install.sh 写入；卸载时连同上下标记一起删）
# 窗口参数是 volatile：改完刷新页面生效。wsDeflate 只影响新开的 WebSocket 连接，
# 改动后需要重启 dsh-web.service 才确定生效。
- insert:
    - id: session-load-tuner
      name: 'dsh-session-load-tuner'
      config:
        enabled: true
        maxMessages: 120
        minMessages: 24
        minTurns: 2
        wsDeflate: false
        wsDeflateThreshold: 1024
# <<< dsh-session-load-tuner <<<
YAML
	echo "  已追加到 $PATCH_FILE"
fi

cat <<EOF

== 完成 ==
备份目录：$BACKUP_DIR

下一步（需要你自己执行，重启会打断当前会话）：
  systemctl restart dsh-web.service

重启后验证：
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3080' \\
    http://127.0.0.1:3080/plugins/dsh-session-load-tuner/client.js      # 期望 200

浏览器里：
  F12 -> Network -> WS -> 点开一个会话，发出去的 open 帧应带
  "maxMessages":120（而不是 500）；若开了 wsDeflate，握手响应头应出现
  Sec-WebSocket-Extensions: permessage-deflate。

回滚：
  sh uninstall.sh && systemctl restart dsh-web.service
EOF
