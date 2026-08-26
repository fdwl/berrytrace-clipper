"""从线上真下一份，验证用户拿到的包确实是带自动化能力的那一份。

判据不是「能下载」也不是「是个 zip」—— 那两条上一版坏包也满足。
判据是：解开之后 background.js 里有 relay 代码、有 relay-pair.js、
manifest 里那条 content script 是 document_start、
以及首次安装要弹的欢迎页（welcome.html / welcome.js）在包里且真的接上了 onInstalled。
"""
import io, json, urllib.request, zipfile

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

bg = z.read('berrytrace-clipper/background.js').decode('utf-8', 'replace')
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
all_ok &= check('debugger 在 optional_permissions 里（不是常驻权限）',
                'debugger' in (m.get('optional_permissions') or []))
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
