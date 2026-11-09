/**
 * Quoted literals on the right-hand side of a condition (`"file"`, `'file'`).
 * Imports nothing: conditionModel.ts also runs under the phone's lockstep tests.
 */

/** The text of a double-quoted JSON string literal, or null when `token` is not one. */
function doubleQuotedText(token: string): string | null {
    if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return null;
    try {
        const value: unknown = JSON.parse(token);
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

/** The value of a quoted token, or undefined when `token` is not quoted. */
export function quotedLiteral(token: string): unknown {
    // A double-quoted literal is JSON as it stands. Turning its apostrophes
    // into quotes first would make `"it's \"x\""` unparseable, and the
    // fallback below would then keep the backslashes as text.
    const asWritten = doubleQuotedText(token);
    if (asWritten !== null) return asWritten;
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        try { return JSON.parse(token.replace(/'/g, '"')) as unknown; }
        catch { return token.slice(1, -1); }
    }
    return undefined;
}
