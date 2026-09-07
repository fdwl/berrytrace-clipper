/**
 * 守卫：录制那一跳的 **service worker 侧**
 *
 * 这一层跑在扩展的 service worker 里，而用户机器上**进不去那个控制台**
 * （Chrome 136 起对默认 profile 忽略 remote-debugging-port）。
 * 也就是说它出错的时候，两边都看不到 —— 页面上"工具条不出来"，
 * 宿主侧"一条事件都没收到"，而中间这一跳一声不吭。
 * 所以它必须有判据。
 *
 * 下面把 `chrome.*` 换成可编程的假件，判定那一半（缓存回什么、
 * 什么时候广播、导航算不算、宿主没连上怎么办）才验得到。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RECORDING_RPC,
  installRecordingSwBridge,
  onHostRecordingState,
  onRelayConnectedForRecording,
  recordingStats,
  type RecordingStateView,
} from './recordSwBridge';

type 监听器 = (msg: { type?: string; payload?: unknown }, sender: unknown, send: (r: unknown) => void) => unknown;

const 录制中: RecordingStateView = {
  show: true, capture: true, phase: 'recording', sessionId: 's1',
  steps: 0, screenshotOnly: 0, annotations: 0, elapsedMs: 0,
};

let 消息监听: 监听器 | null = null;
let 标签更新监听: ((id: number, info: { url?: string }, tab: { title?: string }) => void) | null = null;
let 发给标签的: Array<{ tabId: number; msg: unknown }> = [];
let 发给宿主的: Array<{ method: string; params: unknown[] }> = [];
let 宿主怎么回: (method: string, params: unknown[]) => unknown = () => ({ ok: true });
let 宿主通不通 = true;

function 装假的chrome() {
  消息监听 = null;
  标签更新监听 = null;
  发给标签的 = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn: 监听器) => { 消息监听 = fn; } },
    },
    tabs: {
      query: (_q: unknown, cb: (t: Array<{ id: number }>) => void) => cb([{ id: 1 }, { id: 2 }]),
      sendMessage: (tabId: number, msg: unknown, cb?: () => void) => { 发给标签的.push({ tabId, msg }); cb?.(); },
      onUpdated: { addListener: (fn: typeof 标签更新监听) => { 标签更新监听 = fn; } },
    },
  };
}

/** 走一遍 content script 那条问答 */
function 问(type: string, payload?: unknown): Promise<unknown> {
  return new Promise((res) => {
    const r = 消息监听?.({ type, payload }, null, res);
    // 同步回值的那几条（hello）不会调 send 之外的东西；异步的返回 true
    if (r !== true && r !== undefined) res(r);
  });
}

beforeEach(() => {
  装假的chrome();
  发给宿主的 = [];
  宿主通不通 = true;
  宿主怎么回 = () => ({ ok: true });
  installRecordingSwBridge({
    sendToHost: async (method, params) => {
      发给宿主的.push({ method, params });
      if (!宿主通不通) throw new Error('RELAY_NOT_CONNECTED');
      return 宿主怎么回(method, params);
    },
  });
});

describe('页面问「我在录吗」', () => {
  it('🔴 用缓存直接回，**不等宿主** —— 等的话新标签要愣好几秒才亮工具条', async () => {
    onHostRecordingState(录制中);
    发给宿主的 = [];
    expect(await 问('berrytrace-recording-hello')).toMatchObject({ show: true, capture: true });
    expect(发给宿主的, '这一问不该惊动宿主').toHaveLength(0);
  });

  it('还没拿到过状态就照实回 null —— 不许瞎猜一个"在录"出来', async () => {
    expect(await 问('berrytrace-recording-hello')).toBeNull();
  });
});

describe('宿主推来新状态', () => {
  it('每一个标签页都要收到 —— 少一个，那个标签上的工具条就撤不掉', () => {
    onHostRecordingState(录制中);
    expect(发给标签的.map((x) => x.tabId)).toEqual([1, 2]);
    expect(发给标签的[0].msg).toMatchObject({ type: 'berrytrace-recording-state' });
  });

  it('停了也要广播（推 null）—— 不然页面上那条会一直说「正在录制」', () => {
    onHostRecordingState(录制中);
    发给标签的 = [];
    onHostRecordingState(null);
    expect(发给标签的).toHaveLength(2);
    expect((发给标签的[0].msg as { state: unknown }).state).toBeNull();
  });
});

describe('worker 重启之后主动去要一次', () => {
  it('🔴 问得到就缓存并广播', async () => {
    宿主怎么回 = () => 录制中;
    onRelayConnectedForRecording();
    await new Promise((r) => setTimeout(r, 0));
    expect(发给宿主的[0].method).toBe(RECORDING_RPC.hello);
    expect(发给标签的).toHaveLength(2);
  });

  it('🔴 问不到**不等于没在录** ⇒ 不动缓存、也不广播', async () => {
    onHostRecordingState(录制中);
    发给标签的 = [];
    宿主通不通 = false;
    onRelayConnectedForRecording();
    await new Promise((r) => setTimeout(r, 0));
    expect(发给标签的, '广播一个空状态会把页面上那条工具条撤掉，而录制其实还在跑').toHaveLength(0);
    expect(await 问('berrytrace-recording-hello')).toMatchObject({ show: true });
  });
});

describe('页面上的事件往宿主转', () => {
  it('点击 / 标注 / 打点 / 停止 各走各的方法名', async () => {
    await 问('berrytrace-recording-event', { kind: 'click', at: 1 });
    await 问('berrytrace-recording-annotate', { intent: 'extract' });
    await 问('berrytrace-recording-mark');
    await 问('berrytrace-recording-stop');
    expect(发给宿主的.map((x) => x.method)).toEqual([
      RECORDING_RPC.event, RECORDING_RPC.annotate, RECORDING_RPC.mark, RECORDING_RPC.stop,
    ]);
    // 没有载荷的两条要发空参数数组，不是 [undefined]
    expect(发给宿主的[2].params).toEqual([]);
  });

  it('🔴 宿主回执里捎回来的状态要顺手更新缓存并广播 —— 页面上的角标才不用等下一次推送', async () => {
    宿主怎么回 = () => ({ ok: true, seq: 7, state: { ...录制中, steps: 3 } });
    await 问('berrytrace-recording-event', { kind: 'click', at: 1 });
    expect(发给标签的).toHaveLength(2);
    expect(await 问('berrytrace-recording-hello')).toMatchObject({ steps: 3 });
  });

  it('宿主没连上时照实回一句，不抛 —— 页面不该因为 App 没开就出错', async () => {
    宿主通不通 = false;
    const r = await 问('berrytrace-recording-event', { kind: 'click', at: 1 });
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { reason: string }).reason)).toContain('RELAY_NOT_CONNECTED');
    expect(recordingStats().failed).toBeGreaterThan(0);
  });
});

describe('导航只能在这一层认', () => {
  it('🔴 在录时地址一变就上报 —— content script 在导航那一刻连页面一起被换掉了，报不了自己的离开', () => {
    onHostRecordingState(录制中);
    发给宿主的 = [];
    标签更新监听?.(9, { url: 'https://例子.test/第二页' }, { title: '第二页' });
    expect(发给宿主的[0]).toMatchObject({ method: RECORDING_RPC.event });
    expect((发给宿主的[0].params[0] as { kind: string; url: string }))
      .toMatchObject({ kind: 'navigate', url: 'https://例子.test/第二页' });
  });

  it('没在录、或者不是 http(s) 的，一律不报', () => {
    onHostRecordingState(null);
    标签更新监听?.(9, { url: 'https://例子.test/x' }, {});
    expect(发给宿主的).toHaveLength(0);

    onHostRecordingState(录制中);
    发给宿主的 = [];
    标签更新监听?.(9, { url: 'chrome://settings' }, {});
    标签更新监听?.(9, {}, {});
    expect(发给宿主的, '扩展页/设置页不是他在操作的网站').toHaveLength(0);
  });

  it('🔴 采集挂起时（标注中/暂停）不报导航 —— 那一段本来就不该进流', () => {
    onHostRecordingState({ ...录制中, capture: false, suspendReason: 'paused' });
    发给宿主的 = [];
    标签更新监听?.(9, { url: 'https://例子.test/x' }, {});
    expect(发给宿主的).toHaveLength(0);
  });
});

describe('两边的方法名', () => {
  it('🔴 六条一字不差地对着宿主那份 —— 打错一个字母是"发出去石沉大海"，两边都不报错', () => {
    expect(RECORDING_RPC).toEqual({
      state: 'berrytrace.recording.state',
      hello: 'berrytrace.recording.hello',
      event: 'berrytrace.recording.event',
      annotate: 'berrytrace.recording.annotate',
      mark: 'berrytrace.recording.mark',
      stop: 'berrytrace.recording.stop',
    });
  });
});
