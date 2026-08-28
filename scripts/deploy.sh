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
    names = z.namelist()
    # 🔴 **上传前就要拦住的那一类**：多套一层目录。浏览器加载已解压的扩展时
    # 只在你选中的那个目录的**第一层**找 manifest.json，找不到就报
    # 「清单文件缺失或不可读取」—— 那句报错指向的方向完全是错的（听着像 manifest 写坏了，
    # 其实是目录层数不对），能让人查半天。所以判据写死在这儿：
    #   · 顶层**有且只有** berrytrace-clipper/ 这一个目录
    #   · manifest.json 就在它的第一层，全包再没有第二份
    tops = sorted({n.split('/')[0] for n in names})
    assert tops == ['berrytrace-clipper'], f'顶层不止一个入口：{tops}'
    manifests = sorted(n for n in names if n.endswith('/manifest.json') or n == 'manifest.json')
    assert manifests == ['berrytrace-clipper/manifest.json'], f'manifest 的位置不对：{manifests}'
print(f"  {os.path.getsize(zp)/1024/1024:.2f} MB")
PY

SRC="$STAGE/$NAME"

# 🔴 **发之前先验一遍这个包本身。**〔0828 实测逼出来的〕
# 在这之前，内容判据只在"已经发出去之后"跑 —— 而发布的代价是所有用户
# 下一次安装拿到的就是它。0826 那个不带中继的包因此在线上躺了两天，
# 期间李博点「安装插件」装到的就是它，装完连不上，且全程零痕迹。
echo "=== 发之前先验包里的内容（同一套判据，喂本地这一份）==="
python3 "$(dirname "$0")/verify-published.py" "$SRC"

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

echo "=== 🔴 最后一关：把包从线上真下回来，验证**里面的东西**对不对 ==="
# 「能下载」和「是个 zip」都不够 —— 上一版那个被截断的坏包也满足前者，
# 而一个丢了自动化代码的包完全满足后者（0826 真事故：patch 化时把 background 的接线
# 一起还原掉了，构建绿、产物在、装上去就是连不上）。
# 所以这一关查的是内容：relay 代码在不在、content script 是不是 document_start、
# debugger 是不是 optional、中文是不是「莓莓印记」。
python3 "$(dirname "$0")/verify-published.py"
