import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import {
    appendText, buildFragment, caretToEnd, deleteBeforeCaret, ensureTrailingFiller,
    insertAtCaret, pillBeforeCaret, renderInto, serializeHost, textBeforeCaret,
    PILL_SELECTOR, pathOfRaw, rangeFromPoint, replacePill,
} from './refEditorDom';
import { parseRefTokens } from './refTokens';

/**
 * A text field where a reference to another step is a PILL, always.
 *
 * Drop-in replacement for the `<input>`/`<textarea>` + blurred-chip-overlay pair
 * that BindingField, TemplateField and PathField each carried. That pattern
 * showed the friendly name at rest and the raw id path the instant you clicked
 * in to edit — so `steps.act_f9aaff0e.output.results[*].output` was on screen
 * exactly when someone was trying to write a prompt. Here the reference is one
 * atomic node at all times; the raw path lives in `data-raw` and on the tooltip.
 *
 * ── HOW IT STAYS HONEST ─────────────────────────────────────────────
 * The stored value is never rewritten. Everything goes through
 * refEditorDom's `buildFragment` / `serializeHost` pair, whose round-trip is
 * byte-faithful and directly tested — a pill is a different PRESENTATION of the
 * exact original substring, not a re-rendering of it.
 *
 * ── WHY IT OWNS ITS DOM ─────────────────────────────────────────────
 * Re-rendering a contenteditable from React on every keystroke destroys the
 * caret. So the host is written once from `value` and thereafter only when the
 * value changes to something we did NOT just emit — an undo, an AI patch, a
 * step loading. `lastEmitted` is what tells those apart.
 *
 * A `{{…}}` typed or pasted by hand stays as text while the caret is inside it
 * (rewriting mid-word would move the caret out from under the author) and
 * becomes a pill on blur.
 *
 * Imperative handle — the callers drive insertion rather than splicing strings:
 *   focus()                  place the caret at the end
 *   insertSnippet(text)      insert `{{path}}` / a bare path at the caret
 *   replacePartial(n, text)  same, but first swallow the n chars just typed
 *   insertSnippetAt(text, {x,y})  insert where a DROP landed, not where the
 *                            caret last was — falls back to the caret
 *   replacePill(el, text)    swap one pill for another reference
 *   textBeforeCaret()        what has been typed up to the caret (autocomplete)
 *
 * `onPillClick({ el, raw, path })` fires when a pill is clicked: the host opens
 * its picker scoped to that step and answers with replacePill.
 */
const RefTokenInput = forwardRef(function RefTokenInput({
    value = '',
    mode = 'fixed',
    onChange,
    onFocus,
    onBlur,
    onDragOver,
    onDrop,
    onKeyDown,
    onInput,
    placeholder = '',
    multiline = false,
    rows = 4,
    stepLabelById = null,
    stepTypeById = null,
    className = '',
    ariaLabel = null,
    disabled = false,
    onPillClick = null,
    // Put a space between a dropped reference and a neighbouring word. Off
    // for a data slot (a URL, a JSON body), where a space changes the value.
    spaced = true,
}, ref) {
    const hostRef = useRef(null);
    // The exact string we last handed to onChange. The parent echoes it back as
    // the `value` prop; re-rendering on that echo would drop the caret on every
    // keystroke.
    const lastEmitted = useRef(null);
    // Where the caret was the last time it was inside this editor. Clicking the
    // {} button moves focus to the picker, so by the time a path comes back the
    // live selection is somewhere else entirely — remembering it is what makes
    // "insert here" mean here, in every browser.
    const caret = useRef(null);
    const saveCaret = useCallback(() => {
        const host = hostRef.current;
        const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
        if (!host || !sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (host.contains(range.commonAncestorContainer)) caret.current = range.cloneRange();
    }, []);

    const emit = useCallback(() => {
        const host = hostRef.current;
        if (!host) return;
        const next = serializeHost(host);
        lastEmitted.current = next;
        onChange?.(next);
    }, [onChange]);

    // Write the value in — on mount, and whenever it changes from outside.
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        if (lastEmitted.current !== null && lastEmitted.current === value) return;
        lastEmitted.current = null;
        renderInto(host, value, { mode, stepLabelById, stepTypeById });
    }, [value, mode, stepLabelById, stepTypeById]);

    // A step's label changed, or a step was deleted — the pills say so without
    // touching the value. Deliberately skipped while the field has focus: a
    // rebuild would move the caret mid-sentence.
    useEffect(() => {
        const host = hostRef.current;
        if (!host || host.contains(document.activeElement)) return;
        renderInto(host, serializeHost(host), { mode, stepLabelById, stepTypeById });
    }, [stepLabelById, stepTypeById, mode]);

    useImperativeHandle(ref, () => ({
        focus() {
            hostRef.current?.focus();
            caretToEnd(hostRef.current);
        },
        insertSnippet(snippet) {
            const host = hostRef.current;
            if (!host || !snippet) return;
            host.focus();
            // Spaced in BOTH modes: in a formula a second pick right after a
            // reference used to fuse into one bogus path
            // (`…output.emailsteps.b.output.email`) that looked valid and
            // resolved to nothing. A separate operand is a formula the checker
            // flags until an operator goes between them.
            insertAtCaret(host, nodesFor(snippet, mode, stepLabelById, stepTypeById), { range: caret.current, spaced });
            caret.current = null;
            emit();
        },
        replacePartial(length, snippet) {
            const host = hostRef.current;
            if (!host || !snippet) return;
            host.focus();
            deleteBeforeCaret(host, length, { range: caret.current });
            insertAtCaret(host, nodesFor(snippet, mode, stepLabelById, stepTypeById));
            caret.current = null;
            emit();
        },
        insertSnippetAt(snippet, point) {
            const host = hostRef.current;
            if (!host || !snippet) return;
            const range = point ? rangeFromPoint(host, point.x, point.y) : null;
            host.focus();
            insertAtCaret(host, nodesFor(snippet, mode, stepLabelById, stepTypeById), { range: range || caret.current, spaced });
            caret.current = null;
            emit();
        },
        replacePill(pill, snippet) {
            const host = hostRef.current;
            if (!host || !pill || !snippet) return;
            host.focus();
            replacePill(host, pill, nodesFor(snippet, mode, stepLabelById, stepTypeById));
            caret.current = null;
            emit();
        },
        textBeforeCaret() {
            return textBeforeCaret(hostRef.current);
        },
        get element() { return hostRef.current; },
    }), [emit, mode, stepLabelById, stepTypeById]);

    const handleClick = (e) => {
        if (!onPillClick) return;
        const pill = e.target?.closest?.(PILL_SELECTOR);
        if (!pill || !hostRef.current?.contains(pill)) return;
        e.preventDefault();
        const raw = pill.dataset.raw || '';
        onPillClick({ el: pill, raw, path: pathOfRaw(raw) });
    };

    const handleKeyDown = (e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const host = hostRef.current;
        if (!host) return;

        if (e.key === 'Enter') {
            // A single-line slot must not gain one, and Enter is the natural way
            // to accept an open suggestion — so the caller sees it first (above).
            if (!multiline) { e.preventDefault(); return; }
            e.preventDefault();
            const br = document.createElement('br');
            insertAtCaret(host, [br]);
            ensureTrailingFiller(host);
            emit();
            return;
        }
        if (e.key === 'Backspace') {
            // One press removes the whole reference, on every browser.
            const pill = pillBeforeCaret(host);
            if (!pill) return;
            e.preventDefault();
            pill.remove();
            emit();
        }
    };

    // Paste as PLAIN TEXT. A copied fragment brings styling, links and its own
    // wrappers, none of which survive serialization — pasting rich content would
    // silently drop parts of what the author pasted.
    const handlePaste = (e) => {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;
        const host = hostRef.current;
        const frag = document.createDocumentFragment();
        appendText(frag, text);
        insertAtCaret(host, Array.from(frag.childNodes));
        emit();
    };

    const handleBlur = (e) => {
        const host = hostRef.current;
        // Now that the caret is gone, anything typed as `{{…}}` by hand can
        // safely become a pill — but ONLY then. Rebuilding on every blur
        // replaced every pill element, and a pill the author had just
        // clicked (the picker's search box takes focus, so the click IS a
        // blur) was detached before the picker could anchor to it or the
        // pick could replace it.
        if (host && needsPills(host, mode)) renderInto(host, serializeHost(host), { mode, stepLabelById, stepTypeById });
        onBlur?.(e);
    };

    const handleInput = (e) => {
        saveCaret();
        emit();
        onInput?.(e);
    };

    const isEmpty = !String(value ?? '');

    return (
        <div className="relative">
            <div
                ref={hostRef}
                role="textbox"
                tabIndex={disabled ? -1 : 0}
                contentEditable={!disabled}
                suppressContentEditableWarning
                aria-multiline={multiline || undefined}
                aria-label={ariaLabel || undefined}
                aria-readonly={disabled || undefined}
                // A contenteditable has no native placeholder, so the visible
                // one is painted below. Mirrored onto the element anyway: it is
                // how assistive tech and every `getByPlaceholderText` in the
                // suite find this field, and losing that would be a silent
                // accessibility regression rather than a visible one.
                placeholder={placeholder || undefined}
                aria-placeholder={placeholder || undefined}
                data-ref-editor=""
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onKeyUp={saveCaret}
                onMouseUp={saveCaret}
                onClick={handleClick}
                onPaste={handlePaste}
                onFocus={onFocus}
                onBlur={handleBlur}
                onDragOver={onDragOver}
                onDrop={onDrop}
                style={multiline ? { minHeight: `${Math.max(1, rows) * 1.5}rem` } : undefined}
                className={`${className} ${multiline ? 'whitespace-pre-wrap break-words' : 'whitespace-nowrap overflow-x-auto'} ${
                    disabled ? 'opacity-60' : ''
                }`}
            />
            {isEmpty && placeholder ? (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2 top-1.5 text-xs text-[var(--text-tertiary)] truncate max-w-[calc(100%-1rem)]"
                >
                    {placeholder}
                </span>
            ) : null}
        </div>
    );
});

/**
 * Is there a reference in the text that is not a pill yet? Exactly when the
 * value parses to more references than the host has pill elements.
 */
function needsPills(host, mode) {
    const refs = parseRefTokens(serializeHost(host), { mode }).filter(t => t.type === 'ref').length;
    return refs !== host.querySelectorAll(PILL_SELECTOR).length;
}

/**
 * The nodes a snippet becomes. A snippet that IS a reference (which is what the
 * picker, the variable tree and a drag from the input panel all produce) becomes
 * a pill immediately — the author never sees the path they just inserted.
 */
function nodesFor(snippet, mode, stepLabelById, stepTypeById) {
    const frag = buildFragment(snippet, { mode, stepLabelById, stepTypeById });
    return Array.from(frag.childNodes);
}

export default RefTokenInput;
