/**
 * The colour tokens of an app's design (design.tokens, package LK16) as the colour control offers
 * them: the tokens whose value is a #rrggbb colour, by name. A spacing token is not a colour.
 */
import { isTokenName } from '../runtime/designTokens';

export const TOKEN_PREFIX = 'token:';
const HEX = '0123456789abcdefABCDEF';
const isHex = (v: unknown): v is string => typeof v === 'string' && v.length === 7 && v[0] === '#' && [...v.slice(1)].every((ch) => HEX.includes(ch));

export interface ColourToken { name: string; hex: string }

/** The colour tokens of a definition, by name. Empty when it has none. */
export function colourTokensOf(definition: unknown): ColourToken[] {
    const design = (definition as { design?: { tokens?: unknown } } | null | undefined)?.design;
    const tokens = design?.tokens;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return [];
    return Object.entries(tokens as Record<string, unknown>)
        .filter((e): e is [string, string] => isTokenName(e[0]) && isHex(e[1]))
        .map(([name, hex]) => ({ name, hex }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** The token name of a `token:<name>` value, else null. */
export function tokenNameOf(value: unknown): string | null {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) ? value.slice(TOKEN_PREFIX.length) : null;
}

