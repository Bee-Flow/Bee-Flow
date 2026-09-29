import { Bold, Image as ImageIcon, Italic, Link2, List, ListOrdered, Underline, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFormField } from '../formContext';
import { Field } from '../uiBits';
import useValueFrom from '../useValueFrom';

/**
 * App Studio runtime — 'input_html'. Spec: server/appStudio/componentSpecs.js.
 *
 * The editor for text that leaves the building. Its VALUE is HTML.
 *
 * Its sibling `input_richtext` submits markdown, and for a note stored in the
 * app that is the better format: it round-trips, it diffs, and every markdown
 * reader downstream keeps working. Markdown has no colour, no typeface and no
 * image though — and a reply signed off with a company logo needs all three.
 * Rather than invent markdown extensions nothing else can read, this one speaks
 * the language mail already speaks.
 *
 * MAIL-SHAPED, NOT WEB-SHAPED. Everything here produces INLINE styles, because
 * that is the only styling Gmail and Outlook honour; a <style> block or a class
 * name is discarded or mangled by the client. So `styleWithCSS` is ON here —
 * the exact opposite of the markdown editor, which needs <b> rather than a
 * <span style> for its serializer to read.
 *
 * PASTE IS THE RISK. A paste out of Word or Outlook drags in <style> blocks,
 * class names, MSO conditionals and sometimes a <script>. It is cleaned on the
 * way IN, against the same shape the outbound sanitizer keeps
 * (server/services/email/send.js sanitizeHtml) — so what you see while typing
 * is what the recipient gets. That server pass remains the security boundary;
 * this one is about not carrying a kilobyte of Word cruft around.
 */

// Mirrors MAIL_ALLOWED_TAGS / MAIL_ALLOWED_ATTR in server/services/email/send.js.
// Kept as its own list rather than imported: this runs in the browser, that one
// needs JSDOM. sanitizeOutgoingHtml on the server is what actually protects the
// recipient — a divergence here costs formatting, never safety.
const ALLOWED_TAGS = new Set([
    'P', 'DIV', 'SPAN', 'BR', 'HR', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
    'IMG', 'FONT', 'SMALL', 'SUB', 'SUP',
]);
const ALLOWED_ATTR = new Set([
    'href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height',
    'style', 'align', 'valign', 'bgcolor', 'color', 'face', 'size',
    'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'dir',
]);
const SAFE_URI = /^(?:https?:|mailto:|tel:|cid:|data:image\/|\/|#)/i;

/**
 * Clean a pasted fragment down to mail-safe markup.
 *
 * Disallowed ELEMENTS are unwrapped rather than deleted — a `<span class=…>`
 * around a sentence should lose the span, not the sentence. Script and style
 * are the exception: their content is markup, not prose.
 */
export function cleanPastedHtml(html) {
    if (typeof html !== 'string' || !html.trim()) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 8) { child.remove(); continue; }   // comments: MSO conditionals live here
            if (child.nodeType !== 1) continue;
            const tag = child.tagName.toUpperCase();
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BASE' || tag === 'META' || tag === 'LINK') {
                child.remove();
                continue;
            }
            walk(child);
            if (!ALLOWED_TAGS.has(tag)) {
                child.replaceWith(...Array.from(child.childNodes));
                continue;
            }
            for (const attr of Array.from(child.attributes)) {
                const name = attr.name.toLowerCase();
                // on* handlers are not on the allowlist, so this covers them.
                if (!ALLOWED_ATTR.has(name)) { child.removeAttribute(attr.name); continue; }
                if ((name === 'href' || name === 'src') && !SAFE_URI.test(attr.value.trim())) {
                    child.removeAttribute(attr.name);
                }
            }
        }
    };
    walk(doc.body);
    return doc.body.innerHTML;
}

const FONTS = ['Calibri', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana'];
const SIZES = [['Klein', '2'], ['Normaal', '3'], ['Groot', '5']];
const COLORS = [
    ['Zwart', '#1a1a1a'], ['Grijs', '#6b7280'], ['Blauw', '#0369a1'],
    ['Groen', '#15803d'], ['Rood', '#b91c1c'],
];
const MAX_IMAGE_BYTES = 512 * 1024;

export default function AppInputHtml({ node }) {
    const {
        name, label = 'Message', required = false, defaultValue = null,
        placeholder = null, minRows = 8, allowImages = false,
    } = node.props || {};
    const { value, setValue, error } = useFormField({ name, defaultValue: defaultValue ?? '', required, label });
    useValueFrom(node, setValue);

    const boxRef = useRef(null);
    const fileRef = useRef(null);
    // What we last WROTE into the form. Anything different came from outside
    // (valueFrom, a reset, an AI draft) and is the only case where the DOM may
    // be rebuilt — rebuilding on our own keystrokes drops the caret to the top.
    const lastRef = useRef(null);
    const [linking, setLinking] = useState(false);
    const [href, setHref] = useState('');
    const [imageError, setImageError] = useState(null);
    const id = `${node.id}-input`;
    const html = value ?? '';

    useEffect(() => {
        const el = boxRef.current;
        if (!el || html === lastRef.current) return;
        lastRef.current = html;
        // Incoming values come from our own form or from an AI draft, and are
        // cleaned on the way in exactly like a paste.
        el.innerHTML = cleanPastedHtml(html);
    }, [html]);

    const commit = () => {
        const el = boxRef.current;
        if (!el) return;
        // An empty contentEditable still contains "<br>"; storing that would
        // make `required` pass on a blank message.
        const next = el.textContent.trim() || el.querySelector('img') ? el.innerHTML : '';
        lastRef.current = next;
        setValue(next);
    };

    const exec = (cmd, arg) => {
        const el = boxRef.current;
        if (!el) return;
        el.focus();
        try {
            // ON, unlike the markdown editor: mail wants inline styles.
            document.execCommand('styleWithCSS', false, true);
            document.execCommand(cmd, false, arg);
        } catch { /* an unsupported command leaves the text alone */ }
        commit();
    };

    const onPaste = (e) => {
        const clip = e.clipboardData;
        if (!clip) return;
        const pasted = clip.getData('text/html');
        if (!pasted) return; // plain text pastes as itself, nothing to clean
        e.preventDefault();
        document.execCommand('insertHTML', false, cleanPastedHtml(pasted));
        commit();
    };

    const onPickImage = (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        // A data URI lives inside the stored value and travels in every copy of
        // it, so the ceiling is low on purpose. Say so rather than silently
        // producing a 4 MB message body.
        if (file.size > MAX_IMAGE_BYTES) {
            setImageError(`Deze afbeelding is ${Math.round(file.size / 1024)} kB. Kies er een onder de ${MAX_IMAGE_BYTES / 1024} kB.`);
            return;
        }
        setImageError(null);
        const reader = new FileReader();
        reader.onload = () => exec('insertImage', String(reader.result));
        reader.readAsDataURL(file);
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

    const select = (key, title, options, onPick) => (
        <select
            key={key}
            title={title}
            aria-label={title}
            defaultValue=""
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) onPick(v); }}
            className="h-7 px-1 text-xs outline-none"
            style={{ background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--app-radius)' }}
        >
            <option value="">{title}</option>
            {options.map(([labelText, v]) => <option key={v} value={v}>{labelText}</option>)}
        </select>
    );

    return (
        <Field id={id} label={label} required={required} error={error}>
            <div
                className="flex flex-col border overflow-hidden"
                style={{ borderColor: error ? 'var(--error)' : 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-primary)' }}
            >
                <div
                    className="flex items-center flex-wrap gap-0.5 px-1.5 py-1 border-b"
                    style={{ borderColor: 'var(--border-default)', background: 'var(--bg-tertiary)' }}
                    role="toolbar"
                    aria-label="Opmaak"
                >
                    {btn('bold', Bold, () => exec('bold'), 'Vet')}
                    {btn('italic', Italic, () => exec('italic'), 'Cursief')}
                    {btn('underline', Underline, () => exec('underline'), 'Onderstrepen')}
                    {btn('ul', List, () => exec('insertUnorderedList'), 'Opsomming')}
                    {btn('ol', ListOrdered, () => exec('insertOrderedList'), 'Genummerde lijst')}
                    {btn('link', Link2, () => setLinking((v) => !v), 'Link')}
                    {allowImages ? btn('img', ImageIcon, () => fileRef.current?.click(), 'Afbeelding') : null}
                    <span className="w-px h-4 mx-1" style={{ background: 'var(--border-default)' }} aria-hidden="true" />
                    {select('font', 'Lettertype', FONTS.map((f) => [f, f]), (v) => exec('fontName', v))}
                    {select('size', 'Grootte', SIZES, (v) => exec('fontSize', v))}
                    {select('color', 'Kleur', COLORS, (v) => exec('foreColor', v))}
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
                            aria-label="Adres van de link"
                            className="min-w-0 flex-1 px-2 py-1 text-xs outline-none"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                        />
                        <button
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); if (href) exec('createLink', href); setLinking(false); setHref(''); }}
                            className="px-2 py-1 text-xs font-medium"
                            style={{ color: 'var(--app-primary)' }}
                        >
                            Toevoegen
                        </button>
                        <button type="button" onClick={() => { setLinking(false); setHref(''); }} aria-label="Annuleren" className="p-1" style={{ color: 'var(--text-secondary)' }}>
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
                    data-app-html-editor="true"
                    data-placeholder={placeholder || 'Schrijf je bericht…'}
                    onInput={commit}
                    onBlur={commit}
                    onPaste={onPaste}
                    className="app-richtext w-full px-2.5 py-2 text-sm outline-none overflow-auto"
                    style={{ color: 'var(--text-primary)', minHeight: `${Math.max(3, Math.min(30, minRows)) * 1.5}rem` }}
                />
                {allowImages ? (
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        className="hidden"
                        onChange={onPickImage}
                        aria-hidden="true"
                        tabIndex={-1}
                    />
                ) : null}
                {imageError ? (
                    <p className="px-2.5 pb-2 text-xs" role="alert" style={{ color: 'var(--error)' }}>{imageError}</p>
                ) : null}
                {/* The HTML is what the form submits; the box above is only how
                    it is typed. Hidden rather than absent so a plain form POST
                    and any test reading by name still find the value. */}
                <input type="hidden" name={name} value={html} readOnly />
            </div>
        </Field>
    );
}
