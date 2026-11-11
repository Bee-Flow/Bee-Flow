/**
 * App Studio runtime: design.tokens (package LK16, server/appStudio/designTokens.mts).
 *
 * A token is the CSS variable --app-token-<name> on the app root (tokenVars, emitted by
 * appDesignProps), so the app's stylesheet can read it. A colour knob holding `token:<name>`
 * paints `var(--app-token-<name>)` (tokenColorVar, read by the style resolver). A name that is not
 * a token resolves to nothing, as the validator warns.
 */

const TOKEN_PREFIX = 'token:';
const HEAD = 'abcdefghijklmnopqrstuvwxyz';
const TAIL = `${HEAD}0123456789-`;
const HEX = '0123456789abcdefABCDEF';
const MAX_NAME = 32;

/** A token name as server/appStudio/componentSpecs/colorValue.js accepts it. */
export function isTokenName(name: unknown): name is string {
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME || !HEAD.includes(name[0])) return false;
    return [...name.slice(1)].every((ch) => TAIL.includes(ch));
}

const isHex = (v: unknown): v is string => typeof v === 'string' && v.length === 7 && v[0] === '#' && [...v.slice(1)].every((ch) => HEX.includes(ch));

/** `var(--app-token-<name>)` for a `token:<name>` value, else null. */
export function tokenColorVar(value: unknown): string | null {
    if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX)) return null;
    const name = value.slice(TOKEN_PREFIX.length);
    return isTokenName(name) ? `var(--app-token-${name})` : null;
}

/** The CSS variables of design.tokens: a colour as written, a spacing as <n>px. Empty for none. */
export function tokenVars(tokens: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return out;
    for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
        if (!isTokenName(name)) continue;
        if (isHex(value)) out[`--app-token-${name}`] = value;
        else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[`--app-token-${name}`] = `${value}px`;
    }
    return out;
}
