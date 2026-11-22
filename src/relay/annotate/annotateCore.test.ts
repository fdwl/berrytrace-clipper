import { describe, it, expect } from 'vitest';
import { buildAnnotationBody, buildHandoffPayload, cropBox, CHAT_HANDOFF_METHOD } from './annotateCore';

const snap = { tag: 'button', id: 'buy', classes: ['btn', 'primary'], text: '立即购买', cssPath: '#buy' };

describe('annotateCore', () => {
  it('方法名与宿主一字不差', () => {
    expect(CHAT_HANDOFF_METHOD).toBe('berrytrace.chat.handoff');
  });
  it('正文：有备注出现备注行，无备注没有', () => {
    const a = buildAnnotationBody({ url: 'https://x.com/p', title: 'T', snap, note: ' 颜色不对 ' });
    expect(a).toContain('元素：button#buy.btn.primary　选择器：#buy');
    expect(a).toContain('备注：颜色不对');
    expect(buildAnnotationBody({ url: 'u', title: '', snap, note: '  ' })).not.toContain('备注');
  });
  it('载荷：截图成文件，html 进片段', () => {
    const p = buildHandoffPayload({ url: 'u', title: 't', snap, note: '', html: '<b/>' }, 'QUJD');
    expect(p.snippet).toBe('<b/>');
    expect(p.files?.[0]).toMatchObject({ base64: 'QUJD', label: '标记截图' });
    expect(buildHandoffPayload({ url: 'u', title: 't', snap, note: '' }).files).toBeUndefined();
  });
  it('裁剪：按 dpr 放大并夹在图内；视口外回 null', () => {
    expect(cropBox({ x: 10, y: 10, width: 100, height: 50 }, 2, 1000, 1000)).toEqual({ sx: 20, sy: 20, sw: 200, sh: 100 });
    expect(cropBox({ x: -20, y: 0, width: 100, height: 50 }, 1, 60, 1000)).toEqual({ sx: 0, sy: 0, sw: 60, sh: 50 });
    expect(cropBox({ x: 0, y: 2000, width: 10, height: 10 }, 1, 100, 100)).toBeNull();
  });
});
