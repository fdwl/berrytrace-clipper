/**
 * 端到端：**已经开着的页面，开始录制之后会不会长出那条工具条**
 *
 * ── 它为什么值得单独一个脚本 ──────────────────────────────────────────────
 * 李博 0907 **连报两轮**「录制中打开浏览器没有工具条」，两轮根因还不一样
 * （① 包没装到他机器上；② 装了但浏览器一直跑着 8 月的 service worker）。
 * 两轮都只能靠推理，因为**这条链没有任何单测覆盖得到**：
 * 它要一个真的浏览器真的加载这个扩展、真的注入一个真的页面。
 *
 * 这里用 Chrome for Testing（品牌版 137 起移除了 --load-extension，
 * CfT 还留着）真跑一遍：假宿主起一个中继，扩展连上来，推一份录制态，
 * 然后用 CDP 去页面里查那个宿主 div 在不在。
 *
 * 🔴 **对照组是刻意的**：先在"没在录"时断言**没有**工具条，再推 show:true
 * 断言它长出来。没有对照组的话，"一直都有"和"这次才有"分辨不出来
 * —— 而那正是 CLAUDE.md 六点六⑤ 说的那种「判据在跑、但分辨不出新旧」。
 *
 * 跑法：
 *   npm run build:chrome        # 先出 dist（车间机上要 BT_LOWMEM=1）
 *   node scripts/e2e-recording-toolbar.mjs
 *   # 换浏览器：BT_E2E_CHROME=/path/to/chrome node scripts/...
 *
 * 失效条件：等这条链有了别的真浏览器覆盖（比如 CI 里的 playwright 装扩展跑）
 * 之后，这个脚本可以删。在那之前它是唯一一个真的验得到「工具条出没出来」的东西。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const 插件源 = path.resolve(new URL('..', import.meta.url).pathname, 'dist');
/*
 * ⚠️ 品牌版 Chrome 137 起**移除了 `--load-extension`**（151 上实测静默失效：
 * 不报错、扩展也不装）。所以这里默认走 Chrome for Testing。
 * 换一个用 BT_E2E_CHROME 指过来 —— 但换成品牌版的话整个脚本会静默失效。
 */
const CHROME = process.env.BT_E2E_CHROME
  ?? '/data/home-cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
// 车间机上一律 /data/tmp（那台的 /tmp 撑爆过，表现是"代码全坏了"）；别的机器退回系统临时目录
const 临时根 = fs.existsSync('/data/tmp') ? '/data/tmp' : os.tmpdir();
const 根 = fs.mkdtempSync(path.join(临时根, 'bt-e2e-'));
const 插件 = path.join(根, 'ext');
const 侧写 = path.join(根, 'profile');

fs.cpSync(插件源, 插件, { recursive: true });

const TOKEN = 'e2e-token-0123456789abcdef';
let 中继端口 = 0; let 站点端口 = 0; let 调试端口 = 0;

function 空端口() {
  return new Promise((res) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const 日志 = [];
const 记 = (...a) => { const s = a.join(' '); 日志.push(s); console.log(s); };

// ── 自带的极简 WebSocket ──────────────────────────────────────────────────
//
// 🔴 **刻意不引 `ws`**：这个仓里没有它，为一个自检脚本往 package.json /
// package-lock.json 里加一个依赖，代价比这 60 行大得多（锁文件一动，
// 所有人下一次安装都要跟着走一遍）。这里只用得上文本帧和 close，够了。
//
// 客户端→服务端的帧**一定带掩码**，服务端→客户端的**一定不带** —— 反了的话
// 浏览器会直接断开，而且不告诉你为什么。
const 魔串 = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function 升级(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + 魔串).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const 听众 = { message: [], close: [] };
  let 余 = Buffer.alloc(0);
  socket.on('data', (块) => {
    余 = Buffer.concat([余, 块]);
    for (;;) {
      if (余.length < 2) return;
      const op = 余[0] & 0x0f;
      const 有掩码 = (余[1] & 0x80) !== 0;
      let 长 = 余[1] & 0x7f;
      let i = 2;
      if (长 === 126) { if (余.length < 4) return; 长 = 余.readUInt16BE(2); i = 4; }
      else if (长 === 127) { if (余.length < 10) return; 长 = Number(余.readBigUInt64BE(2)); i = 10; }
      let mask = null;
      if (有掩码) { if (余.length < i + 4) return; mask = 余.subarray(i, i + 4); i += 4; }
      if (余.length < i + 长) return;
      const 体 = Buffer.from(余.subarray(i, i + 长));
      if (mask) for (let k = 0; k < 体.length; k++) 体[k] ^= mask[k % 4];
      余 = 余.subarray(i + 长);
      if (op === 0x8) { for (const f of 听众.close) f(); socket.end(); return; }
      if (op === 0x9) { socket.write(编(体, 0xa)); continue; }   // ping → pong
      if (op === 0x1) for (const f of 听众.message) f(体.toString('utf8'));
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { for (const f of 听众.close) f(); });
  return {
    on: (名, f) => { 听众[名]?.push(f); },
    send: (文) => { try { socket.write(编(Buffer.from(文, 'utf8'), 0x1)); } catch { /* 断了 */ } },
    close: () => { try { socket.end(); } catch { /* 已经断了 */ } },
  };
}

function 编(体, op) {
  const 头 = [];
  头.push(0x80 | op);
  if (体.length < 126) 头.push(体.length);
  else if (体.length < 65536) { 头.push(126, 体.length >> 8 & 0xff, 体.length & 0xff); }
  else {
    头.push(127);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(体.length));
    for (const x of b) 头.push(x);
  }
  return Buffer.concat([Buffer.from(头), 体]);
}

// ── 假宿主：中继 ──────────────────────────────────────────────────────────
let 扩展连接 = null;
let 在录 = false;
/** 正在重载：这段时间里旧连接会断，别把它当成故障 */
let 重载中 = false;
const 收到的 = [];

const 发过去 = (o) => { 扩展连接?.send(JSON.stringify(o)); };

function 起中继(port) {
  const srv = http.createServer();
  srv.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/extension')) { socket.destroy(); return; }
    const ws = 升级(req, socket);
    const q = new URL(req.url, 'http://x').searchParams;
    记(`[中继] 扩展连上来了 build=${q.get('build')} browser=${q.get('browser')}`);
    扩展连接 = ws;
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (!m.method) return;
      收到的.push(m.method);
      if (m.method === 'berrytrace.recording.hello') {
        ws.send(JSON.stringify({ id: m.id, result: 在录 ? 状态() : null }));
        记(`[中继] 它问「在录吗」，我答：${在录 ? '在录' : 'null'}`);
        return;
      }
      if (String(m.method).startsWith('berrytrace.recording.')) {
        ws.send(JSON.stringify({ id: m.id, result: { ok: true, state: 在录 ? 状态() : null } }));
        return;
      }
      ws.send(JSON.stringify({ id: m.id, error: 'UNKNOWN' }));
    });
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res(srv)));
}

const 状态 = () => ({
  show: true, capture: true, phase: 'recording', sessionId: 'e2e-1',
  steps: 0, screenshotOnly: 0, annotations: 0, elapsedMs: 1000,
});

// ── 一个真的 http 站点（content_scripts 只匹配 http/https，file:// 不行）──
function 起站点(port) {
  const srv = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end('<!doctype html><meta charset=utf-8><title>被录的页面</title><h1>已经开着的页面</h1>');
  });
  return new Promise((res) => srv.listen(port, '127.0.0.1', () => res(srv)));
}

// ── CDP ───────────────────────────────────────────────────────────────────
async function 连页面(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(`:${站点端口}`));
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等不到那个页面的 CDP target');
}

function 评估器(wsUrl) {
  // Node 22 自带 WebSocket **客户端**（全局），CDP 这半不需要任何依赖
  const ws = new globalThis.WebSocket(wsUrl);
  let id = 0; const 待 = new Map();
  const 好了 = new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
    if (m.id && 待.has(m.id)) { 待.get(m.id)(m); 待.delete(m.id); }
  });
  return {
    好了,
    评: (expr) => new Promise((res, rej) => {
      const i = ++id;
      const t = setTimeout(() => rej(new Error('CDP 超时')), 15000);
      待.set(i, (m) => { clearTimeout(t); res(m.result?.result?.value); });
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    }),
    关: () => { try { ws.close(); } catch { /* 已经关了 */ } },
  };
}

const 有工具条 = `!!document.querySelector('[data-berrytrace-recording]')`;

// ── 跑 ────────────────────────────────────────────────────────────────────
let 失败 = 0;
const 断言 = (说, 实, 期) => {
  const ok = 实 === 期;
  if (!ok) 失败++;
  记(`${ok ? '✅' : '❌'} ${说}　（拿到 ${实}，期望 ${期}）`);
};

const 主 = async () => {
  中继端口 = await 空端口(); 站点端口 = await 空端口(); 调试端口 = await 空端口();
  fs.writeFileSync(path.join(插件, 'pairing.json'), JSON.stringify({ token: TOKEN, port: 中继端口 }));
  记(`中继 ${中继端口}　站点 ${站点端口}　调试 ${调试端口}`);

  const a = await 起中继(中继端口);
  const b = await 起站点(站点端口);

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${侧写}`,
    `--load-extension=${插件}`,
    `--disable-extensions-except=${插件}`,
    `--remote-debugging-port=${调试端口}`,
    '--no-first-run', '--no-default-browser-check',
    `http://127.0.0.1:${站点端口}/`,
  ], {
    // 车间机上那六个库在 sysroot 里（/data/browsers/env.sh 建的）。别的机器上这一段是空转
    env: {
      ...process.env,
      LD_LIBRARY_PATH: fs.existsSync('/data/browsers/sysroot')
        ? `/data/browsers/sysroot/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH ?? ''}`
        : (process.env.LD_LIBRARY_PATH ?? ''),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  chrome.stderr.on('data', (d) => { const s = d.toString(); if (/ERROR|extension/i.test(s)) process.stderr.write(`[chrome] ${s}`); });

  let 第二页 = null;
  try {
    const wsUrl = await 连页面(调试端口);
    const p = 评估器(wsUrl); await p.好了;
    记('页面连上了');

    // 等扩展连到中继（保活闹钟最坏 30 秒，但 SW 起来就会连一次）
    for (let i = 0; i < 60 && !扩展连接; i++) await new Promise((r) => setTimeout(r, 500));
    if (!扩展连接) throw new Error('扩展没连到中继 —— 后面全是假的');

    // ① 对照组：没在录 ⇒ 页面上不许有工具条
    await new Promise((r) => setTimeout(r, 1500));
    断言('① 没在录时，已经开着的页面上没有工具条（对照组）', await p.评(有工具条), false);

    // ② 开始录制：这一份推送要让**已经开着**的页面长出工具条
    在录 = true;
    扩展连接.send(JSON.stringify({ method: 'berrytrace.recording.state', params: [状态()] }));
    记('[中继] 推了一份 show:true');
    let 出来了 = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await p.评(有工具条)) { 出来了 = true; break; }
    }
    断言('② 已经开着的页面，开始录制之后长出了工具条（就是李博报的那条）', 出来了, true);

    // ③ 新开的页面也要有（这条以前就通，作为回归）
    const 新 = await (await fetch(`http://127.0.0.1:${调试端口}/json/new?http://127.0.0.1:${站点端口}/?second`, { method: 'PUT' })).json()
      .catch(() => null);
    if (新?.webSocketDebuggerUrl) {
      const q = 评估器(新.webSocketDebuggerUrl); await q.好了;
      let 新的有 = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await q.评(有工具条)) { 新的有 = true; break; }
      }
      断言('③ 录制中新开的页面也有（回归）', 新的有, true);
      第二页 = q;   // 留着：⑤⑥ 要用它把重载之后睡着的 service worker 叫醒
    } else {
      记('⚠️ 开不出第二个标签页，③ 跳过');
    }

    // ④ 停止录制 ⇒ 工具条要撤掉
    在录 = false;
    扩展连接.send(JSON.stringify({ method: 'berrytrace.recording.state', params: [null] }));
    let 撤了 = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await p.评(有工具条))) { 撤了 = true; break; }
    }
    断言('④ 停止之后工具条撤掉了', 撤了, true);

    /*
     * ── ⑤⑥ 这两条才是李博那个场景 ─────────────────────────────────────
     *
     * 他的标签页是**在插件换代码之前**就开着的。`chrome.runtime.reload()`
     * 之后，那些页面里的 content script 变成"孤儿"：JS 还在跑、DOM 还在，
     * 但它手上的 chrome 已经失效，再也收不到任何消息 ——
     * 而浏览器**不会**替我们往这些页面里补一份新的。
     *
     * 🔴 ①~④ 全都验不到这一条：那四条里页面是在插件已经就位之后加载的，
     * 走的是 manifest 那条注入，跟补注入一点关系都没有。
     * （头一版这个脚本就是这么写的，把补注入整段关掉之后 4 条照样全绿。）
     */
    重载中 = true;
    记('[中继] 叫扩展重载一次（模拟"刚装完新包"）');
    发过去({ id: 9001, method: 'berrytrace.reload' });
    扩展连接 = null;
    /*
     * 🔴 重载之后 service worker 是**懒起**的，headless 里连保活闹钟都不一定醒
     * （实测干等 150 秒它一次都没连回来）。用**第二个**标签页刷一下把它叫醒 ——
     * 新页面加载 ⇒ content script 起来 ⇒ 问一句"在录吗" ⇒ worker 被唤醒 ⇒ 连中继。
     *
     * ⚠️ 刷的必须是第二页，**不能刷第一页** —— 第一页刷了就会拿到一份
     * 崭新的 content script，这一整条判据要验的"孤儿页面"当场就没了。
     */
    for (let i = 0; i < 60 && !扩展连接; i++) {
      if (第二页 && i % 6 === 0) await 第二页.评('location.reload()').catch(() => {});
      if (i % 10 === 9) {
        const l = await (await fetch(`http://127.0.0.1:${调试端口}/json/list`)).json().catch(() => []);
        记(`  …等重连 ${i}s，浏览器里的 target：${l.map((t) => `${t.type}:${(t.title || t.url).slice(0, 40)}`).join(' | ')}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!扩展连接) {
      /*
       * 🔴 **如实登记「这台机器上验不到」，不要伪造一条绿的**（CLAUDE.md 六点六⑥）。
       * 〔实测〕`chrome.runtime.reload()` 之后，这个无头 + --load-extension 的组合里
       * 扩展的 service worker **再也没起来过**（等 150 秒、刷第二个标签页去唤醒，
       * 都不回来；`/json/list` 里连它的 service_worker target 都消失了）。
       * 而同一条 RPC 在真浏览器里是好使的 —— 李博的 Mac 上当场把两个浏览器
       * 从 `0828-paired-truth` 换成了新的构建标记。
       *
       * 所以这是**环境的限制，不是产品的故障**。补注入那半的判定另有覆盖：
       * `recordSwBridge.test.ts`（该给谁补）＋ `recordContentScript` 的
       * `该接手吗`（孤儿要不要让位）。
       */
      记('⚠️ ⑤⑥ 跳过：这个无头环境里扩展重载之后 service worker 起不来（真浏览器里可以）。');
      记('   补注入那半的判定由 recordSwBridge.test.ts 与 该接手吗() 覆盖。');
      p.关(); 第二页?.关();
      chrome.kill('SIGKILL'); a.close(); b.close();
      记(`\n扩展往宿主发过的方法：${[...new Set(收到的)].join('、') || '（一条都没有）'}`);
      记(失败 === 0 ? '\n①~④ 全部通过（⑤⑥ 环境所限跳过）' : `\n${失败} 条没过`);
      process.exit(失败 === 0 ? 0 : 1);
    }
    重载中 = false;
    await new Promise((r) => setTimeout(r, 1500));
    断言('⑤ 刚重载完，那个老页面上是干净的（对照组）', await p.评(有工具条), false);

    在录 = true;
    扩展连接.send(JSON.stringify({ method: 'berrytrace.recording.state', params: [状态()] }));
    记('[中继] 又推了一份 show:true');
    let 补上了 = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await p.评(有工具条)) { 补上了 = true; break; }
    }
    断言('⑥ 换了插件代码之后，**之前就开着**的页面也被补上了工具条', 补上了, true);

    p.关();
    第二页?.关();
  } finally {
    chrome.kill('SIGKILL');
    a.close(); b.close();
  }

  记(`\n扩展往宿主发过的方法：${[...new Set(收到的)].join('、') || '（一条都没有）'}`);
  记(失败 === 0 ? '\n全部通过' : `\n${失败} 条没过`);
  process.exit(失败 === 0 ? 0 : 1);
};

主().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
