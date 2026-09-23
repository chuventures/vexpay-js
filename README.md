# VEXPay.js

Embed [VEXPay](https://vexwallet.co/vexpay)'s hosted checkout on your own website. Buyers pay with Pago Móvil C2P or card inside a VEXPay iframe; card numbers, bank codes and OTPs never touch your page — you only receive ids and status codes.

- Zero dependencies, under 10 kB gzipped
- ESM, CommonJS and a `<script>` build (`window.VexPay`)
- Typed events: `ready`, `completed`, `failed`, `expired`, `error`

## Install

```sh
npm install @vexpay/js
```

Or from a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@vexpay/js@0.1.0/dist/vexpay.global.js"></script>
```

## How it works

1. **Server:** create a checkout session with your secret API key (e.g. with [`@vexpay/node`](https://www.npmjs.com/package/@vexpay/node)), listing the site origins allowed to embed it.
2. **Browser:** pass the session's `clientSecret` to `VexPay.checkout()` and mount it.
3. **Server:** fulfil the order only after confirming the payment — via the `payment.*` webhook or by retrieving the session.

```js
// server.js
const session = await vexpay.checkout.sessions.create({
  amountUsd: 25,
  reference: 'order-1042',
  allowedOrigins: ['https://shop.example'],
});
// Send session.clientSecret to the browser. Never log or store it.
```

## Embed the checkout

```html
<div id="vexpay-checkout"></div>
```

```js
import { checkout } from '@vexpay/js';

const pay = checkout({ clientSecret }).mount('#vexpay-checkout');

pay.on('ready', ({ sessionId }) => {
  // The checkout loaded and accepted this page.
});

pay.on('completed', ({ sessionId, paymentId }) => {
  // Advisory: confirm on your server before fulfilling.
  window.location.assign(`/orders/confirm?session=${sessionId}`);
});

pay.on('failed', ({ code }) => {
  // The buyer can retry until the session expires.
});

pay.on('expired', () => {
  // Create a new session.
});

pay.on('error', ({ code, message }) => {
  // origin_not_allowed | invalid_client_secret | mount_target_not_found | …
  console.error(code, message);
});
```

With the `<script>` build, the same API lives on `window.VexPay`:

```html
<script>
  VexPay.checkout({ clientSecret: '{{ client_secret }}' }).mount('#vexpay-checkout');
</script>
```

`on()` returns an unsubscribe function; `off(event, handler)` also works. Call `unmount()` to remove the checkout and stop listening.

## Redirect instead of embedding

```js
import { redirectToCheckout } from '@vexpay/js';

redirectToCheckout({ clientSecret });
```

Sends the buyer to the hosted checkout page. No `allowedOrigins` needed.

## Options

| Option | Default | |
|---|---|---|
| `clientSecret` | — | From `POST /v1/checkout/sessions`. Required. |
| `checkoutOrigin` | `https://pay.vexwallet.co` | Where the hosted checkout lives. |
| `readyTimeoutMs` | `15000` | How long to wait for the checkout to load before emitting `error` with `origin_not_allowed`. |

## Troubleshooting

- **`origin_not_allowed`** — the page's origin is not in the session's `allowedOrigins`. Live sessions accept `https://` origins only; test-mode sessions also accept `http://localhost:*`.
- **`invalid_client_secret`** — the secret is wrong or belongs to another session. Create a fresh session per checkout.
- **Nothing happens on `completed`** — events are advisory. Always confirm the payment on your server before shipping.

## License

MIT
