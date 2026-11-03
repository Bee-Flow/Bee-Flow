# decode-uri-component (CommonJS port of 0.5.1)

Vendored copy of [decode-uri-component](https://github.com/SamVerschueren/decode-uri-component)
0.5.1 (MIT, see `LICENSE`), the first release that fixes the two denial-of-service advisories
GHSA-vcc3-ghjq-m6fr and GHSA-qr28-fpjm-wq7f. Upstream 0.5.1 is ESM-only with a default export;
`query-string` 7 (a dependency of expo-router 57) does `require('decode-uri-component')` and
calls the result, so it cannot use it. The decoding logic in `index.js` is byte-for-byte the
upstream file; only the last export differs (`module.exports` plus `.default`).

`mobile/package.json` points the `decode-uri-component` override at this directory. Delete the
directory and the override with the Expo SDK 58 upgrade (the `query-string` that expo-router
uses there no longer needs it). The test next to it is `index.test.js`.
