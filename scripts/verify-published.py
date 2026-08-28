"""从线上真下一份，验证用户拿到的包确实是带自动化能力的那一份。

判据不是「能下载」也不是「是个 zip」—— 那两条上一版坏包也满足。
判据是：解开之后 background.js 里有 relay 代码、有 relay-pair.js、
manifest 里那条 content script 是 document_start、
以及首次安装要弹的欢迎页（welcome.html / welcome.js）在包里且真的接上了 onInstalled。
"""
import io, json, re, sys, urllib.request, zipfile

# 🔴 可以传一个**本地 zip** 进来，先验再发。
# 不给这条口子的话，判据只在"已经发出去之后"才跑得到 —— 而发布的代价是
# 所有用户下一次安装拿到的就是它。0828 那次线上躺了两天的坏包，
# 正是因为唯一的判据在发布之后。
if len(sys.argv) > 1:
    print(f'读本地包 {sys.argv[1]} …')
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
else:
    URL = 'https://webapp.getdear.cn/download/berrytrace-clipper.zip'
    print(f'下载 {URL} …')
    data = urllib.request.urlopen(URL, timeout=300).read()
print(f'  {len(data)} 字节')

z = zipfile.ZipFile(io.BytesIO(data))
names = set(z.namelist())

def check(label, ok, detail=''):
    print(f"  {'✅' if ok else '❌'} {label}{(' —— ' + detail) if detail else ''}")
    return ok

all_ok = True
all_ok &= check('顶层目录是 berrytrace-clipper/（解压后直接可加载）',
                'berrytrace-clipper/manifest.json' in names)
all_ok &= check('relay-pair.js 在包里', 'berrytrace-clipper/relay-pair.js' in names)

# 🔴 service worker 的文件名**带内容哈希**（见 webpack.config.js 里那段注释：
# 名字不变，浏览器会一直跑缓存里的旧脚本，而且两边都不报错）。
# 所以这里不能写死 background.js —— 要按 manifest 指的那个名字去读。
_manifest = json.loads(z.read('berrytrace-clipper/manifest.json').decode('utf-8'))
_sw = (_manifest.get('background') or {}).get('service_worker') \
    or ((_manifest.get('background') or {}).get('scripts') or ['background.js'])[0]
bg = z.read(f'berrytrace-clipper/{_sw}').decode('utf-8', 'replace')
all_ok &= check('background.js 里有 BerrytraceRelay', 'BerrytraceRelay' in bg)
all_ok &= check('background.js 里有配对后重连', 'berrytrace-relay-paired' in bg)
all_ok &= check('background.js 里有 chrome.debugger 调用', 'chrome.debugger' in bg)
all_ok &= check('不抢焦点那条约束在（active:false）',
                'active: false' in bg or 'active:!1' in bg or 'active:!0' in bg)

m = json.loads(z.read('berrytrace-clipper/manifest.json'))
cs = [c for c in m.get('content_scripts', []) if 'relay-pair.js' in c.get('js', [])]
all_ok &= check('manifest 里有配对 content script', bool(cs))
if cs:
    all_ok &= check('它是 document_start', cs[0].get('run_at') == 'document_start',
                    str(cs[0].get('run_at')))

# ── 🔴 档 C 的中继：能不能跑，全在这几条上 ──────────────────────────────────
# 〔0828 实测，李博的 Mac〕线上那份（0826 构建）这几条一条都不满足，
# 而它装完之后**一切显示正常**：目录在、installed=true、版本号跟能用的那版一样。
# 唯一的现象是设置页最后一格「连接失败」。⇒ 判据必须在发布这一关就拦住。
_perms = m.get('permissions') or []
all_ok &= check(
    'debugger 在 permissions 里（**不是** optional_permissions）',
    'debugger' in _perms,
    # 放在 optional 里的话 `chrome.debugger` 在没被授权前是 undefined，
    # 而中继的 isSupported() 正是看它 ⇒ 中继**根本不启动**，且只进 debugLog，
    # 用户侧零痕迹。0826 那版就是这么配的。
    f'现在是 permissions={"debugger" in _perms} optional={"debugger" in (m.get("optional_permissions") or [])}')
all_ok &= check('alarms 在 permissions 里', 'alarms' in _perms,
                'service worker 空闲 30 秒被回收之后，只有闹钟能把它叫醒')
all_ok &= check('background.js 里有保活闹钟', 'berrytrace-relay-keepalive' in bg)
all_ok &= check('background.js 里有配对状态查询（配对页靠它判断真连上了没有）',
                'berrytrace-relay-status' in bg)

# 🔴 宿主装完之后在**磁盘上**认这个串，判断"这个包带不带中继"。
#    它必须是一个**完整的字面量** —— 0828 头一版写成模板
#    `BT-RELAY-CAPABLE:${RELAY_BUILD}`，这份 webpack 配置不做常量内联，
#    于是产物里原样留着 ${…}：宿主认得出"有中继"、**认不出是哪一版**。
_mark = 'BT-RELAY-CAPABLE:'
_at = bg.find(_mark)
all_ok &= check('background.js 里有宿主认包用的标记', _at >= 0)
if _at >= 0:
    _tail = bg[_at + len(_mark):_at + len(_mark) + 40]
    # 到第一个不合法字符为止 —— 不能把后面的代码也一起收进来当版本号。
    _build = re.match(r'[\w.\-]*', _tail).group(0)
    all_ok &= check('那个标记是完整字面量（不是没折的模板串）',
                    not _tail.startswith('$') and len(_build) > 0, f'构建标记={_build!r}')
all_ok &= check('名字是 Berrytrace Clipper', m.get('name') == 'Berrytrace Clipper', str(m.get('name')))

# ── 欢迎页 ──────────────────────────────────────────────────────────────────
# 判据同样是**内容**：三个文件齐、background 里真的有那条 onInstalled 接线、
# 页面上那条深链真的是桌面端注册的 scheme。
# ⚠️ 只查 ASCII 串：terser 的 `ascii_only: true` 会把 js 里的中文转成 \uXXXX，
#    拿中文去 grep 产物永远是假红。
all_ok &= check('welcome.html 在包里', 'berrytrace-clipper/welcome.html' in names)
all_ok &= check('welcome.js 在包里', 'berrytrace-clipper/welcome.js' in names)
all_ok &= check('welcome-style.css 在包里', 'berrytrace-clipper/welcome-style.css' in names)
all_ok &= check('background.js 里有首次安装的接线', 'btWelcomeShownAt' in bg and 'welcome.html' in bg)

wh = z.read('berrytrace-clipper/welcome.html').decode('utf-8')
all_ok &= check('欢迎页上有拉起 App 的 berrytrace:// 深链', 'href="berrytrace://open' in wh)
wj = z.read('berrytrace-clipper/welcome.js').decode('utf-8', 'replace')
all_ok &= check('welcome.js 会记下「用户点了启动」', 'btWelcomeLaunchedAt' in wj)

zh = z.read('berrytrace-clipper/_locales/zh_CN/messages.json').decode('utf-8')
all_ok &= check('中文界面是「莓莓印记」', '莓莓印记' in zh)
all_ok &= check('中文界面里没有残留的 Berrytrace 英文名', 'Berrytrace' not in zh)

print()
print('  ✅ 线上这一份就是带自动化能力的正确版本' if all_ok else '  ❌ 线上这一份有问题，别让用户装')
raise SystemExit(0 if all_ok else 1)
