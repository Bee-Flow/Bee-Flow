import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { fieldNameTaken, isValidFieldName } from '../renameFormField';
import { cardClass, rowInputClass } from './formPrimitives';
import { useTranslation } from '@/hooks/useTranslation';
import type { FieldRowProps, RenameArgs, RowNameBoxArgs } from './fieldDesigner.types';

/**
 * The names a designer mints for a row the author has not named yet
 * (`input1`, `arg3`). Naming one over is not a rename — the row was created a
 * moment ago and nothing downstream can point at it — so it does not get the
 * caution about bindings left behind. Same carve-out approvalEditors makes for
 * its `qN` placeholder.
 *
 * Matched on the NAME rather than on "was this row here when the panel
 * opened": the answer then cannot go stale when the panel adopts another
 * step's content. The cost is one false negative — an author who really did
 * leave a parameter called `input1` and renames it gets no caution — which is
 * an advisory line missing, not a rename going wrong.
 */
export const PLACEHOLDER_NAME_RE = /^(?:input|arg)\d+$/;

/**
 * What is wrong with a name that is ALREADY STORED, or null.
 *
 * Shown standing, not on commit: an imported automation, an AI-authored
 * declaration or a row from before this box existed can hold a name the server
 * will refuse, and the author has to be able to see that without touching it
 * first. Two sentences, because "must start with a letter" is a lie about
 * `klant-naam`.
 */
export function nameProblem(name: string | null | undefined) {
    if (!name) return null;
    if (!/^[A-Za-z]/.test(name)) return 'Names must start with a letter (no leading _ or digit).';
    if (!isValidFieldName(name)) return 'Letters, digits and underscores only.';
    return null;
}

/**
 * THE rename path. Validates, refuses, carries, and words the outcome.
 *
 * Returns `{ ok, name, error, note, unchanged }`. It never throws and never
 * writes anything itself: the caller stores `name` only when `ok`, so a
 * refused rename leaves the declaration exactly as it was.
 *
 * @param {object}   o
 * @param {string}   o.from          the current binding name
 * @param {string}   o.to            what the author typed
 * @param {Array}    o.siblings      the other declared fields, for the collision check
 * @param {Function} o.onRenameField (from, to) => number|undefined — the host's
 *   rewrite of the whole automation. Absent wherever the editor can see the
 *   declaration but not the steps that bind it.
 * @param {string}   o.takenError    the collision sentence, in the caller's vocabulary
 * @param {boolean}  o.orphanNote    say out loud that nothing was repointed when
 *   there was no rewrite to do it. Off by default: the form builder's own box
 *   already explains, in standing text, where the rename lives instead.
 */
export function applyBindingRename({
    from,
    to,
    siblings = [],
    onRenameField = null,
    takenError = 'Another question on this page already binds that name.',
    orphanNote = false,
}: RenameArgs) {
    const next = String(to ?? '').trim();
    if (next === from) return { ok: false, unchanged: true, name: from, error: '', note: '' };
    if (!isValidFieldName(next)) {
        return { ok: false, unchanged: false, name: from, error: 'Start with a letter; letters, digits and underscores only.', note: '' };
    }
    if (fieldNameTaken(siblings, next, from)) {
        return { ok: false, unchanged: false, name: from, error: takenError, note: '' };
    }
    // The host rewrites the whole automation from ITS copy of the definition,
    // which still holds the old name — so that call goes FIRST. The caller
    // then renames its own declaration, because the panel's draft is what the
    // node's autosave writes back; without it the save would put the old name
    // straight back over the rename a moment later.
    const moved = typeof onRenameField === 'function' ? onRenameField(from, next) : undefined;
    return { ok: true, unchanged: false, name: next, error: '', note: renameNote(moved, from, orphanNote) };
}

/** How the rename is reported back. Separate so both widgets word it the same. */
function renameNote(moved: number | undefined, from: string, orphanNote: boolean) {
    if (typeof moved === 'number') {
        // The plural half is the wording the form builder has always shown and
        // its test pins; only the singular is corrected here, where "1 binding
        // … now point at it" read as a typo in the one case an author is most
        // likely to hit.
        return moved > 0
            ? `Renamed — ${moved} ${moved === 1 ? 'binding' : 'bindings'} in this automation now ${moved === 1 ? 'points' : 'point'} at it.`
            : 'Renamed. Nothing was pointing at it yet.';
    }
    // No rewrite behind the box. Said out loud rather than left to be found at
    // run time by a step that quietly receives nothing.
    return orphanNote ? `Renamed here only — steps that bind “${from}” still point at the old name.` : '';
}

/**
 * The binding name as a parameter row shows it: inline, first in the row,
 * because here the name IS the field — a parameter has no label to read
 * instead.
 *
 * Same commit discipline as the block above. The box holds its own draft while
 * the author types and writes on Enter or blur, so `email` on the way to
 * `email_address` is never stored, never saved, and never rewrites an automation
 * eight times.
 */
function useRowNameBox({ name, siblings, onRenameField, onCommit, sanitize, takenError, ariaLabel }: RowNameBoxArgs) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(name);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const [seen, setSeen] = useState(name);
    // Adopt an outside change (an undo, the AI builder, a row removed above
    // this one) without fighting the author mid-keystroke. The NOTE survives
    // on purpose: committing a rename IS an outside change — it writes the new
    // name back through the list — and clearing it here would wipe the "3
    // bindings now point at it" the author has to read.
    if (seen !== name) { setSeen(name); setDraft(name); setError(''); }

    const commit = () => {
        const out = applyBindingRename({
            from: name,
            to: draft,
            siblings,
            onRenameField,
            takenError,
            // A row the designer minted a moment ago carries no bindings to
            // lose, so the caution about bindings left behind would be noise.
            orphanNote: !PLACEHOLDER_NAME_RE.test(name),
        });
        if (out.unchanged) { setError(''); return; }
        if (!out.ok) { setError(out.error); setNote(''); return; }
        setError('');
        setNote(out.note);
        onCommit(out.name);
    };

    return {
        box: (
            <input
                type="text"
                aria-label={ariaLabel}
                value={draft}
                onChange={(e) => { setDraft(sanitize ? sanitize(e.target.value) : e.target.value); setError(''); setNote(''); }}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                    if (e.key === 'Escape') { setDraft(name); setError(''); }
                }}
                placeholder={t('automations.field_designer.name', 'name')}
                className={rowInputClass('flex-1 min-w-0 font-mono')}
            />
        ),
        error,
        note,
    };
}

/**
 * One parameter row. Split out so the name box can keep its own draft state
 * per row — a hook cannot live inside the `.map()` of the list below.
 */
export function FieldRow({
    row, siblings, types, removeLabel, descriptionPlaceholder,
    sanitizeName, takenError, onRenameField, onPatch, onRemove, position,
}: FieldRowProps) {
    const { t } = useTranslation();
    const { box, error, note } = useRowNameBox({
        name: row.name || '',
        siblings,
        onRenameField,
        onCommit: (next) => onPatch({ name: next }),
        sanitize: sanitizeName,
        takenError,
        ariaLabel: `Field ${position} name`,
    });
    // A name that is already stored and already illegal — see nameProblem.
    // Suppressed while the box is complaining about the edit in progress, so
    // the author reads one answer rather than two.
    const stored = error ? null : nameProblem(row.name);

    return (
        <div className={cardClass()}>
            <div className="flex items-center gap-1">
                {box}
                <select
                    aria-label={`Field ${position} type`}
                    value={row.type || 'string'}
                    onChange={(e) => onPatch({ type: e.target.value })}
                    className={rowInputClass('px-1.5')}
                >
                    {types.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={removeLabel}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
                >
                    <Trash2 size={12} />
                </button>
            </div>
            {error ? <div className="text-[11px] text-red-500">{error}</div> : null}
            {!error && note ? <div className="text-[11px] text-[var(--text-secondary)]">{note}</div> : null}
            {stored ? <div className="text-[11px] text-amber-600">{stored}</div> : null}
            {descriptionPlaceholder ? (
                <input
                    type="text"
                    value={row.description || ''}
                    onChange={(e) => onPatch({ description: e.target.value })}
                    placeholder={descriptionPlaceholder}
                    className={rowInputClass('w-full')}
                />
            ) : null}
            <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
                <input type="checkbox" checked={!!row.required} onChange={(e) => onPatch({ required: e.target.checked })} /> {t('automations.field_designer.required', 'required')}
            </label>
        </div>
    );
}
