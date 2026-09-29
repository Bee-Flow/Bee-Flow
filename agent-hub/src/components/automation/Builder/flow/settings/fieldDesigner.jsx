// The one field designer — every DECLARED field is named here.
//
// A declared field has two identities. What the author reads (a form
// question, a row in a parameter list) may be reworded freely. The `name` is a
// BINDING — `trigger.output.<name>` — and moving it is never a local edit:
// every ref, template and expression downstream points at the old one.
//
// Every editor that grew its own name box grew the same bug with it. Commit
// `f9f81153` closed it for approval questions, whose box re-slugged the name
// on every keystroke in the label and had no callback to carry the rewrite;
// the three parameter-row editors in triggerEditors.jsx (flowlet inputs, agent
// tool parameters, Studio App trigger inputs) had exactly the same hole, one
// keystroke at a time — `set('params', …)` on every character typed, no
// validation, no rewrite, nothing said. An editor that lets a user rename a
// binding without carrying the rename is that bug waiting, so the rename path
// lives here, once, and every call site reaches it through this module:
//
//   1. THE NEW NAME MUST BE ONE THE SERVER ACCEPTS. A free-text box happily
//      mints `2nd_signature` or `_x`; the server's PARAM_NAME_RE then refuses
//      the save, naming a string the author never typed and has no box to
//      correct. Refused here instead, before it is stored.
//   2. IT MUST NOT COLLIDE WITH A SIBLING. normalizeFields keeps the FIRST of
//      a duplicate pair and drops the rest — silently — so a collision has to
//      be refused before the edit, not discovered after it.
//   3. WHERE THE HOST CAN REWRITE THE ROUTINE (`onRenameField`) the rename
//      carries every ref with it in the same edit, and the author is told how
//      many moved: "12 bindings were repointed" and "nothing pointed here yet"
//      must not look the same.
//   4. WHERE IT CANNOT, THE EDITOR SAYS SO. Staying quiet is how a later step
//      starts receiving nothing while the author is told the rename worked.
//
// The name is also only ever COMMITTED on purpose — Enter, blur, or the
// Rename button — never on the keystroke. Renaming per character is how the
// approval editor turned "Invoice number" into four different bindings on the
// way to "Invoice number (from the PO)".
import { Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { fieldNameTaken, isValidFieldName } from '../renameFormField';
import { cardClass, denseInputClass, rowInputClass } from './formPrimitives';

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
 * Shown standing, not on commit: an imported routine, an AI-authored
 * declaration or a row from before this box existed can hold a name the server
 * will refuse, and the author has to be able to see that without touching it
 * first. Two sentences, because "must start with a letter" is a lie about
 * `klant-naam`.
 */
export function nameProblem(name) {
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
 *   rewrite of the whole routine. Absent wherever the editor can see the
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
}) {
    const next = String(to ?? '').trim();
    if (next === from) return { ok: false, unchanged: true, name: from, error: '', note: '' };
    if (!isValidFieldName(next)) {
        return { ok: false, unchanged: false, name: from, error: 'Start with a letter; letters, digits and underscores only.', note: '' };
    }
    if (fieldNameTaken(siblings, next, from)) {
        return { ok: false, unchanged: false, name: from, error: takenError, note: '' };
    }
    // The host rewrites the whole routine from ITS copy of the definition,
    // which still holds the old name — so that call goes FIRST. The caller
    // then renames its own declaration, because the panel's draft is what the
    // node's autosave writes back; without it the save would put the old name
    // straight back over the rename a moment later.
    const moved = typeof onRenameField === 'function' ? onRenameField(from, next) : undefined;
    return { ok: true, unchanged: false, name: next, error: '', note: renameNote(moved, from, orphanNote) };
}

/** How the rename is reported back. Separate so both widgets word it the same. */
function renameNote(moved, from, orphanNote) {
    if (typeof moved === 'number') {
        // The plural half is the wording the form builder has always shown and
        // its test pins; only the singular is corrected here, where "1 binding
        // … now point at it" read as a typo in the one case an author is most
        // likely to hit.
        return moved > 0
            ? `Renamed — ${moved} ${moved === 1 ? 'binding' : 'bindings'} in this routine now ${moved === 1 ? 'points' : 'point'} at it.`
            : 'Renamed. Nothing was pointing at it yet.';
    }
    // No rewrite behind the box. Said out loud rather than left to be found at
    // run time by a step that quietly receives nothing.
    return orphanNote ? `Renamed here only — steps that bind “${from}” still point at the old name.` : '';
}

/**
 * The binding name as the form builder shows it: a labelled block inside a
 * question's Advanced fold, with the base spelled out in front of the box.
 *
 * It used to be frozen, and the panel said so: re-deriving it from the label
 * would have broken every downstream step silently. Frozen was the safe answer
 * rather than a good one, though — an author who renamed "Jouw naam" to
 * "Contactpersoon" was stuck binding `jouw_naam` for the life of the routine.
 *
 * Without `onRenameField` there is no definition to rewrite — the standalone
 * Forms editor in Studio edits a form, not a routine — so the name stays
 * read-only there and says why, rather than offering an edit that would break
 * bindings it cannot see.
 */
export function BindingNameField({ field, siblings, bindingBase, onRenameField, onChange }) {
    const [draft, setDraft] = useState(field.name);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    // Adopt an outside change (undo, the AI builder, a reordered card reusing
    // this index) without fighting the author mid-keystroke.
    const [seen, setSeen] = useState(field.name);
    if (seen !== field.name) { setSeen(field.name); setDraft(field.name); setError(''); }

    const dirty = draft !== field.name;

    const apply = () => {
        const out = applyBindingRename({ from: field.name, to: draft, siblings, onRenameField });
        if (out.unchanged) return;
        if (!out.ok) { setError(out.error); return; }
        setError('');
        onChange({ name: out.name });
        setNote(out.note);
    };

    if (typeof onRenameField !== 'function') {
        return (
            <div className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">Binding name</div>
                <code className="block min-w-0 truncate text-[11px] text-[var(--text-secondary)]">{bindingBase}.{field.name}</code>
                <p className="text-[10px] text-[var(--text-tertiary)]">
                    Fixed here. Rename it from the routine that uses this form — there the rename can carry
                    every step that binds it along with it.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">Binding name</div>
            <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">{bindingBase}.</span>
                <input
                    type="text"
                    aria-label={`Binding name for ${field.label || field.name}`}
                    value={draft}
                    onChange={(e) => { setDraft(e.target.value); setError(''); setNote(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') setDraft(field.name); }}
                    className={denseInputClass('flex-1 min-w-0')}
                />
                <button
                    type="button"
                    onClick={apply}
                    disabled={!dirty}
                    className="shrink-0 px-2 py-1 rounded text-[11px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
                >
                    Rename
                </button>
            </div>
            {error ? <p className="text-[10px] text-red-500">{error}</p> : null}
            {!error && note ? <p className="text-[10px] text-[var(--text-secondary)]">{note}</p> : null}
            {!error && !note ? (
                <p className="text-[10px] text-[var(--text-tertiary)]">
                    Renaming rewrites every step that binds this answer, in the same edit. Changing the
                    QUESTION above never touches it.
                </p>
            ) : null}
        </div>
    );
}

/**
 * The binding name as a parameter row shows it: inline, first in the row,
 * because here the name IS the field — a parameter has no label to read
 * instead.
 *
 * Same commit discipline as the block above. The box holds its own draft while
 * the author types and writes on Enter or blur, so `email` on the way to
 * `email_address` is never stored, never saved, and never rewrites a routine
 * eight times.
 */
function useRowNameBox({ name, siblings, onRenameField, onCommit, sanitize, takenError, ariaLabel }) {
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
                placeholder="name"
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
function FieldRow({
    row, siblings, types, removeLabel, descriptionPlaceholder,
    sanitizeName, takenError, onRenameField, onPatch, onRemove, position,
}) {
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
                <input type="checkbox" checked={!!row.required} onChange={(e) => onPatch({ required: e.target.checked })} /> required
            </label>
        </div>
    );
}

/**
 * The shared parameter-row designer: a list of declared fields, each with a
 * binding name, a type, an optional description and whether it is required.
 *
 * It replaced three hand-written copies of this list (LayerInputFields,
 * AgentCallFields, AppTriggerFields). What they legitimately differ in is
 * vocabulary and the type set, so that is what the props carry; the name — the
 * half that was quietly broken in all three — is the same everywhere.
 *
 * @param {Array}    rows      the declared fields, straight off the draft
 * @param {Function} onChange  (nextRows) => void
 * @param {Array}    types     [{ value, label }], in the order the select shows them
 * @param {string}   namePrefix  what a freshly added row is called (`input`, `arg`)
 * @param {Function} sanitizeName  optional per-keystroke filter on the name box
 * @param {string}   descriptionPlaceholder  null where the call site has no description
 * @param {Function} onRenameField  (from, to) => number|undefined, from the host
 */
export default function FieldDesigner({
    rows,
    onChange,
    types,
    addLabel,
    removeLabel,
    emptyNote,
    namePrefix = 'input',
    descriptionPlaceholder = null,
    sanitizeName = null,
    onRenameField = null,
    takenError = 'Another field here already binds that name.',
    defaults = null,
}) {
    const list = Array.isArray(rows) ? rows : [];
    // Writes go through the LATEST list, not the one this render closed over.
    // The name box commits on blur, and the blur that commits it is usually
    // the click on "Add" or the bin — so the handler that runs next would
    // otherwise rebuild the array from a copy that predates the rename and
    // throw it away again. Same ref-in-an-effect idiom SettingsForm uses to
    // keep `flushNow` reading the draft it is about to send.
    const listRef = useRef(list);
    useEffect(() => { listRef.current = list; });
    const write = (fn) => onChange(fn(listRef.current));

    const patchRow = (i, changes) => write(cur => cur.map((r, j) => (j === i ? { ...r, ...changes } : r)));
    const removeRow = (i) => write(cur => cur.filter((_, j) => j !== i));
    const addRow = () => write(cur => {
        // Count up rather than off the length: add three, remove the middle,
        // add again and a length-based name would mint a duplicate — which
        // the server drops silently, taking the row with it.
        let n = cur.length + 1;
        while (cur.some(r => r?.name === `${namePrefix}${n}`)) n += 1;
        return [...cur, { name: `${namePrefix}${n}`, type: 'string', required: false, ...(defaults || {}) }];
    });

    return (
        <div className="space-y-2">
            {list.length === 0 && <div className="text-[11px] text-[var(--text-tertiary)] italic">{emptyNote}</div>}
            {list.map((row, i) => (
                <FieldRow
                    key={i}
                    row={row || {}}
                    position={i + 1}
                    siblings={list}
                    types={types}
                    removeLabel={removeLabel}
                    descriptionPlaceholder={descriptionPlaceholder}
                    sanitizeName={sanitizeName}
                    takenError={takenError}
                    onRenameField={onRenameField}
                    onPatch={(changes) => patchRow(i, changes)}
                    onRemove={() => removeRow(i)}
                />
            ))}
            <button type="button" onClick={addRow} className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                <Plus size={12} /> {addLabel}
            </button>
        </div>
    );
}
