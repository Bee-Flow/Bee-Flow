import { type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import { useEditorChrome } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import FormulaField from '../../logic/FormulaField';
import FormField from '@/components/shared/FormField';
import type { PickSpec } from '@/components/admin/Studio/AppStudio/runtime/resolveBinding.types';
import type { DatasetAggregate, DatasetGroup } from '@/components/admin/Studio/AppStudio/bi/useDatasets';
import type { ConnectorParamDecl } from '@/components/admin/Studio/AppStudio/bi/useConnectors';
import type { AppDefinition, AppNode, FormFieldRef } from '../../appDefinition';
import type { BindingDraft, SourceCardProps, SourceChooserProps, BindingFieldProps } from '../BindingField.types';
import { sourceChoices, moreSourceChoices, modeOf, isUnset, skeletonFor, staticDisplay, parseStatic } from './BindingField.helpers';
import { AggregateBinding } from './AggregateBinding';
import { TableBinding } from './TableBinding';
import { ConnectorBinding } from './ConnectorBinding';
import { DatasetBinding } from './DatasetBinding';
import { SourceSummary } from './SourceSummary';
export { datasetColumns } from './DatasetBinding';

/**
 * BindingField — editor for a `binding` prop value (server contract in
 * server/appStudio/componentSpecs.js, authoritative). All six binding kinds:
 *
 *   { kind: 'static', value }                              — a literal
 *   { kind: 'formula', expr }                              — a derived value
 *   { kind: 'record',  tableId, filter?, sort?, limit? }   — first matching row
 *   { kind: 'records', tableId, filter?, sort?, limit? }   — matching rows
 *   { kind: 'dataset', datasetId, pick? }                  — a saved query
 *   { kind: 'connector', connectorId, params? }            — external source
 *   { kind: 'actionResult', actionId, path }               — an automation result
 *
 * Nothing chosen yet (no binding, or the untouched `[]`/empty literal the
 * catalog defaults to) opens on the CHOOSER — one card per everyday way to
 * give a component data — instead of a hand-typed literal. Once a source is
 * set the field states it as a sentence with a Change link, and the picker for
 * that kind sits underneath. Typing the values by hand is the fourth card, and
 * formula/connector are one click deeper behind "Something else" — every kind
 * stays reachable.
 *
 * record/records/dataset/connector need the app's data model, so the pickers
 * load from the editor-chrome appId; outside the editor shell (per-type
 * inspector smoke tests) those modes degrade to a friendly "open the app" note.
 * filter values may be a literal or {kind:'formula',expr} (resolved client-side
 * before fetch — see runtime/resolveBinding.resolveBindingFilters); a connector
 * param is likewise a literal or {kind:'formula',expr} (resolveBindingParams).
 */

// ── the chooser ──────────────────────────────────────────────────────────────

function SourceCard({ choice, onPick, disabled }: SourceCardProps) {
    const Icon = choice.icon;
    return (
        <button
            type="button"
            onClick={() => onPick(choice.kind)}
            disabled={disabled}
            className="flex items-start gap-2.5 text-left px-3 py-2.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] hover:border-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
            <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--text-primary)]">{choice.title}</span>
                <span className="block text-xs text-[var(--text-secondary)]">{choice.blurb}</span>
            </span>
        </button>
    );
}

function SourceChooser({ onPick, onCancel, disabled }: SourceChooserProps) {
    const { t } = useTranslation();
    const [showMore, setShowMore] = useState(false);
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-secondary)]">
                {onCancel ? t('studio_apps_panels.binding.where_from', 'Where should this come from?') : t('studio_apps_panels.binding.no_data_yet', 'No data yet — choose where this comes from.')}
            </p>
            <div className="flex flex-col gap-1.5">
                {sourceChoices(t).map((c) => <SourceCard key={c.kind} choice={c} onPick={onPick} disabled={disabled} />)}
                {showMore ? moreSourceChoices(t).map((c) => <SourceCard key={c.kind} choice={c} onPick={onPick} disabled={disabled} />) : null}
            </div>
            <div className="flex items-center gap-3">
                {!showMore ? (
                    <button type="button" onClick={() => setShowMore(true)} className="text-xs text-[var(--text-secondary)] hover:underline">
                        {t('studio_apps_panels.binding.something_else', 'Something else…')}
                    </button>
                ) : null}
                {onCancel ? (
                    <button type="button" onClick={onCancel} className="text-xs text-[var(--text-secondary)] hover:underline">
                        {t('studio_apps_panels.binding.keep_existing', 'Keep what’s there')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

// ── the "this is what it shows" sentence ─────────────────────────────────────

// ── record/records editor ────────────────────────────────────────────────────

// ── dataset editor ───────────────────────────────────────────────────────────

// ── connector editor ─────────────────────────────────────────────────────────

export default function BindingField({
    label,
    value,
    onChange,
    definition,
    node = null,
    componentType = 'chart',
    hint,
    placeholder = null,
    singleValue = false,
    onBuild = null,
    disabled = false,
}: BindingFieldProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const appId = chrome?.appId ?? null;
    const [choosing, setChoosing] = useState(false);
    // "Type the values myself" commits an EMPTY literal, which still reads as
    // unset — without this the chooser would reopen over its own answer.
    const [chosen, setChosen] = useState(false);

    // ONE inspector panel instance serves every node of a type, so selecting
    // another table/chart/tile does NOT remount this field. A value that this
    // field did not emit therefore belongs to a different component, and both
    // latches above have to fall back to what that component's binding says.
    // `mine` is compared by identity on purpose: a commit the editor collapses
    // as a no-op leaves `value` untouched, which must not read as a switch.
    const [seen, setSeen] = useState<unknown>(value);
    const [mine, setMine] = useState<unknown>(null);
    if (value !== seen) {
        setSeen(value);
        if (value !== mine) { setChoosing(false); setChosen(false); }
    }
    const emit = (next: BindingDraft) => { setMine(next); onChange(next); };

    const binding: BindingDraft = value && typeof value === 'object' && (value as { kind?: unknown }).kind
        ? value as BindingDraft
        : { kind: 'static', value: value ?? null };
    const mode = modeOf(binding);
    const unset = isUnset(binding) && !chosen;

    const runActions: [string, unknown][] = Object.entries(definition?.actions || {})
        .filter(([, action]) => action?.kind === 'run_automation');

    const pickSource = (next: string) => {
        setChoosing(false);
        setChosen(true);
        // Re-picking the card that is already active keeps what is configured.
        if (next === mode && !unset) return;
        const skeleton = skeletonFor(next, runActions);
        if (skeleton) emit(skeleton);
    };

    if (unset || choosing) {
        return (
            <FormField label={label} hint={hint}>
                <SourceChooser
                    onPick={pickSource}
                    onCancel={unset ? null : () => setChoosing(false)}
                    disabled={disabled}
                />
            </FormField>
        );
    }

    return (
        <FormField label={label} hint={hint}>
            <div className="flex flex-col gap-2">
                <SourceSummary
                    binding={binding}
                    appId={appId}
                    onChangeClick={() => setChoosing(true)}
                    disabled={disabled}
                />

                {mode === 'static' ? (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={staticDisplay(binding.value)}
                        onChange={(e) => emit({ kind: 'static', value: parseStatic(e.target.value) })}
                        placeholder={placeholder ?? t('studio_apps_panels.binding.static_placeholder', 'A value, or JSON like ["a","b"]')}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={t('studio_apps_panels.binding.typed_value', 'Typed-in value')}
                    />
                ) : null}

                {mode === 'formula' ? (
                    <FormulaField
                        value={binding.expr || ''}
                        onChange={(expr) => emit({ kind: 'formula', expr })}
                        definition={definition}
                        node={node}
                        placeholder={t('studio_apps_panels.binding.formula_placeholder', 'e.g. currentUser.name')}
                        disabled={disabled}
                    />
                ) : null}

                {mode === 'records' ? (
                    <TableBinding binding={binding} onChange={emit} appId={appId} disabled={disabled} definition={definition} node={node} singleValue={singleValue} />
                ) : null}

                {mode === 'aggregate' ? (
                    <AggregateBinding binding={binding} onChange={emit} appId={appId} disabled={disabled} definition={definition} node={node} singleValue={singleValue} />
                ) : null}

                {mode === 'dataset' ? (
                    <DatasetBinding
                        binding={binding}
                        onChange={emit}
                        onBuild={onBuild}
                        appId={appId}
                        componentType={componentType}
                        singleValue={singleValue}
                        disabled={disabled}
                    />
                ) : null}

                {mode === 'connector' ? (
                    <ConnectorBinding
                        binding={binding}
                        onChange={emit}
                        appId={appId}
                        definition={definition}
                        node={node}
                        disabled={disabled}
                    />
                ) : null}

                {mode === 'actionResult' ? (
                    <div className="flex flex-col gap-2">
                        <select
                            className={INPUT_CLS}
                            value={binding.actionId || ''}
                            onChange={(e) => emit({ ...binding, kind: 'actionResult', actionId: e.target.value || null })}
                            disabled={disabled}
                            aria-label={t('studio_apps_panels.binding.source_action', 'Source action')}
                        >
                            <option value="">{t('studio_apps_panels.binding.pick_action', 'Pick an action…')}</option>
                            {runActions.map(([id]) => (
                                <option key={id} value={id}>{t('studio_apps_panels.binding.run_automation_option', 'Run automation — {id}', { id })}</option>
                            ))}
                        </select>
                        {runActions.length === 0 && (
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('studio_apps_panels.binding.no_run_actions', 'No “Run automation” actions in this app yet — wire one to a button or form first.')}
                            </p>
                        )}
                        <input
                            type="text"
                            className={INPUT_CLS}
                            value={binding.path || ''}
                            onChange={(e) => emit({ ...binding, kind: 'actionResult', path: e.target.value })}
                            placeholder={t('studio_apps_panels.binding.result_path_placeholder', 'e.g. rows or data.items')}
                            disabled={disabled}
                            spellCheck={false}
                            aria-label={t('studio_apps_panels.binding.result_path', 'Result path')}
                        />
                    </div>
                ) : null}
            </div>
        </FormField>
    );
}
