import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { KbMultiSelect } from '@/components/admin/Studio/AppStudio/inspector/AiGenerateEditor';
import { INPUT_CLS } from '@/components/admin/Studio/AppStudio/inspector/panels/kit';
import { useApprovalDirectory } from '@/components/automation/Builder/flow/settings/approvalState';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/** canonicalize/aiFields.cleanStringList: strings only, at most 50. */
const MAX_ITEMS = 50;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/**
 * `stringList`: a list of ids or names. One type, three meanings, told apart by the field:
 *
 *   knowledgeBaseIds                  the knowledge bases an AI step is grounded in: the bare AI
 *                                     action's picker (KbMultiSelect), by name
 *   approverUserIds / approverGroupIds a request_approval panel: people or groups from the
 *                                     organisation directory the automation approval editor uses
 *   anything else (allowedDomains)    one entry per line
 *
 * An id the list no longer knows stays checked and named by its id, never silently dropped.
 */
function StringListControl(props: StepFieldControlProps) {
    if (props.fieldKey === 'knowledgeBaseIds') return <KnowledgeBases {...props} />;
    if (props.fieldKey === 'approverUserIds' || props.fieldKey === 'approverGroupIds') return <DirectoryList {...props} />;
    return <LinesList {...props} />;
}

function KnowledgeBases({ value, onChange, disabled, required }: StepFieldControlProps) {
    const { t } = useTranslation();
    return (
        <div data-step-control="stringList.kb">
            <KbMultiSelect value={asList(value)} onChange={(ids) => onChange(ids.slice(0, MAX_ITEMS))} disabled={disabled} />
            {required && asList(value).length === 0 ? (
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('studio_apps_step_fields.kb.required', 'Pick at least one knowledge base to search.')}</p>
            ) : null}
        </div>
    );
}

function DirectoryList({ fieldKey, label, hint, value, onChange, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const directory = useApprovalDirectory();
    const groups = fieldKey === 'approverGroupIds';
    const entries = (groups ? directory?.groups : directory?.members) || [];
    const picked = asList(value);
    const known = new Set(entries.map((e) => e.id));
    const rows = [...entries, ...picked.filter((id) => !known.has(id)).map((id) => ({ id, name: t('studio_apps_step_fields.directory.unknown', '{id} (not in the directory)', { id }) }))];
    const toggle = (id: string, on: boolean) => {
        const next = on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id);
        onChange(next.length ? next.slice(0, MAX_ITEMS) : undefined);
    };
    return (
        <FormField label={label} hint={hint || t('studio_apps_step_fields.directory.panel_hint', 'A panel decides together, by the rule below. Used instead of a single approver.')}>
            {directory === null ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_step_fields.directory.loading', 'Loading the people and groups…')}</p>
            ) : rows.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_step_fields.directory.empty', 'Nobody to pick: the directory is empty, or approvals are not part of this plan.')}</p>
            ) : (
                <div className="flex max-h-40 flex-col gap-1.5 overflow-auto" data-step-control="stringList.directory">
                    {rows.map((row) => (
                        <label key={row.id} className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
                            <input type="checkbox" checked={picked.includes(row.id)} onChange={(e) => toggle(row.id, e.target.checked)} disabled={disabled} />
                            <span className="truncate">{row.name || row.id}</span>
                        </label>
                    ))}
                </div>
            )}
        </FormField>
    );
}

/**
 * One entry per line. The box keeps its own text: the stored list has no blank entries, so
 * deriving the text from it would swallow the newline the moment it is typed.
 */
function LinesList({ label, hint, value, onChange, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const stored = asList(value);
    const [text, setText] = useState(stored.join('\n'));
    const parse = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, MAX_ITEMS);
    if (parse(text).join('\n') !== stored.join('\n')) setText(stored.join('\n'));
    return (
        <FormField label={label} hint={hint || t('studio_apps_step_fields.lines.hint', 'One per line.')}>
            <textarea
                className={`${INPUT_CLS} min-h-[64px] font-mono text-xs`}
                rows={3}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    const next = parse(e.target.value);
                    onChange(next.length ? next : undefined);
                }}
                disabled={disabled}
                spellCheck={false}
                aria-label={label}
            />
        </FormField>
    );
}

const entry: StepFieldTypeModule = { type: 'stringList', Control: StringListControl };
export default entry;
