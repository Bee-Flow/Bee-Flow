/**
 * Numeric settings from the environment, read the one way the server reads them.
 *
 *   const RPM = envInt('STUDIO_APP_STEP_RATE', 60, { min: 1 });
 *   const SHARE = envNumber('PYANNOTE_IDENTIFY_MIN_SHARE', 0.6, { positive: true });
 *
 * Unset or empty (after trimming) gives the default, silently. A value that is
 * not a number of the asked kind, or that falls outside the bounds, gives the
 * default too, with one `log.warn` per variable name: the operator learns that
 * the setting is ignored instead of finding out from behaviour. It never
 * throws: an install that carries an old bad value keeps starting after an
 * upgrade.
 *
 * Bounds are inclusive. A tunable where 0 means nothing (an interval, a batch
 * size, a rate limit) passes `min: 1` (or `positive: true` for a fraction), so a
 * configured 0 falls back to the default. A setting where 0 means "off" or
 * "unlimited" passes `min: 0`, and 0 is then used as given.
 *
 * The rejected value is logged, because these values are numbers. A name that
 * looks like it holds a secret (key, token, secret, password) never has its
 * value logged, only its name.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log') as { warn: (msg: string) => void };

export interface EnvNumberBounds {
    /** Smallest accepted value (inclusive). */
    min?: number;
    /** Largest accepted value (inclusive). */
    max?: number;
    /** Only values above 0 are accepted (for fractions, where `min: 1` does not fit). */
    positive?: boolean;
}

const SECRET_NAME = /secret|key|token|passw|credential/i;
const warned = new Set<string>();

function boundsText({ min, max, positive }: EnvNumberBounds): string {
    const parts: string[] = [];
    if (positive) parts.push('above 0');
    if (min !== undefined) parts.push(`at least ${min}`);
    if (max !== undefined) parts.push(`at most ${max}`);
    return parts.length ? ` ${parts.join(' and ')}` : '';
}

function warnOnce(name: string, raw: string, kind: string, bounds: EnvNumberBounds, defaultValue: number): void {
    if (warned.has(name)) return;
    warned.add(name);
    const shown = SECRET_NAME.test(name) ? '(value not shown)' : JSON.stringify(raw);
    log.warn(`[env] ${name}=${shown} is not ${kind}${boundsText(bounds)}; using the default ${defaultValue}`);
}

function inBounds(n: number, { min, max, positive }: EnvNumberBounds): boolean {
    if (positive && !(n > 0)) return false;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
}

function read(name: string, defaultValue: number, bounds: EnvNumberBounds, integer: boolean): number {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    const text = raw.trim();
    if (text === '') return defaultValue;
    const n = Number(text);
    const ok = integer ? Number.isSafeInteger(n) : Number.isFinite(n);
    if (ok && inBounds(n, bounds)) return n;
    warnOnce(name, raw, integer ? 'an integer' : 'a number', bounds, defaultValue);
    return defaultValue;
}

/** An integer setting: unset, empty, not an integer or out of bounds gives `defaultValue`. */
export function envInt(name: string, defaultValue: number, bounds: EnvNumberBounds = {}): number {
    return read(name, defaultValue, bounds, true);
}

/** A number setting (fractions allowed): unset, empty, not a finite number or out of bounds gives `defaultValue`. */
export function envNumber(name: string, defaultValue: number, bounds: EnvNumberBounds = {}): number {
    return read(name, defaultValue, bounds, false);
}
