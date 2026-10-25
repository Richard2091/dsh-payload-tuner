#!/bin/sh
# dsh-session-load-tuner 安装脚本（幂等，可重复执行）。
#
# 做的事（全部先备份到 ~/.dsh-backup-<时间戳>/）：
#   1. 把插件包复制到 ~/.dsh/profiles/web/plugins/dsh-session-load-tuner
#   2. 在 ~/.dsh/profiles/web/node_modules 里建一个同名软链
#   3. 在 ~/.dsh/profiles/web/cordis.patch.yml 末尾写一段带标记的 insert 条目
#      （已存在则先删掉旧块再写，保证配置和当前 schema 一致）
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
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

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
cp -a "$SRC_DIR/install.sh" "$SRC_DIR/uninstall.sh" "$PROFILE_DIR/plugins/$PLUGIN_NAME/"
cp -a "$SRC_DIR/lib" "$PROFILE_DIR/plugins/$PLUGIN_NAME/lib"
echo "  $PROFILE_DIR/plugins/$PLUGIN_NAME"

echo "== 链接到 profile 的 node_modules =="
ln -sfn "../plugins/$PLUGIN_NAME" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
echo "  $PROFILE_DIR/node_modules/$PLUGIN_NAME -> ../plugins/$PLUGIN_NAME"

echo "== 写入 cordis.patch.yml =="
if [ -f "$PATCH_FILE" ] && grep -q ">>> $PLUGIN_NAME >>>" "$PATCH_FILE" 2>/dev/null; then
	awk -v marker="$PLUGIN_NAME" '
		$0 ~ "^# >>> " marker " >>>" { skip = 1; next }
		$0 ~ "^# <<< " marker " <<<" { skip = 0; next }
		skip != 1 { print }
	' "$PATCH_FILE" >"$PATCH_FILE.tmp"
	mv "$PATCH_FILE.tmp" "$PATCH_FILE"
	echo "  已移除旧安装块"
fi

cat >>"$PATCH_FILE" <<'YAML'

# >>> dsh-session-load-tuner >>>（由插件自带的 install.sh 写入；卸载时连同上下标记一起删）
# 参数都是 volatile：改完刷新页面生效。wsDeflate 只影响新开的 WebSocket 连接，
# 改动后重启 dsh-web.service 最干净。
- insert:
    - id: session-load-tuner
      name: 'dsh-session-load-tuner'
      config:
        maxMessages: 120
        minMessages: 50
        minTurns: 2
        lazyLoad: true
        wsDeflate: false
        wsDeflateThreshold: 1024
# <<< dsh-session-load-tuner <<<
YAML
echo "  已写入 $PATCH_FILE"

cat <<EOF

== 完成 ==
备份目录：$BACKUP_DIR

下一步（需要你自己执行，重启会打断当前会话）：
  systemctl restart dsh-web.service

重启后验证：
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3080' \\
    http://127.0.0.1:3080/plugins/dsh-session-load-tuner/client.js      # 期望 200

浏览器里：
  设置 -> 会话加载（提示音之后、模型之前）；F12 -> Network -> WS ->
  点开一个会话，open 帧里 maxMessages 应为 120、turnWindow 为 50/2。

回滚：
  sh uninstall.sh && systemctl restart dsh-web.service
EOF
