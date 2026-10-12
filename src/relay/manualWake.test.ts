import { describe, it, expect } from 'vitest';
import { wakeVerdict, type WakeFacts } from './manualWake';

const good: WakeFacts = { supported: true, enabled: true, paired: true, connected: true, hostRecording: true, injected: 3 };

describe('manual wake verdict', () => {
  it('walks every step in order: the first broken step wins', () => {
    expect(wakeVerdict({ ...good, supported: false, enabled: false, paired: false, connected: false }, 47823).code).toBe('unsupported');
    expect(wakeVerdict({ ...good, enabled: false, paired: false, connected: false }, 47823).code).toBe('disabled');
    expect(wakeVerdict({ ...good, paired: false, connected: false }, 47823).code).toBe('unpaired');
    expect(wakeVerdict({ ...good, connected: false }, 47823).code).toBe('unreachable');
    expect(wakeVerdict({ ...good, hostRecording: false }, 47823).code).toBe('idle');
    expect(wakeVerdict({ ...good, hostRecording: null }, 47823).code).toBe('no-answer');
    expect(wakeVerdict(good, 47823).code).toBe('ok');
  });

  it('control group: only the fully good facts say ok, and it carries the page count', () => {
    const r = wakeVerdict(good, 47823);
    expect(r.code).toBe('ok');
    expect(r.message).toContain('3');
    expect(wakeVerdict({ ...good, connected: false }, 47823).code).not.toBe('ok');
  });

  it('unpaired / unreachable carry the pair page on the given port', () => {
    expect(wakeVerdict({ ...good, paired: false, connected: false }, 50000).pairUrl).toBe('http://127.0.0.1:50000/pair');
    expect(wakeVerdict({ ...good, connected: false }, 47823).pairUrl).toBe('http://127.0.0.1:47823/pair');
    expect(wakeVerdict(good, 47823).pairUrl).toBeUndefined();
  });
});
