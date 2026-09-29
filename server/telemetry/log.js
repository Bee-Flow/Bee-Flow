// @typecheck
'use strict';
/**
 * The server's one logger.
 *
 * Production writes one JSON object per line, stamped with the id of the
 * request that produced it. Tests and local development keep the console:
 * readable, and every existing spy on console.warn / console.error keeps
 * seeing the call, because the console method is looked up at call time.
 *
 * The call shape is console's: `log.warn('[Tag] what happened', detail, err)`.
 * Extra arguments are formatted the way console formats them; the first Error
 * among them is also carried structurally as `err` in JSON mode.
 *
 * Mode: LOG_FORMAT=json | console, else json under NODE_ENV=production.
 * Level (JSON mode only): LOG_LEVEL, default info.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const util = require('node:util');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const CONSOLE_METHOD = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

const requestStore = new AsyncLocalStorage();

function runWithRequestId(id, fn) {
    return requestStore.run({ id }, fn);
}

function currentRequestId() {
    return requestStore.getStore()?.id;
}

function isJsonMode(env = process.env) {
    if (env.LOG_FORMAT === 'json') return true;
    if (env.LOG_FORMAT === 'console') return false;
    return env.NODE_ENV === 'production';
}

/** console.error('[Tag] failed:', err) → msg '[Tag] failed: <message>', plus err. */
function splitArgs(args) {
    let err = null;
    const printable = args.map((a) => {
        if (a instanceof Error) {
            if (!err) err = a;
            return a.message;
        }
        return a;
    });
    return { msg: util.format(...printable), err };
}

/**
 * @typedef {(...args: any[]) => void} LogFn
 * @typedef {{ debug: LogFn, info: LogFn, warn: LogFn, error: LogFn, log: LogFn }} Logger
 */

/**
 * @param {{ json?: boolean, level?: string, stream?: NodeJS.WritableStream }} [options]
 * @returns {Logger}
 */
function createLogger({ json, level = 'info', stream = process.stdout } = {}) {
    if (!json) {
        const passthrough = /** @type {Logger} */ ({});
        for (const lvl of LEVELS) {
            passthrough[lvl] = (...args) => console[CONSOLE_METHOD[lvl]](...args);
        }
        passthrough.log = passthrough.info;
        return passthrough;
    }

    const pino = require('pino');
    const sink = pino(
        {
            level,
            formatters: { level: (label) => ({ level: label }) },
            timestamp: pino.stdTimeFunctions.isoTime,
            serializers: { err: pino.stdSerializers.err },
        },
        stream,
    );
    const logger = /** @type {Logger} */ ({});
    for (const lvl of LEVELS) {
        logger[lvl] = (...args) => {
            if (!sink.isLevelEnabled(lvl)) return;
            const { msg, err } = splitArgs(args);
            const fields = {};
            const reqId = currentRequestId();
            if (reqId) fields.reqId = reqId;
            if (err) fields.err = err;
            sink[lvl](fields, msg);
        };
    }
    logger.log = logger.info;
    return logger;
}

const defaultLogger = createLogger({
    json: isJsonMode(),
    level: LEVELS.includes(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info',
});

module.exports = {
    ...defaultLogger,
    createLogger,
    isJsonMode,
    runWithRequestId,
    currentRequestId,
};
