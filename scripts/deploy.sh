#!/usr/bin/env bash
#
# 把插件打包并发布到跟桌面安装包**同一个下载目录**。
#
#   bash scripts/deploy.sh              # 用现成的 dist
#   bash scripts/deploy.sh --build      # 先构建再发
#
# ── 为什么发到那个目录 ──────────────────────────────────────────────────────
# 桌面端的 dmg 就在 `webapp.getdear.cn/download`（见主仓 scripts/deploy-download.js
# 的 TARGET_DOWNLOAD_DIR）。插件放同一处，用户拿一个地址就行。
#
# ── 🔴 三条踩出来的规矩，别删 ───────────────────────────────────────────────
# 1. **先传 .part，md5 对上才改名。** 0826 第一次发布时 scp 被超时截断，
#    服务器上留下一个 2.2MB 的「看起来能下」的坏包 —— 而正常包是 4.4MB。
#    没有校验的话，用户下到的是一个解压失败的 zip，而我们这边一切正常。
# 2. **服务器上没有 rsync**（试过，command not found）。scp 走 sftp 层很慢，
#    这里用 ssh 管道，同样的网络下快得多。
# 3. **ssh 目标必须是 `www-data@getdear.cn`**。裸 `ssh getdear.cn` 会触发
#    fail2ban，一条命令换一小时封禁，还会把同台机器上别的会话一起连累。
#
set -euo pipefail

cd "$(dirname "$0")/.."

DEST_DIR="/mnt/new_lv/www/www/webapp.getdear.cn/download"
SSH_TARGET="www-data@getdear.cn"
STAGE="${TMPDIR:-/data/tmp}/berrytrace-ext-pack"

if [ "${1:-}" = "--build" ]; then
  echo "=== 构建（BT_LOWMEM=1：terser 并行度默认是 CPU 核数，小内存机器会被 OOM kill）==="
  BT_LOWMEM=1 npm run build:chrome
fi

[ -f dist/manifest.json ] || { echo "❌ 没有 dist/manifest.json，先跑 bash scripts/deploy.sh --build"; exit 1; }

VER=$(python3 -c "import json;print(json.load(open('dist/manifest.json'))['version'])")
NAME="berrytrace-clipper-$VER.zip"

echo "=== 打包 $NAME ==="
python3 - "$STAGE" "$VER" <<'PY'
import json, os, shutil, sys, zipfile
stage, ver = sys.argv[1], sys.argv[2]
shutil.rmtree(stage, ignore_errors=True)
os.makedirs(stage, exist_ok=True)
# zip 里带一层顶层目录：用户解压后直接选它「加载已解压的扩展程序」。
# 少了这一层，解压出来会是一堆散文件铺在下载目录里。
top = os.path.join(stage, 'berrytrace-clipper')
shutil.copytree('dist', top)
zp = os.path.join(stage, f'berrytrace-clipper-{ver}.zip')
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _d, files in os.walk(top):
        for f in files:
            full = os.path.join(base, f)
            z.write(full, os.path.relpath(full, stage))
with zipfile.ZipFile(zp) as z:
    assert 'berrytrace-clipper/manifest.json' in z.namelist(), 'manifest 不在顶层目录里'
print(f"  {os.path.getsize(zp)/1024/1024:.2f} MB")
PY

SRC="$STAGE/$NAME"

echo "=== 上传（先传 .part）==="
cat "$SRC" | ssh "$SSH_TARGET" "cat > $DEST_DIR/$NAME.part"

echo "=== 校验 md5 —— 规矩 1，不能省 ==="
LOCAL_MD5=$(md5sum "$SRC" | cut -d' ' -f1)
REMOTE_MD5=$(ssh "$SSH_TARGET" "md5sum $DEST_DIR/$NAME.part | cut -d' ' -f1")
echo "  本地 : $LOCAL_MD5"
echo "  远端 : $REMOTE_MD5"
if [ "$LOCAL_MD5" != "$REMOTE_MD5" ]; then
  echo "  ❌ 不一致 —— 删掉残包，**不改名**，线上仍是上一个可用版本"
  ssh "$SSH_TARGET" "rm -f $DEST_DIR/$NAME.part"
  exit 1
fi

echo "=== 改名 + 稳定名软链 ==="
ssh "$SSH_TARGET" "cd $DEST_DIR && mv $NAME.part $NAME && ln -sfn $NAME berrytrace-clipper.zip"

echo "=== 回头真的下一次，确认 nginx 那边也通 ==="
URL="https://webapp.getdear.cn/download/berrytrace-clipper.zip"
LEN=$(curl -sI "$URL" | awk '/[Cc]ontent-[Ll]ength/{print $2}' | tr -d '\r')
MAGIC=$(curl -s -r 0-1 "$URL" | head -c 2)
echo "  Content-Length: ${LEN:-取不到}（本地 $(stat -c %s "$SRC")）"
[ "$MAGIC" = "PK" ] && echo "  ✅ 下回来的确实是 zip" || { echo "  ❌ 下回来的不是 zip"; exit 1; }
echo ""
echo "  发布完成：$URL"
