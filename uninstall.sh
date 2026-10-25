#!/bin/sh
# dsh-session-load-tuner 卸载脚本：删掉 patch 里的安装块、node_modules 软链和插件目录。
# 不改 dsh 自身文件，也不重启服务。
#
# 用法：sh uninstall.sh

set -eu

PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
PLUGIN_NAME="dsh-session-load-tuner"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/.dsh-backup-$STAMP"

echo "== 备份当前 patch =="
mkdir -p "$BACKUP_DIR"
if [ -f "$PATCH_FILE" ]; then
	cp -a "$PATCH_FILE" "$BACKUP_DIR/cordis.patch.yml"
	echo "  $BACKUP_DIR/cordis.patch.yml"
fi

echo "== 删除 patch 安装块 =="
if grep -q ">>> dsh-session-load-tuner >>>" "$PATCH_FILE" 2>/dev/null; then
	awk '
		/^# >>> dsh-session-load-tuner >>>/ { skip = 1; next }
		/^# <<< dsh-session-load-tuner <<</ { skip = 0; next }
		skip != 1 { print }
	' "$PATCH_FILE" >"$PATCH_FILE.tmp"
	mv "$PATCH_FILE.tmp" "$PATCH_FILE"
	echo "  已删除"
else
	echo "  没有找到安装块，跳过"
fi

echo "== 删除软链与插件目录 =="
rm -f "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
rm -rf "$PROFILE_DIR/plugins/$PLUGIN_NAME"
rmdir "$PROFILE_DIR/plugins" 2>/dev/null || true
echo "  已删除"

cat <<EOF

== 完成 ==
备份目录：$BACKUP_DIR
生效需要重启：systemctl restart dsh-web.service
EOF
