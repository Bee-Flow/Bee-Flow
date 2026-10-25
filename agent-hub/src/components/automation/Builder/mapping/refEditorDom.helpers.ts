import { fieldTailLabel, parseRefTokens, resolveChipLabel, type LabelLookup, type RefToken } from './refTokens';
import { stepFamily } from '../flow/nodeDefs';
import { typeColorVar } from '../flow/nodeTypeColors';

export const PILL_ATTR = 'data-ref-pill';

const PILL_CLASS = [
    'inline-flex items-center gap-1 align-baseline mx-0.5 rounded px-1.5 py-0.5',
    'text-[11px] border select-none whitespace-nowrap',
    // Clickable: the host opens its picker scoped to the pill's step.
    'cursor-pointer hover:ring-1 hover:ring-[color-mix(in_srgb,var(--pill-tint)_60%,transparent)]',
].join(' ');

// The pill wears the colour of the step FAMILY it points at (artboard 2a): a
// value from an AI step is blue, from the trigger green, from the loop item
// cyan — the same colour as that card on the canvas. `--pill-tint` is set
// inline per pill (pillTint); these classes only mix it. `--accent` is grey
// and reserved for chrome, so it never carries a pill.
export const PILL_TINT_CLASS = 'border-[color-mix(in_srgb,var(--pill-tint)_45%,transparent)] bg-[color-mix(in_srgb,var(--pill-tint)_14%,transparent)] text-[var(--pill-tint)]';

const PILL_OK = PILL_TINT_CLASS;

// A reference to a step that no longer exists. Muted and dashed rather than red:
// it is usually a step the author just deleted, not an error to be alarmed by —
// but it must stay visible, because it is the only way to find and fix it.
const PILL_MISSING = 'border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]';

/** The family colour for the step a token points at; ink-grey when unknown. */
export function pillTint(token: Pick<RefToken, 'source' | 'stepId'> | null | undefined, stepTypeById: { get?(id: string | undefined): string | undefined } | null = null): string {
    const family = token?.source === 'trigger' ? 'trigger'
        : token?.source === 'loop' ? 'loop'
        : stepFamily(stepTypeById?.get?.(token?.stepId));
    return family ? typeColorVar(family) : 'var(--text-secondary)';
}

/**
 * One reference, as an atomic editor node.
 *
 * `data-raw` is the EXACT original substring (braces and inner spacing
 * included), which is what makes the round-trip byte-faithful — the pill is a
 * different presentation of that text, never a re-rendering of it.
 */
export function buildPill(token: RefToken, { stepLabelById = null, stepTypeById = null, doc = document }: { stepLabelById?: LabelLookup | null; stepTypeById?: { get?(id: string | undefined): string | undefined } | null; doc?: Document } = {}): HTMLSpanElement {
    const { name, suffix, missing } = resolveChipLabel(token, stepLabelById);
    const el = doc.createElement('span');
    el.setAttribute(PILL_ATTR, '');
    el.setAttribute('contenteditable', 'false');
    el.dataset.raw = token.raw;
    el.className = `${PILL_CLASS} ${missing ? PILL_MISSING : PILL_OK}`;
    el.style.setProperty('--pill-tint', pillTint(token, stepTypeById));
    el.title = missing ? `Step no longer exists — ${token.path}` : token.path;

    const nameEl = doc.createElement('span');
    nameEl.className = 'font-medium';
    nameEl.textContent = name;
    el.appendChild(nameEl);

    // The FIELD's name, not its path: "gmail read ▸ Output" tells an author
    // where the value comes from; "gmail read ▸ results[0].output" does not.
    // The name is the field's own key (`fields["Story Points"]` reads "Story
    // points", `headers[name="Subject"].value` "Subject"). The exact path is
    // one hover away.
    const tail = suffix ? fieldTailLabel(suffix) : '';
    if (tail) {
        const suffixEl = doc.createElement('span');
        suffixEl.className = 'opacity-70';
        suffixEl.textContent = `▸ ${tail}`;
        el.appendChild(suffixEl);
    }
    return el;
}

/**
 * A value → the editor's child nodes. Literal runs become text nodes with `<br>`
 * for newlines; every recognised reference becomes a pill.
 */
export function buildFragment(value: unknown, { mode = 'fixed', stepLabelById = null, stepTypeById = null, doc = document }: { mode?: string; stepLabelById?: LabelLookup | null; stepTypeById?: { get?(id: string | undefined): string | undefined } | null; doc?: Document } = {}): DocumentFragment {
    const frag = doc.createDocumentFragment();
    for (const token of parseRefTokens(value, { mode })) {
        if (token.type === 'ref') {
            frag.appendChild(buildPill(token, { stepLabelById, stepTypeById, doc }));
            continue;
        }
        appendText(frag, token.text, doc);
    }
    return frag;
}

/** Text with newlines → text nodes separated by <br>. */
export function appendText(parent: Node, text: unknown, doc: Document = document): void {
    const parts = String(text ?? '').split('\n');
    parts.forEach((part: string, i: number) => {
        if (i > 0) parent.appendChild(doc.createElement('br'));
        if (part) parent.appendChild(doc.createTextNode(part));
    });
}
