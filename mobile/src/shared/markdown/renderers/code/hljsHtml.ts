/**
 * highlight.js's HTML as runs of text with a scope: what a native <Text>
 * can paint. hljs writes only three things — `<span class="…">`, `</span>`
 * and escaped text — so a small scanner reads it exactly.
 *
 * A run's scope is its innermost span that the theme colours (codeTheme.ts),
 * so `<span class="hljs-string">"a<span class="hljs-subst">${b}</span>"</span>`
 * paints the interpolation in its own colour and the quotes as a string.
 */

import { decodeEntities } from '@/shared/markdown/parse/entities';

export interface CodeRun {
    text: string;
    /** The theme key (`keyword`, `title.function_`, …), or null for plain text. */
    scope: string | null;
}

const TOKEN = /<span class="([^"]*)">|<\/span>|[^<]+|</g;

/** `hljs-title function_` → `title.function_`; `hljs-keyword` → `keyword`. */
export function scopeKey(className: string): string {
    const [base = '', ...modifiers] = className.split(/\s+/).filter(Boolean);
    const name = base.replace(/^hljs-/, '');
    return modifiers.length ? `${name}.${modifiers.join('.')}` : name;
}

export function htmlToRuns(html: string, painted: (scope: string) => string | null): CodeRun[] {
    const runs: CodeRun[] = [];
    const stack: (string | null)[] = [];
    for (const match of html.matchAll(TOKEN)) {
        const [whole, className] = match;
        if (className !== undefined) {
            stack.push(painted(scopeKey(className)) ?? stack[stack.length - 1] ?? null);
        } else if (whole === '</span>') {
            stack.pop();
        } else {
            const text = decodeEntities(whole);
            const scope = stack[stack.length - 1] ?? null;
            const last = runs[runs.length - 1];
            if (last && last.scope === scope) last.text += text;
            else runs.push({ text, scope });
        }
    }
    return runs;
}
