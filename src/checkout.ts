export const DEFAULT_CHECKOUT_ORIGIN = 'https://pay.vexwallet.co';
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const PREFIX = 'vexpay:';
const SECRET_PATTERN = /^([a-z0-9-]+)_secret_[A-Za-z0-9_-]{20,}$/;

export interface CheckoutOptions {
  /** `clientSecret` from `POST /v1/checkout/sessions` (created on your server). */
  clientSecret: string;
  /** Where the hosted checkout lives. Default `https://pay.vexwallet.co`. */
  checkoutOrigin?: string;
  /** How long to wait for the checkout to load before emitting `origin_not_allowed`. Default 15 s. */
  readyTimeoutMs?: number;
}

export interface CheckoutEvents {
  /** The checkout loaded and accepted this page. */
  ready: { sessionId: string };
  /** Payment succeeded. Advisory — confirm on your server before fulfilling. */
  completed: { sessionId: string; paymentId: string | null };
  /** A payment attempt failed; the buyer can retry until the session expires. */
  failed: { sessionId: string; code: string };
  /** The session expired. Create a new one. */
  expired: { sessionId: string };
  /** The checkout cannot be shown or used here. */
  error: { code: 'origin_not_allowed' | 'invalid_client_secret' | 'mount_target_not_found' | string; message: string };
}

export type CheckoutEventName = keyof CheckoutEvents;
type Handler<E extends CheckoutEventName> = (payload: CheckoutEvents[E]) => void;

function parseSecret(clientSecret: unknown): string {
  const match = typeof clientSecret === 'string' ? SECRET_PATTERN.exec(clientSecret) : null;
  if (!match) {
    throw new Error('VexPay: clientSecret is missing or malformed. Pass the value returned by POST /v1/checkout/sessions.');
  }
  return match[1]!;
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

/**
 * An embedded checkout. Card data and bank codes are entered inside VEXPay's
 * iframe and never reach your page — you only receive ids and status codes.
 */
export class Checkout {
  private readonly slug: string;
  private readonly origin: string;
  private readonly readyTimeoutMs: number;
  private readonly handlers = new Map<CheckoutEventName, Set<(payload: never) => void>>();
  private iframe: HTMLIFrameElement | null = null;
  private sessionId = '';
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onMessage = (event: MessageEvent) => this.handleMessage(event);

  constructor(private readonly options: CheckoutOptions) {
    this.slug = parseSecret(options.clientSecret);
    this.origin = normalizeOrigin(options.checkoutOrigin ?? DEFAULT_CHECKOUT_ORIGIN);
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<E extends CheckoutEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (payload: never) => void);
    return () => this.off(event, handler);
  }

  off<E extends CheckoutEventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  /** Render the checkout inside `target` (an element or a CSS selector). */
  mount(target: string | HTMLElement): this {
    if (this.iframe) this.unmount();
    const container = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
    if (!container) {
      this.emit('error', { code: 'mount_target_not_found', message: `VexPay: no element matches ${String(target)}.` });
      return this;
    }

    const iframe = document.createElement('iframe');
    iframe.src = `${this.origin}/pay/${encodeURIComponent(this.slug)}?embed=1`;
    iframe.title = 'VEXPay checkout';
    iframe.allow = 'payment';
    // allow-popups-to-escape-sandbox: USDT opens the processor's payment page in a new
    // window, which must run as a normal page (not inherit this iframe's sandbox).
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
    );
    iframe.style.cssText = 'width:100%;min-height:480px;border:0;display:block;background:transparent;';
    this.iframe = iframe;

    window.addEventListener('message', this.onMessage);
    container.appendChild(iframe);

    // A frame blocked by CSP frame-ancestors never announces itself.
    this.readyTimer = setTimeout(() => {
      this.emit('error', {
        code: 'origin_not_allowed',
        message: `VexPay: the checkout did not load. Add ${window.location.origin} to the session's allowedOrigins.`,
      });
    }, this.readyTimeoutMs);
    return this;
  }

  /** Remove the checkout from the page and stop listening. */
  unmount(): void {
    clearTimeout(this.readyTimer);
    window.removeEventListener('message', this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
  }

  private emit<E extends CheckoutEventName>(event: E, payload: CheckoutEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        (handler as Handler<E>)(payload);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  private handleMessage(event: MessageEvent): void {
    // Only our own iframe, on the checkout origin, is trusted.
    if (!this.iframe || event.source !== this.iframe.contentWindow || event.origin !== this.origin) return;
    const data = event.data as { type?: unknown } & Record<string, unknown>;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith(PREFIX)) return;

    switch (data.type.slice(PREFIX.length)) {
      case 'ready':
        // The secret goes only to the checkout origin, never '*'.
        this.iframe.contentWindow?.postMessage(
          { type: `${PREFIX}init`, clientSecret: this.options.clientSecret },
          this.origin,
        );
        return;
      case 'verified':
        clearTimeout(this.readyTimer);
        this.sessionId = String(data.sessionId ?? '');
        this.emit('ready', { sessionId: this.sessionId });
        return;
      case 'resize':
        if (typeof data.height === 'number' && data.height > 0) {
          this.iframe.style.height = `${Math.ceil(data.height)}px`;
        }
        return;
      case 'completed':
        this.emit('completed', {
          sessionId: String(data.sessionId ?? this.sessionId),
          paymentId: typeof data.paymentId === 'string' ? data.paymentId : null,
        });
        return;
      case 'failed':
        this.emit('failed', { sessionId: String(data.sessionId ?? this.sessionId), code: String(data.code ?? 'payment_failed') });
        return;
      case 'expired':
        this.emit('expired', { sessionId: String(data.sessionId ?? this.sessionId) });
        return;
      case 'error':
        clearTimeout(this.readyTimer);
        this.emit('error', { code: String(data.code ?? 'unknown'), message: String(data.message ?? 'Checkout error.') });
        return;
    }
  }
}

/** Create an embedded checkout for a session. Call `.mount(el)` to show it. */
export function checkout(options: CheckoutOptions): Checkout {
  return new Checkout(options);
}

/** Send the buyer to the hosted checkout page instead of embedding it. */
export function redirectToCheckout(options: Pick<CheckoutOptions, 'clientSecret' | 'checkoutOrigin'>): void {
  const slug = parseSecret(options.clientSecret);
  const origin = normalizeOrigin(options.checkoutOrigin ?? DEFAULT_CHECKOUT_ORIGIN);
  window.location.assign(`${origin}/pay/${encodeURIComponent(slug)}`);
}
