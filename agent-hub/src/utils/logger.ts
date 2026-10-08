// App-wide logging shim.
//
// In dev, every level passes straight through to `console`. In prod,
// `debug` is a no-op so verbose tracing doesn't ship to end users; `warn`
// and `error` still log because they correlate with real problems we
// want to see in the browser console + via reportClientError.
//
// Migration done (Phase 13.1): the ~106 stray `console.log(...)` tracing
// calls all go through `logger.debug(...)` now. What remains on `console`
// directly is intentional: a few `warn`/`error` calls (they behave exactly
// like logger.warn/error — still shown in prod) and the odd deliberate
// user-facing output. New verbose tracing belongs on `logger.debug`.

const isProd = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PROD;

const noop = () => {};

export const logger = {
    debug: isProd ? noop : console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

export default logger;
