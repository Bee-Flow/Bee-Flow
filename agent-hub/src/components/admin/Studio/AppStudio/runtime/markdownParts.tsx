import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';

/**
 * App Studio runtime: the pieces both markdown renderers draw the same way (AppMarkdown's
 * plain block parser and markdownRich.tsx): heading classes, the code block with its copy
 * button and the part-class token.
 */

export type BlockLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const HEADING_CLS: Record<BlockLevel, string> = {
    1: 'text-2xl font-semibold',
    2: 'text-xl font-semibold',
    3: 'text-lg font-semibold',
    4: 'text-base font-semibold',
    5: 'text-sm font-semibold',
    6: 'text-sm font-medium',
};

/**
 * A fenced code block with a copy button.
 *
 * Not decoration: a code block is what an app uses to hand a person text meant
 * for somewhere ELSE — an export line, an id, a generated CSV. Without this the
 * only instruction anyone could give was "drag with the mouse from the first
 * line to the last, then Ctrl+C", which is what the quote-intake template
 * actually said. Ctrl+A does not help: it selects the whole page.
 *
 * navigator.clipboard is absent on http origins and in some embeddings, so the
 * button hides itself rather than failing on click.
 */
export function CodeBlock({ code, partClasses = false }: { code: string; partClasses?: boolean }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;

    useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => setCopied(false), 1600);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false);       // clipboard denied — the text stays selectable
        }
    };

    return (
        <div className={`app-code-block relative group${partClasses ? ' bfa-markdown__code' : ''}`}>
            <pre
                className="text-xs p-3 overflow-x-auto border [background:var(--bg-tertiary)] [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-primary)]!"
            >
                <code>{code}</code>
            </pre>
            {canCopy ? (
                <button
                    type="button"
                    onClick={copy}
                    aria-label={copied ? t('studio_apps_runtime.markdown.copied', 'Copied') : t('studio_apps_runtime.markdown.copy_to_clipboard', 'Copy to clipboard')}
                    className="app-code-copy absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
                    style={{
                        borderColor: 'var(--border-default)',
                        background: 'var(--bg-card)',
                        color: copied ? 'var(--success)' : 'var(--text-secondary)',
                    }}
                >
                    {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
                    {copied ? t('studio_apps_runtime.markdown.copied', 'Copied') : t('studio_apps_runtime.markdown.copy', 'Copy')}
                </button>
            ) : null}
        </div>
    );
}

/** The `bfa-markdown__<part>` token, only where the markdown COMPONENT draws the blocks (the AI chat shares them). */
export const part = (on: boolean, name: string) => (on ? ` bfa-markdown__${name}` : '');
