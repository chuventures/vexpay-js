# @vexpay/js

## 0.3.0

### Minor Changes

- The default `checkoutOrigin` is now `https://pay.vexpay.app`. Checkouts embedded with earlier versions keep loading from `https://pay.vexwallet.co`, and passing `checkoutOrigin: 'https://pay.vexwallet.co'` explicitly still works.
