import { Bold, Italic, Link2, List, ListOrdered, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useFormField } from '../formContext';
import { Field } from '../uiBits';
import useValueFrom from '../useValueFrom';

/**
 * App Studio runtime — 'input_richtext'. Spec: server/appStudio/componentSpecs.js.
 *
 * A what-you-see editor whose VALUE is still markdown.
 *
 * It used to be a markdown SOURCE box with a preview toggle, which meant the
 * person writing an internal note looked at `**spoed**` and a stack of `- `
 * while typing, and had to press Preview to find out what they had written.
 * Markdown is a fine storage format and a poor writing surface for anyone who
 * did not ask for it.
 *
 * So: a contentEditable showing real bold, real italics, real bullets — and a
 * serializer that turns that back into markdown on every keystroke. Storage,
 * the CSV exports and every markdown reader downstream are unchanged; only the
 * thing under the cursor is different.
 *
 * The supported subset is deliberately small — bold, italic, links, bulleted
 * and numbered lists — because every token here has to survive a round trip
 * (markdown → DOM → markdown) unchanged. A feature that cannot make that trip
 * intact silently eats someone's note the second time they open it.
 *
 * NO HTML IS EVER TRUSTED. Incoming markdown is escaped before any tag is
 * added, and the only tags that reach innerHTML are the ones written here.
 */

// Quotes too: a link's href lands inside an attribute, and an unescaped `"`
// there lets `[x](https://a"onmouseover="…)` add its own event handler.
const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inline markdown → HTML, over the escaped text only. */
function inlineToHtml(md) {
    let s = escapeHtml(md);
    // Links first: their label may itself be bold or italic. Label and href
    // come from `s`, which is already escaped; escaping them again would turn
    // the `&` in a query string into a literal `&amp;`.
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, label, href) => {
        const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : '';
        return `<a href="${safe}">${label || href}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
}

/**
 * Markdown → the HTML the editor edits. Blocks become <div>s and lists become
 * real <ul>/<ol>, which is what execCommand produces too — so what the parser
 * writes and what typing produces are the same shapes, and the serializer only
 * ever has one grammar to read.
 */
export function markdownToHtml(md) {
    const lines = String(md ?? '').split(/\r?\n/);
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const line of lines) {
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        const want = bullet ? 'ul' : numbered ? 'ol' : null;
        if (want) {
            if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
            out.push(`<li>${inlineToHtml((bullet || numbered)[1])}</li>`);
            continue;
        }
        closeList();
        out.push(line.trim() ? `<div>${inlineToHtml(line)}</div>` : '<div><br></div>');
    }
    closeList();
    return out.join('');
}

/** One node's inline content → markdown. */
function inlineToMarkdown(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const inner = Array.from(node.childNodes).map(inlineToMarkdown).join('');
    switch (node.tagName) {
        case 'BR': return '\n';
        // A wrapper with no text is not emphasis, it is leftover markup — and
        // `****` in the stored value would render as literal asterisks.
        case 'B': case 'STRONG': return inner.trim() ? `**${inner}**` : inner;
        case 'I': case 'EM': return inner.trim() ? `*${inner}*` : inner;
        case 'A': {
            const href = node.getAttribute('href') || '';
            return href ? `[${inner}](${href})` : inner;
        }
        default: return inner;
    }
}

/** The editor's DOM → markdown. The inverse of markdownToHtml. */
export function htmlToMarkdown(root) {
    const blocks = [];
    for (const child of Array.from(root.childNodes)) {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
            const ordered = child.tagName === 'OL';
            Array.from(child.children).forEach((li, i) => {
                blocks.push(`${ordered ? `${i + 1}.` : '-'} ${inlineToMarkdown(li).trim()}`);
            });
            continue;
        }
        if (child.nodeType === 1 && (child.tagName === 'DIV' || child.tagName === 'P')) {
            blocks.push(inlineToMarkdown(child).replace(/\n+$/, ''));
            continue;
        }
        const loose = inlineToMarkdown(child);
        if (loose) blocks.push(loose);
    }
    // A trailing empty block is what pressing Enter leaves behind; keeping it
    // would grow the stored value by one newline every time the note is saved.
    return blocks.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

export default function AppInputRichtext({ node }) {
    const { t } = useTranslation();
    const { name, label = t('studio_apps_runtime.rich_text.content', 'Content'), required = false, defaultValue = null, placeholder = null } = node.props || {};
    const { value, setValue, error } = useFormField({ name, defaultValue: defaultValue ?? '', required, label });
    useValueFrom(node, setValue);
    const boxRef = useRef(null);
    // What we last WROTE into the form. Any incoming value different from this
    // came from outside (valueFrom, a reset, an edit opening a saved note) and
    // is the only case where the DOM may be rebuilt — rebuilding it on our own
    // keystrokes would drop the caret to the start of the box on every letter.
    const lastRef = useRef(null);
    const [linking, setLinking] = useState(false);
    const [href, setHref] = useState('');
    const id = `${node.id}-input`;
    const text = value ?? '';

    useEffect(() => {
        const el = boxRef.current;
        if (!el || text === lastRef.current) return;
        lastRef.current = text;
        el.innerHTML = markdownToHtml(text);
    }, [text]);

    const commit = () => {
        const el = boxRef.current;
        if (!el) return;
        const md = htmlToMarkdown(el);
        lastRef.current = md;
        setValue(md);
    };

    // execCommand is deprecated and still the only thing every browser
    // implements for this. styleWithCSS off keeps bold as <b> rather than a
    // <span style>, which the serializer would read as plain text.
    const exec = (cmd, arg) => {
        const el = boxRef.current;
        if (!el) return;
        el.focus();
        try {
            document.execCommand('styleWithCSS', false, false);
            document.execCommand(cmd, false, arg);
        } catch { /* an unsupported command leaves the text alone */ }
        commit();
    };

    const btn = (key, Icon, onClick, title) => (
        <button
            key={key}
            type="button"
            title={title}
            aria-label={title}
            // Mousedown, not click: by click time the selection is already gone,
            // so Bold would have nothing to embolden.
            onMouseDown={(e) => { e.preventDefault(); onClick(); }}
            className="inline-flex items-center justify-center w-7 h-7"
            style={{ color: 'var(--text-secondary)', borderRadius: 'var(--app-radius)' }}
        >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );

    return (
        <Field id={id} label={label} required={required} error={error}>
            <div
                className="flex flex-col border overflow-hidden"
                style={{ borderColor: error ? 'var(--error)' : 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-primary)' }}
            >
                <div
                    className="flex items-center gap-0.5 px-1.5 py-1 border-b"
                    style={{ borderColor: 'var(--border-default)', background: 'var(--bg-tertiary)' }}
                    role="toolbar"
                    aria-label={t('studio_apps_runtime.rich_text.formatting', 'Formatting')}
                >
                    {btn('bold', Bold, () => exec('bold'), t('studio_apps_runtime.rich_text.bold', 'Bold'))}
                    {btn('italic', Italic, () => exec('italic'), t('studio_apps_runtime.rich_text.italic', 'Italic'))}
                    {btn('ul', List, () => exec('insertUnorderedList'), t('studio_apps_runtime.rich_text.bullets', 'Bulleted list'))}
                    {btn('ol', ListOrdered, () => exec('insertOrderedList'), t('studio_apps_runtime.rich_text.numbered', 'Numbered list'))}
                    {btn('link', Link2, () => setLinking((v) => !v), t('studio_apps_runtime.rich_text.link', 'Link'))}
                </div>

                {/* An inline field rather than window.prompt: a prompt is blocked
                    outright inside the Nextcloud embedding, where the button
                    would simply do nothing. */}
                {linking ? (
                    <div className="flex items-center gap-1.5 px-1.5 py-1 border-b" style={{ borderColor: 'var(--border-default)' }}>
                        <input
                            value={href}
                            autoFocus
                            onChange={(e) => setHref(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                if (href) exec('createLink', href);
                                setLinking(false); setHref('');
                            }}
                            placeholder="https://…"
                            aria-label={t('studio_apps_runtime.rich_text.link_address', 'Link address')}
                            className="min-w-0 flex-1 px-2 py-1 text-xs outline-none"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                        />
                        <button
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); if (href) exec('createLink', href); setLinking(false); setHref(''); }}
                            className="px-2 py-1 text-xs font-medium"
                            style={{ color: 'var(--app-primary)' }}
                        >
                            {t('studio_apps_runtime.rich_text.add', 'Add')}
                        </button>
                        <button type="button" onClick={() => { setLinking(false); setHref(''); }} aria-label={t('studio_apps_runtime.rich_text.cancel', 'Cancel')} className="p-1" style={{ color: 'var(--text-secondary)' }}>
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                ) : null}

                <div
                    ref={boxRef}
                    id={id}
                    role="textbox"
                    aria-multiline="true"
                    aria-label={label}
                    aria-required={required || undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    contentEditable
                    suppressContentEditableWarning
                    data-app-richtext="true"
                    data-placeholder={placeholder || t('studio_apps_runtime.rich_text.richtext_placeholder', 'Write here…')}
                    onInput={commit}
                    onBlur={commit}
                    className="app-richtext w-full px-2.5 py-2 text-sm outline-none min-h-[6rem] overflow-auto"
                    style={{ color: 'var(--text-primary)' }}
                />
                {/* The markdown is what the form submits; the box above is only
                    how it is typed. Hidden rather than absent so a plain form
                    POST and any test reading by name still find the value. */}
                <input type="hidden" name={name} value={text} readOnly />
            </div>
        </Field>
    );
}
