/**
 * The log.
 *
 * A desktop client is the one part of this product that runs on a machine
 * nobody on the team can open a shell on, so when something goes wrong the log
 * is the whole diagnosis. It therefore has to be (a) on disk, (b) findable
 * from the app, and (c) safe to attach to a support e-mail — which is why
 * every line goes through `redact` on the way out.
 *
 * No dependency: a rotating file log is thirty lines, and a log library is one
 * more thing shipping in an app whose pitch is that it keeps your data at home.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Rotate at 2 MB and keep one previous file: enough for a week, small enough to e-mail. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Patterns that must never reach the log file.
 *
 * Each one is something that WAS at risk of being logged: a session token in a
 * URL from a deep link, an app password in an error from the pairing flow, a
 * Nextcloud login-flow poll token, an Authorization header echoed by a failed
 * request. The rule is not "be careful what you log" — it is that being
 * careless cannot produce a credential on disk.
 */
const REDACTIONS: Array<[RegExp, string]> = [
    [/("?(?:app[_-]?password|password|token|secret|appPassword|sessionToken|poll_?token)"?\s*[:=]\s*"?)([^"\s,&}]+)/gi, '$1***'],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
    [/([?&](?:token|access_token|session|pickup|code)=)[^&\s]+/gi, '$1***'],
    // A Nextcloud app password is 29 characters of A-Za-z, printed in groups.
    [/\b[A-Za-z]{5}-[A-Za-z]{5}-[A-Za-z]{5}-[A-Za-z]{5}-[A-Za-z]{5}\b/g, '***'],
];

/** Strip anything that looks like a credential. Exported so it can be tested. */
export function redact(message: string): string {
    let out = String(message ?? '');
    for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
    return out;
}

export interface LoggerOptions {
    /** Directory for beeflow-desktop.log. */
    directory: string;
    level?: LogLevel;
    /** Also mirror to the console. On by default outside a packaged build. */
    console?: boolean;
}

export class Logger {
    readonly file: string;

    private readonly threshold: number;
    private readonly mirror: boolean;
    private stream: WriteStream | null = null;

    constructor(options: LoggerOptions) {
        this.file = path.join(options.directory, 'beeflow-desktop.log');
        this.threshold = LEVELS[options.level ?? 'info'];
        this.mirror = options.console ?? true;
        try {
            mkdirSync(options.directory, { recursive: true });
            this.rotateIfNeeded();
            this.stream = createWriteStream(this.file, { flags: 'a' });
        } catch (error) {
            // A log that cannot be written is not a reason to fail to start.
            console.warn(`[Log] could not open ${this.file}: ${String(error)}`);
        }
    }

    debug(scope: string, message: string): void {
        this.write('debug', scope, message);
    }
    info(scope: string, message: string): void {
        this.write('info', scope, message);
    }
    warn(scope: string, message: string): void {
        this.write('warn', scope, message);
    }
    error(scope: string, message: string): void {
        this.write('error', scope, message);
    }

    /** A warning sink shaped for the modules that take `onWarning`. */
    warnFor(scope: string): (message: string) => void {
        return (message: string) => this.warn(scope, message);
    }

    close(): void {
        this.stream?.end();
        this.stream = null;
    }

    private write(level: LogLevel, scope: string, message: string): void {
        if (LEVELS[level] < this.threshold) return;
        const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}\n`;
        if (this.mirror) {
            const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            sink(line.trimEnd());
        }
        try {
            this.stream?.write(line);
        } catch {
            /* a failed write must not become a second failure */
        }
    }

    private rotateIfNeeded(): void {
        try {
            if (!existsSync(this.file)) return;
            if (statSync(this.file).size < MAX_BYTES) return;
            renameSync(this.file, `${this.file}.1`);
        } catch {
            /* rotation is a nicety */
        }
    }
}
