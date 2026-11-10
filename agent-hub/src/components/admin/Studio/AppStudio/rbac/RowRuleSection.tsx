import { AlertTriangle } from 'lucide-react';
import { SetStateAction, Dispatch, useMemo, useRef } from 'react';
import RowRuleBuilder from './RowRuleBuilder';
import { compareSourceLabel, parseRowRule, ruleFields } from './rowRuleModel';
import { EVERY_ROW, draftToRule, seedDraft } from './rowRuleSet';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { insertAtCursor } from '@/utils/bindingHelpers';
import type { DataModelTable } from './useAppRoles';
import type { RuleDraft, RawRuleBoxProps } from './RowRuleEditor.types';

/**
 * The rule half of RowRuleEditor: one rule, authored with the pickers
 * (RowRuleBuilder) or typed in the raw box. With a rule per action the editor
 * mounts this once, on the draft of the action that is on screen.
 */

// viewer.orgId, not viewer.organizationId: the latter is not the same value on every path.
const VIEWER_CHIPS = ['viewer.id', 'viewer.email', 'viewer.orgId', 'viewer.role'];
// A list of the person is not one value: its chip inserts the whole test.
const MEMBERSHIP_CHIP = 'in viewer.groups';

interface RowRuleSectionProps {
    t: TranslateFn;
    draft: RuleDraft;
    setDraft: Dispatch<SetStateAction<RuleDraft>>;
    noAccess: boolean;
    table: DataModelTable | null;
    validation: { ok: boolean; error: string | null | undefined; warning?: string };
    /** Changing or deleting with a rule per action: without a rule it follows the rule for seeing. */
    followsRead?: boolean;
}

/** One rule on screen: the pickers or the raw box, the switch between them, and what there is to say about it. */
export default function RowRuleSection({ t, draft, setDraft, noAccess, table, validation, followsRead = false }: RowRuleSectionProps) {
    const rule = draftToRule(draft);
    const everyRow = followsRead && rule.trim() === EVERY_ROW;
    const canSwitchToBuilder = useMemo(
        () => draft.mode === 'raw' && parseRowRule(draft.raw, table).ok,
        [draft.mode, draft.raw, table],
    );
    return <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
                {t('studio_apps_edit.rule_editor.then_keep', 'Then keep only the rows where…')}{' '}
                <span className="text-[var(--text-tertiary)]">{t('studio_apps_edit.rule_editor.optional', '(optional)')}</span>
            </span>
            {draft.mode === 'build' ? (
                <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, mode: 'raw', raw: draftToRule(prev) }))}
                    disabled={noAccess}
                    className="text-[11px] hover:underline disabled:opacity-50 text-[var(--accent-primary)]"
                >
                    {t('studio_apps_edit.rule_editor.write_myself', 'Write it myself')}
                </button>
            ) : (
                <button
                    type="button"
                    onClick={() => setDraft(seedDraft(draft.raw, table))}
                    disabled={noAccess || !canSwitchToBuilder}
                    className="text-[11px] hover:underline disabled:opacity-50 text-[var(--accent-primary)]"
                >
                    {t('studio_apps_edit.rule_editor.back_to_picker', 'Back to the picker')}
                </button>
            )}
        </div>

        {draft.mode === 'build' ? (
            <RowRuleBuilder
                table={table}
                join={draft.join}
                conditions={draft.conditions}
                disabled={noAccess}
                onEveryRow={followsRead ? () => setDraft({ mode: 'raw', join: 'and', conditions: [], raw: EVERY_ROW }) : undefined}
                onChange={(next) => setDraft((prev) => ({ ...prev, ...next }))} />
        ) : (
            <>
                {draft.raw.trim() && !canSwitchToBuilder && !everyRow ? (
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {t('studio_apps_edit.rule_editor.stays_text', 'This rule does more than the picker can show, so it stays as text — it is saved exactly as written.')}
                    </span>
                ) : null}
                <RawRuleBox
                    table={table}
                    value={draft.raw}
                    disabled={noAccess}
                    error={rule.trim() && !validation.ok ? validation.error : null}
                    onChange={(raw) => setDraft((prev) => ({ ...prev, raw }))} />
            </>
        )}
        {followsRead && !rule.trim() ? (
            <span data-testid="row-rule-follows-read" className="text-[11px] text-[var(--text-tertiary)]">
                {t('studio_apps_rowrules.follows_read', 'No rule of its own: this action follows the rule for seeing.')}
            </span>
        ) : null}
        {everyRow ? (
            <span data-testid="row-rule-every-row" className="text-[11px] text-[var(--text-tertiary)]">
                {t('studio_apps_rowrules.every_row_set', 'Written as true: no row rule narrows this action. Empty it to follow the rule for seeing again.')}
            </span>
        ) : null}
        {rule.includes('viewer.groups') ? (
            <span className="text-[11px] text-[var(--text-tertiary)]">
                {t('studio_apps_rowrules.groups_hint', 'Groups are compared by their id, so the column has to hold a group id.')}
            </span>
        ) : null}
        {validation.ok && validation.warning ? (
            <span data-testid="row-rule-advice" className="text-[11px] text-amber-600 dark:text-amber-400">{validation.warning}</span>
        ) : null}
    </div>;
}

function RawRuleBox({ table, value, onChange, disabled, error }: RawRuleBoxProps) {
    const { t } = useTranslation();
    const ref = useRef<HTMLTextAreaElement>(null);
    const insert = (text: string) => {
        const result = insertAtCursor(ref.current, text);
        onChange(result != null ? result : (value ? `${value} ${text}` : text));
    };

    return (
        <div className="flex flex-col gap-1.5">
            <textarea
                ref={ref}
                rows={2}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                placeholder={t('studio_apps_edit.rule_editor.raw_example', 'e.g. record.owner_id == viewer.id')}
                spellCheck={false}
                aria-label={t('studio_apps_edit.rule_editor.raw_aria', 'Row rule expression')}
                className="w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 disabled:opacity-50 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
            />
            <div className="flex flex-wrap items-center gap-1.5">
                {ruleFields(table, t).slice(0, 8).map((f) => (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => insert(`record.${f.key}`)}
                        disabled={disabled}
                        title={f.name}
                        className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    >
                        record.{f.key}
                    </button>
                ))}
                {VIEWER_CHIPS.map((path) => (
                    <button
                        key={path}
                        type="button"
                        onClick={() => insert(path)}
                        disabled={disabled}
                        title={compareSourceLabel(path, t)}
                        className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    >
                        {path}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => insert(MEMBERSHIP_CHIP)}
                    disabled={disabled}
                    title={compareSourceLabel('viewer.groups', t)}
                    className="rounded-md border px-2 py-0.5 text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]"
                >
                    {MEMBERSHIP_CHIP}
                </button>
            </div>
            {error ? (
                <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-500 dark:text-rose-400" data-rule-error="true">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                </div>
            ) : null}
        </div>
    );
}
