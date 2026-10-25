import { stepMeta } from '../stepCatalog';
import { type RefOption, type ReferenceKind } from '../stepReferences';
import useStepReferences from '../useStepReferences';
import DocumentFillFields from '../DocumentFillFields';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useCatalogStepSpecs } from '../../inspector/panels/SpecPanel';
import type { AppAction, AppDefinition, AppNode, AppScreen, FormFieldRef } from '../../inspector/appDefinition';
import type { StepSettingsProps, FieldSpec, StepReferences } from '../StepSettings.types';
import { CANVAS_TYPES, AI_AUTHORED_TYPES, IGNORED_FIELDS } from './StepSettings.constants';
import { StepField } from './StepField';

/**
 * One step's settings, rendered FROM THE SPEC rather than hand-written per kind.
 *
 * There are eighteen step kinds. A bespoke editor each is eighteen places for a
 * field to go missing — which is how the inspector ended up able to author four
 * of the ten action kinds. The server already describes every field and its
 * type, so this walks that description and maps type → control. A field the
 * server adds gets an editor for free; a field it drops stops rendering.
 *
 * The types the canvas owns rather than this panel — `steps` and `switchCases`,
 * a container's children — are skipped here: they are the branches drawn on the
 * canvas, and editing them in a side panel would be a second, disagreeing way
 * to say the same thing.
 *
 * ── REFERENCES ARE PICKED, NEVER TYPED ──────────────────────────────
 * The server types every reference field as a plain `string`, because an id is
 * what goes over the wire. `screenId` was special-cased into a <select> for
 * exactly that reason ("A screen reference is a pick, never a typed id") — and
 * the other five were left as text boxes. So "Add a row" asked a bookkeeper to
 * type `tbl_9f3a2c`, "Open a dialog" wanted a node id, and "Run automation" wanted
 * a uuid. They are all pickers now, driven by one table (stepReferences.
 * REFERENCE_FIELDS) so a new reference field cannot land as a text box again.
 *
 * A reference whose target has been DELETED still shows its raw id, with a
 * warning — blanking it would hide the breakage from the only person who can
 * repair it.
 */

export default function StepSettings({ step, onChange, definition, node = null, screens = [], disabled = false, formFields = [] }: StepSettingsProps) {
    const { t } = useTranslation();
    const stepSpecs = useCatalogStepSpecs();
    const references = useStepReferences(definition);
    if (!step) return null;
    const meta = stepMeta(step.kind, t);
    const spec = stepSpecs ? stepSpecs[step.kind] : null;
    const set = (patch: Partial<AppAction>) => onChange({ ...step, ...patch });

    if (!stepSpecs) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_edit.step_settings.loading', 'Loading the step settings…')}</p>;
    }
    if (!spec) {
        return (
            <p className="text-xs text-[var(--text-secondary)]">
                {t('studio_apps_edit.step_settings.no_editor', 'This step type has no editor yet — it was written by the AI builder.')}
            </p>
        );
    }

    const fields = Object.entries(spec.fields as Record<string, FieldSpec>)
        .filter(([key, fs]) => !CANVAS_TYPES.has(fs.type) && !AI_AUTHORED_TYPES.has(fs.type)
            && !IGNORED_FIELDS.has(`${step.kind}.${key}`)
            && !(step.kind === 'fill_document' && ['documentId','documentVersionId','values','sectionOverrides'].includes(key)));

    // The caller's screen list wins when it has one; it is the same
    // definition.screens either way, and passing it keeps the two existing call
    // sites working unchanged.
    const options = screens.length
        ? { ...references.options, screen: screens.filter((s): s is AppScreen & { id: string } => !!s?.id).map((s) => ({ id: s.id, label: s.name || s.id })) }
        : references.options;

    return (
        <div className="flex flex-col gap-3" data-step-settings={step.kind}>
            <p className="text-xs text-[var(--text-secondary)]">{meta.blurb}</p>
            {step.kind === 'fill_document' && <DocumentFillFields step={step} onChange={set} definition={definition} node={node} formFields={formFields} disabled={disabled}/>}

            {fields.map(([key, fs]) => (
                <StepField
                    key={key}
                    fieldKey={key}
                    fs={fs}
                    value={step[key]}
                    step={step}
                    onChange={(v) => set({ [key]: v })}
                    definition={definition}
                    node={node}
                    options={options}
                    references={references}
                    formFields={formFields}
                    disabled={disabled}
                />
            ))}

            {meta.server ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('studio_apps_edit.step_settings.runs_on_server', 'Runs on the server, as the app’s owner — so it can reach data the person using the app cannot.')}
                </p>
            ) : null}
        </div>
    );
}

