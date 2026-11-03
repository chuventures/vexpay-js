import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkout, redirectToCheckout, type Checkout } from '../src/index';

const ORIGIN = 'https://pay.example';
const SECRET = `cs-abc123def456_secret_${'x'.repeat(43)}`;

type FakeWindow = { postMessage: ReturnType<typeof vi.fn> };

/** Mounts a checkout and swaps its iframe's contentWindow for a spy. */
function mounted(options: { readyTimeoutMs?: number } = {}) {
  document.body.innerHTML = '<div id="pay"></div>';
  const instance = checkout({ clientSecret: SECRET, checkoutOrigin: ORIGIN, ...options });
  const events: Array<[string, unknown]> = [];
  for (const name of ['ready', 'completed', 'failed', 'expired', 'error'] as const) {
    instance.on(name, (payload) => events.push([name, payload]));
  }
  instance.mount('#pay');
  const iframe = document.querySelector('iframe')!;
  const frameWindow: FakeWindow = { postMessage: vi.fn() };
  Object.defineProperty(iframe, 'contentWindow', { value: frameWindow, configurable: true });
  return { instance, iframe, frameWindow, events };
}

function fromFrame(frameWindow: unknown, data: unknown, origin = ORIGIN) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: frameWindow as Window }));
}

let current: Checkout | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  current?.unmount();
  current = undefined;
  vi.useRealTimers();
});

describe('checkout()', () => {
  it('rejects a missing or malformed client secret', () => {
    expect(() => checkout({ clientSecret: '' })).toThrow(/clientSecret is missing or malformed/);
    expect(() => checkout({ clientSecret: 'sk_live_123' })).toThrow(/malformed/);
  });

  it('mounts a sandboxed iframe on the checkout origin in embed mode', () => {
    const { instance, iframe } = mounted();
    current = instance;
    expect(iframe.src).toBe(`${ORIGIN}/pay/cs-abc123def456?embed=1`);
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation ');
    // USDT hands the buyer to the processor page in an unsandboxed popup.
    expect(iframe.getAttribute('sandbox')).toContain('allow-popups-to-escape-sandbox');
    expect(iframe.title).toBe('VEXPay checkout');
  });

  it('sends the client secret only to the checkout origin, only after vexpay:ready', () => {
    const { instance, frameWindow } = mounted();
    current = instance;
    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    fromFrame(frameWindow, { type: 'vexpay:ready' });
    expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: 'vexpay:init', clientSecret: SECRET }, ORIGIN);
  });

  it('ignores messages from other origins or other windows', () => {
    const { instance, frameWindow, events } = mounted();
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:ready' }, 'https://evil.example');
    fromFrame({ postMessage: vi.fn() }, { type: 'vexpay:ready' });
    fromFrame(frameWindow, { type: 'vexpay:completed', paymentId: 'p' }, 'https://evil.example');
    expect(frameWindow.postMessage).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('emits ready once the checkout verified the secret', () => {
    const { instance, frameWindow, events } = mounted();
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:verified', sessionId: 'cs_1' });
    expect(events).toEqual([['ready', { sessionId: 'cs_1' }]]);
  });

  it('relays completed, failed and expired with ids and codes only', () => {
    const { instance, frameWindow, events } = mounted();
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:verified', sessionId: 'cs_1' });
    fromFrame(frameWindow, { type: 'vexpay:failed', sessionId: 'cs_1', code: 'bank_rejected' });
    fromFrame(frameWindow, { type: 'vexpay:completed', sessionId: 'cs_1', paymentId: 'pay_1', cardNumber: '4111' });
    fromFrame(frameWindow, { type: 'vexpay:expired', sessionId: 'cs_1' });

    expect(events.slice(1)).toEqual([
      ['failed', { sessionId: 'cs_1', code: 'bank_rejected' }],
      ['completed', { sessionId: 'cs_1', paymentId: 'pay_1' }],
      ['expired', { sessionId: 'cs_1' }],
    ]);
  });

  it('resizes the iframe to the checkout height', () => {
    const { instance, iframe, frameWindow } = mounted();
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:resize', height: 612.4 });
    expect(iframe.style.height).toBe('613px');
  });

  it('emits origin_not_allowed when the checkout never loads', () => {
    const { instance, events } = mounted({ readyTimeoutMs: 1000 });
    current = instance;
    vi.advanceTimersByTime(999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe('error');
    expect(events[0]![1]).toMatchObject({ code: 'origin_not_allowed' });
  });

  it('does not time out once ready', () => {
    const { instance, frameWindow, events } = mounted({ readyTimeoutMs: 1000 });
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:verified', sessionId: 'cs_1' });
    vi.advanceTimersByTime(5000);
    expect(events.map(([name]) => name)).toEqual(['ready']);
  });

  it('forwards checkout errors such as invalid_client_secret', () => {
    const { instance, frameWindow, events } = mounted();
    current = instance;
    fromFrame(frameWindow, { type: 'vexpay:error', code: 'invalid_client_secret', message: 'nope' });
    expect(events).toEqual([['error', { code: 'invalid_client_secret', message: 'nope' }]]);
  });

  it('unmount removes the iframe and stops listening', () => {
    const { instance, frameWindow, events } = mounted({ readyTimeoutMs: 1000 });
    instance.unmount();
    expect(document.querySelector('iframe')).toBeNull();
    fromFrame(frameWindow, { type: 'vexpay:verified', sessionId: 'cs_1' });
    vi.advanceTimersByTime(5000);
    expect(events).toEqual([]);
  });

  it('on() returns an unsubscribe function', () => {
    const { instance, frameWindow } = mounted();
    current = instance;
    const seen: unknown[] = [];
    const off = instance.on('ready', (payload) => seen.push(payload));
    off();
    fromFrame(frameWindow, { type: 'vexpay:verified', sessionId: 'cs_1' });
    expect(seen).toEqual([]);
  });

  it('reports a missing mount target as an error event', () => {
    document.body.innerHTML = '';
    const events: unknown[] = [];
    const instance = checkout({ clientSecret: SECRET, checkoutOrigin: ORIGIN });
    instance.on('error', (payload) => events.push(payload));
    instance.mount('#missing');
    expect(events).toEqual([expect.objectContaining({ code: 'mount_target_not_found' })]);
  });
});

describe('redirectToCheckout()', () => {
  it('navigates to the hosted checkout for the session', () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true });
    try {
      redirectToCheckout({ clientSecret: SECRET, checkoutOrigin: `${ORIGIN}/ignored/path` });
      expect(assign).toHaveBeenCalledWith(`${ORIGIN}/pay/cs-abc123def456`);
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('defaults to the production checkout origin', () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, assign }, configurable: true });
    try {
      redirectToCheckout({ clientSecret: SECRET });
      expect(assign).toHaveBeenCalledWith('https://pay.vexpay.app/pay/cs-abc123def456');
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });
});
