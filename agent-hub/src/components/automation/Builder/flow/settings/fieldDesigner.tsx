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
//   3. WHERE THE HOST CAN REWRITE THE AUTOMATION (`onRenameField`) the rename
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
import { Plus } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { denseInputClass } from './formPrimitives';
import { useTranslation } from '../../../../../hooks/useTranslation';
import type { BindingNameFieldProps, DesignedField, FieldDesignerProps } from './fieldDesigner.types';
import { applyBindingRename, FieldRow } from './FieldRow';
;

/**
 * The binding name as the form builder shows it: a labelled block inside a
 * question's Advanced fold, with the base spelled out in front of the box.
 *
 * It used to be frozen, and the panel said so: re-deriving it from the label
 * would have broken every downstream step silently. Frozen was the safe answer
 * rather than a good one, though — an author who renamed "Jouw naam" to
 * "Contactpersoon" was stuck binding `jouw_naam` for the life of the automation.
 *
 * Without `onRenameField` there is no definition to rewrite — the standalone
 * Forms editor in Studio edits a form, not an automation — so the name stays
 * read-only there and says why, rather than offering an edit that would break
 * bindings it cannot see.
 */
export function BindingNameField({ field, siblings, bindingBase, onRenameField, onChange }: BindingNameFieldProps) {
    const { t } = useTranslation();
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
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.field_designer.binding_name', 'Binding name')}</div>
                <code className="block min-w-0 truncate text-[11px] text-[var(--text-secondary)]">{bindingBase}.{field.name}</code>
                <p className="text-[10px] text-[var(--text-tertiary)]">
                    {t('automations.field_designer.fixed_here_rename_it_from_the', 'Fixed here. Rename it from the automation that uses this form — there the rename can carry every step that binds it along with it.')}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.field_designer.binding_name', 'Binding name')}</div>
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
                    {t('automations.field_designer.rename', 'Rename')}
                </button>
            </div>
            {error ? <p className="text-[10px] text-red-500">{error}</p> : null}
            {!error && note ? <p className="text-[10px] text-[var(--text-secondary)]">{note}</p> : null}
            {!error && !note ? (
                <p className="text-[10px] text-[var(--text-tertiary)]">
                    {t('automations.field_designer.renaming_rewrites_every_step_that_binds', 'Renaming rewrites every step that binds this answer, in the same edit. Changing the QUESTION above never touches it.')}
                </p>
            ) : null}
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
}: FieldDesignerProps) {
    const list = Array.isArray(rows) ? rows : [];
    // Writes go through the LATEST list, not the one this render closed over.
    // The name box commits on blur, and the blur that commits it is usually
    // the click on "Add" or the bin — so the handler that runs next would
    // otherwise rebuild the array from a copy that predates the rename and
    // throw it away again. Same ref-in-an-effect idiom SettingsForm uses to
    // keep `flushNow` reading the draft it is about to send.
    const listRef = useRef(list);
    useEffect(() => { listRef.current = list; });
    const write = (fn: (cur: Array<DesignedField | null>) => Array<DesignedField | null>) => onChange(fn(listRef.current));

    const patchRow = (i: number, changes: Partial<DesignedField>) => write(cur => cur.map((r, j) => (j === i ? { ...r, ...changes } : r)));
    const removeRow = (i: number) => write(cur => cur.filter((_, j) => j !== i));
    const addRow = () => write(cur => {
        // Count up rather than off the length: add three, remove the middle, add again and a
        // length-based name would mint a duplicate — which the server drops silently, with the row.
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
