// Monaco, loaded lazily and measured against the app's theme. Moved here from
// codeFields.jsx unchanged in behaviour; see CodeEditorField for the three
// ways it can fail and what the author gets instead.
import { useEffect, type ComponentType } from 'react';
import { lazy } from '../../../../../../utils/lazyWithReload';

/** What we hand Monaco; the real component takes more, we pass only these. */
export interface MonacoProps {
    height: string;
    language: string;
    value: string;
    onChange: (v: string | undefined) => void;
    onMount: (editor: unknown, monaco: unknown) => void;
    onUnavailable: () => void;
    theme: string;
    options: Record<string, unknown>;
}

/** The stand-in the failed import resolves to: it reports, and renders nothing. */
function MonacoUnavailable({ onUnavailable }: { onUnavailable?: () => void }) {
    useEffect(() => { onUnavailable?.(); }, [onUnavailable]);
    return null;
}

/**
 * Monaco, lazily. The catch lives INSIDE the importer, so lazyWithReload
 * never sees the rejection and never reloads the page: a missing syntax
 * highlighter is not worth throwing the builder (and its unsaved autosave
 * debounce) away for, when a working textarea is one state flag below. The
 * failure resolves to a real component (not null, which is an invalid element
 * type) so the render that reveals it succeeds and reports itself.
 */
export const MonacoEditor = lazy(() => import('@monaco-editor/react')
    .then((m: { default?: unknown }) => {
        if (!m.default) throw new Error('Monaco default export missing');
        return { default: m.default };
    })
    .catch((err: unknown) => {
        console.error('[codeStep] Monaco failed to load:', err);
        return { default: MonacoUnavailable };
    })) as unknown as ComponentType<MonacoProps>;

/** Which editor the user picked last, remembered per user. */
export const EDITOR_PREF_KEY = 'automation.codeStep.editor';

/**
 * How long we wait for Monaco to actually appear before handing the author a
 * textarea anyway. `@monaco-editor/react` resolves as soon as its wrapper
 * chunk arrives; the editor RUNTIME is fetched afterwards from
 * cdn.jsdelivr.net (nothing here calls loader.config()). On an offline,
 * air-gapped or proxied self-host that fetch never completes: the import
 * succeeds and onMount never fires, so only a deadline notices. Generous on
 * purpose: a cold CDN fetch over a slow link is a normal five seconds, and
 * nothing is lost when it fires late because the code lives in the draft.
 */
export const MONACO_MOUNT_DEADLINE_MS = 8000;

/**
 * Is the card surface dark? Measured from --bg-card rather than listed by
 * theme name, so a theme added next year needs no entry here. Null when there
 * is nothing to measure (jsdom, a token that resolves to empty).
 */
function surfaceIsDark(): boolean | null {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    let raw = '';
    try {
        raw = window.getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim();
    } catch {
        return null;
    }
    if (!raw) return null;
    let rgb: number[] | null = null;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
        rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    } else {
        const fn = raw.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        if (fn) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    }
    if (!rgb || rgb.some(n => !Number.isFinite(n))) return null;
    // Rec. 601 luma: we choose between two editor themes, not check contrast.
    const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return luma < 0.5;
}

export function monacoTheme(): string {
    const dark = surfaceIsDark();
    if (dark !== null) return dark ? 'vs-dark' : 'vs';
    // Nothing measurable. The app's default theme is dark, and the OS
    // preference is the better of the two remaining guesses.
    try {
        if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'vs-dark';
    } catch { /* jsdom without matchMedia */ }
    return 'vs';
}

export function monacoOptions(ariaLabel: string): Record<string, unknown> {
    return {
        // Monaco's own accessible name: the visible label has no control to
        // point at, because which control exists depends on the user's choice.
        ariaLabel,
        accessibilitySupport: 'auto',
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: 'selection',
        folding: true,
        glyphMargin: true,
        // Suggestions are help, not a takeover: a popup that steals Enter is
        // the thing that makes people go back to a textarea.
        quickSuggestions: { other: false, comments: false, strings: false },
    };
}
