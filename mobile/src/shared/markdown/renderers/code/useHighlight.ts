/**
 * Syntax highlighting, debounced as on the web: 150 ms after the code last
 * changed (300 ms past a thousand characters). While a block streams in, its
 * text changes on every flush, so the tokenizer runs when the stream pauses
 * or the fence closes — not twenty times a second.
 *
 * Runs computed for an older text are never shown against a newer one: until
 * the current text is highlighted it is drawn plain, so the words on screen
 * are always the words in the answer.
 */

import { useEffect, useState } from 'react';

import { loadHighlighter } from '../lazyModules';
import { paintedScope } from './codeTheme';
import { htmlToRuns, type CodeRun } from './hljsHtml';

export function highlightRuns(code: string, language: string): CodeRun[] | null {
    const engine = loadHighlighter();
    if (!engine) return null;
    try {
        return htmlToRuns(engine.highlightHtml(code, language), paintedScope);
    } catch {
        return null;
    }
}

export function highlightDelay(code: string): number {
    return code.length > 1000 ? 300 : 150;
}

export function useHighlight(code: string, language: string): CodeRun[] | null {
    const [done, setDone] = useState<{ code: string; language: string; runs: CodeRun[] | null } | null>(null);
    const current = done !== null && done.code === code && done.language === language;

    useEffect(() => {
        if (current) return undefined;
        const timer = setTimeout(() => setDone({ code, language, runs: highlightRuns(code, language) }), highlightDelay(code));
        return () => clearTimeout(timer);
    }, [code, language, current]);

    return current ? done.runs : null;
}
