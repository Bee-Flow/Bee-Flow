/**
 * Privacy Shield placeholders left in a value: `[person_223]`, `[email_1]`,
 * the shape core/privacy/piiDetection/tokenizer.js mints (`[<category>_<n>]`).
 *
 * The chat restores the tokens of its OWN conversation in a tool's arguments
 * before the tool runs (usecases/ai/directChat/toolExecSteps.js
 * restoreDlpTokens). A token still there afterwards is one this conversation
 * does not know, so its real value is not here: a tool that stores what it is
 * given refuses it instead of saving the placeholder as if it were the value.
 *
 * Plain string scanning, no regular expression: the text is model output.
 */

const MAX_TOKEN = 80;
const isCategoryChar = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** Whether `inner` (the text between the brackets) reads `<category>_<number>`. */
function isTokenBody(inner: string): boolean {
    const cut = inner.lastIndexOf('_');
    if (cut < 1 || cut === inner.length - 1) return false;
    const category = inner.slice(0, cut);
    const number = inner.slice(cut + 1);
    return [...category].every(isCategoryChar) && [...number].every(isDigit);
}

/** The first placeholder in a text, or null. */
function tokenInText(text: string): string | null {
    let open = text.indexOf('[');
    while (open !== -1) {
        const close = text.indexOf(']', open + 1);
        if (close === -1) return null;
        const inner = text.slice(open + 1, close);
        if (inner.length <= MAX_TOKEN && isTokenBody(inner)) return `[${inner}]`;
        open = text.indexOf('[', open + 1);
    }
    return null;
}

/** The first placeholder anywhere in a value (texts, lists, objects), or null. */
export function findMaskedToken(value: unknown, depth = 0): string | null {
    if (typeof value === 'string') return tokenInText(value);
    if (depth > 4 || !value || typeof value !== 'object') return null;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
        const found = findMaskedToken(item, depth + 1);
        if (found) return found;
    }
    return null;
}
