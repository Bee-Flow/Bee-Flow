'use strict';
/**
 * The connector's one logger, same call shape as server/telemetry/log.js:
 * `log.warn('[Tag] what happened', detail, err)`.
 *
 * Production (NODE_ENV=production, or LOG_FORMAT=json) writes ONE JSON object
 * per line to stdout, `{ ts, level, msg, err? }`, which is what the Nextcloud
 * ExApp log viewer reads. Tests and development keep the console: the method is
 * looked up at call time, so a spy on console.warn still sees the call.
 *
 * `log.ref(id)` turns a user id into a short digest for the message.
 *
 * Level (JSON mode only): LOG_LEVEL = debug | info | warn | error, default info.
 * No dependency: the connector image stays small.
 */

const crypto = require('node:crypto');
const util = require('node:util');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const CONSOLE_METHOD = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

function isJsonMode(env = process.env) {
    if (env.LOG_FORMAT === 'json') return true;
    if (env.LOG_FORMAT === 'console') return false;
    return env.NODE_ENV === 'production';
}

/** console.error('[Tag] failed:', err) -> msg '[Tag] failed: <message>' plus the first Error. */
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
 * @param {{ json?: boolean, level?: string, stream?: { write(chunk: string): unknown }, now?: () => Date }} [options]
 */
function createLogger({ json = false, level = 'info', stream = process.stdout, now = () => new Date() } = {}) {
    /** @type {Record<string, (...args: any[]) => void>} */
    const logger = {};
    const min = Math.max(0, LEVELS.indexOf(level));
    for (const lvl of LEVELS) {
        if (!json) {
            // eslint-disable-next-line no-console -- the development sink; looked up per call
            logger[lvl] = (...args) => console[CONSOLE_METHOD[lvl]](...args);
            continue;
        }
        logger[lvl] = (...args) => {
            if (LEVELS.indexOf(lvl) < min) return;
            const { msg, err } = splitArgs(args);
            const line = { ts: now().toISOString(), level: lvl, msg };
            if (err) line.err = { name: err.name, message: err.message, code: err.code };
            stream.write(`${JSON.stringify(line)}\n`);
        };
    }
    logger.log = logger.info;
    return logger;
}

/**
 * A Nextcloud user id is personal data: logs carry this short digest instead,
 * enough to tell two users apart in one log, not to read who it was.
 * @param {unknown} id
 */
function ref(id) {
    if (id === undefined || id === null || id === '') return '-';
    return `u_${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8)}`;
}

const log = createLogger({ json: isJsonMode(), level: process.env.LOG_LEVEL || 'info' });

module.exports = Object.assign(log, { createLogger, isJsonMode, ref });
