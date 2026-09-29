import React, { useMemo } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import * as aiStepEditors from '../../../automation/Builder/flow/settings/aiStepEditors';
import { fieldsToSchema, schemaToFields } from '../../../automation/Builder/flow/settings/formState';
import FieldKindIcon from '../../../automation/Builder/mapping/FieldKindIcon';
import { KIND_WORD, expectedKindFor } from '../../../automation/Builder/mapping/fieldKinds';

/**
 * "Delivers" — the fields a skill hands back (`skills.output_schema`).
 *
 * ── A DEVIATION THAT 3a/3b DEPEND ON ────────────────────────────────
 * Skills.dc.html does not draw this card. The Bee Flow Builder artboards do
 * (3a line 52/66: "the fields come from the skill"): an AI step that
 * applies a skill takes its outgoing fields FROM the skill, so those fields
 * have to be editable somewhere, and the skill is the only place they can
 * live. Recorded as a deliberate deviation in the plan.
 *
 * ── ONE ROW EDITOR, NOT TWO ─────────────────────────────────────────
 * The rows ARE the AI step's `StructuredOutputFields`
 * (Builder/flow/settings/aiStepEditors.jsx), imported rather than copied:
 * S1 gave `output_schema` the SAME shape as `ai_step.outputSchema` precisely
 * so R2 can hand a skill's schema straight to a step, and two editors for
 * one shape is how the two shapes drift apart. The bridge in both
 * directions is the builder's own `schemaToFields` / `fieldsToSchema`, so a
 * `format: 'date-time'`, a typed array's columns and an opaque nested
 * object all survive the round trip (they were lost by a hand-rolled
 * mapping once already — formState.js's C13 comment).
 *
 * ── AND ONE LINE THE STEP EDITOR DOES NOT HAVE ──────────────────────
 * Above the rows, each field is READ BACK in the product's field-kind
 * vocabulary — `FieldKindIcon` + the plain word (`text`, `number`,
 * `one of a list`, `date`, `table`) + the name — because the word this card
 * must agree with is the one an automation shows when it binds the field
 * (`mapping/fieldKinds.expectedKindFor`), not "string".
 *
 * That is also why the block CARRIES A CAPTION. Borrowing the row editor
 * borrows its vocabulary too: its type select says `string / number / boolean
 * / datetime / object / array` (the JSON types, in English, untranslated),
 * directly under a summary line that says `text / number / yes-no / date / one
 * of a list / table` for the SAME field. Stacked with nothing between them
 * that is a contradiction; with the caption they are two different statements —
 * what an automation will see, and the raw shape being edited. The real fix is
 * one vocabulary in the shared editor, which is R2's file, and it is reported
 * there together with the five English strings that editor brings in with it.
 *
 * `null` is a real answer: no fields means "this skill yields no fields",
 * and R2 then keeps the step's own schema. An empty properties object would
 * mean "an object with no keys", which is not the same claim — so an empty
 * row list saves as `null` (`fieldsToSchema` already returns null).
 *
 * ── WHY THE IMPORT IS A NAMESPACE AND NOT A NAMED ONE ───────────────
 * `StructuredOutputFields` is currently a module-private function in
 * aiStepEditors.jsx; exporting it is a one-word change that belongs to that
 * file's owner (it is in this track's sharedEdits). A bare named import of
 * an export that has not landed yet resolves to `undefined`, and React
 * turns that into "Element type is invalid" — a WHITE SCREEN on the Method
 * tab, the main tab of the section. A namespace import plus this guard
 * degrades to one honest line instead, and starts rendering the rows the
 * moment the export exists, with no further change here.
 */
const RowEditor = aiStepEditors.StructuredOutputFields || null;

export default function OutputFieldsCard({ outputSchema, onChange, readOnly = false }) {
    const { t } = useTranslation();
    const fields = useMemo(() => schemaToFields(outputSchema), [outputSchema]);
    const props = (outputSchema && typeof outputSchema === 'object' && outputSchema.properties) || {};

    return (
        <section className="flex flex-col gap-2" data-testid="skill-output">
            <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('skills_studio.output.title', 'Delivers')}
                </h2>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('skills_studio.output.hint', 'fields an automation can use')}
                </span>
            </div>

            {fields.length > 0 && (
                <p className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] m-0">
                    {t('skills_studio.output.as_automation_sees', 'How an automation will see these')}
                </p>
            )}

            {fields.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)] italic m-0" data-testid="skill-output-empty">
                    {t('skills_studio.output.empty', 'No fields — this skill answers in its own words.')}
                </p>
            ) : (
                <ul className="list-none p-0 m-0 flex flex-col gap-1" data-testid="skill-output-summary">
                    {fields.map((field) => {
                        const kind = expectedKindFor(props[field.key]) || 'unknown';
                        const unit = props[field.key]?.['x-unit'] || '';
                        return (
                            <li key={field.key} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                                <FieldKindIcon kind={kind} size={13} />
                                <span className="text-[var(--text-tertiary)]">
                                    {t(KIND_WORD[kind]?.key || 'routines.kind.unknown', KIND_WORD[kind]?.en || 'not seen yet')}
                                </span>
                                <span className="text-[var(--text-primary)] font-medium truncate">{field.key}</span>
                                {unit && <span className="text-[var(--text-tertiary)]">· {unit}</span>}
                            </li>
                        );
                    })}
                </ul>
            )}

            {!readOnly && (RowEditor ? (
                <RowEditor
                    fields={fields}
                    onChange={(next) => onChange(fieldsToSchema(next))}
                />
            ) : (
                <p className="text-xs m-0" style={{ color: 'var(--warning-ink)' }} data-testid="skill-output-unavailable">
                    {t('skills_studio.output.unavailable', 'These fields can only be edited from an AI step for now.')}
                </p>
            ))}
        </section>
    );
}
