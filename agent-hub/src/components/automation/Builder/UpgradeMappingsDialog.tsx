import { useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { humanizeKey } from '@shared/mapping/index.mjs';
import Modal from '../../shared/Modal';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranslateFn } from '../../../hooks/useTranslation';
import {
    useApplyUpgradeMappings, useUpgradeMappingsPreview, type UpgradeEntry, type UpgradeReport,
} from '../../../api/queries/automation/upgradeMappings';
import { PRIMARY_BTN, SECONDARY_BTN } from './settings/settingsUi';

/** The rebase refusals that come down to "the item is read in a text or a formula". */
const LOOP_REASONS = new Set(['loop_in_template', 'loop_in_expr', 'loop_in_text', 'loop_index', 'loop_ref_unreadable', 'loop_elsewhere']);

function reasonText(t: TranslateFn, reason: UpgradeEntry['reason']): string {
    switch (reason) {
        case 'formula': return t('mapping.upgrade.reason.formula', 'A formula');
        case 'would_change': return t('mapping.upgrade.reason.would_change', 'The last run would give a different result');
        case 'no_evidence': return t('mapping.upgrade.reason.no_evidence', 'No run or example shows this value yet');
        case 'for_each_kept': return t('mapping.upgrade.reason.for_each_kept', 'Part of "run once per item", which stays');
        case 'list_differs': return t('mapping.upgrade.reason.list_differs', 'Would run for other items than it does now');
        default:
            return reason && LOOP_REASONS.has(reason)
                ? t('mapping.upgrade.reason.loop', 'Uses the item in a text or a formula')
                : t('mapping.upgrade.reason.other', 'Kept as it is');
    }
}

/** The field of a step as a person reads it: its last key ('inputs.values.Datum' → "Datum"). */
function fieldName(field: string): string {
    const keys = field.split('.').filter((k) => k && !/^\d+$/.test(k));
    return humanizeKey(keys[keys.length - 1] || field);
}

/** What a value reads: "Orders ophalen › Klant › E-mail", "Incoming data › Naam". */
function readText(t: TranslateFn, e: UpgradeEntry): string {
    const from = e.root === 'trigger' || e.root === 'run'
        ? t('mapping.slot.label.trigger', 'Incoming data')
        : e.root === 'vars'
            ? t('mapping.upgrade.source_vars', 'Variables')
            : e.root === 'steps' ? (e.source || '') : '';
    return [from, e.label || ''].filter(Boolean).join(' › ');
}

function stepText(t: TranslateFn, e: UpgradeEntry): string {
    const name = e.step || t('mapping.upgrade.step_unnamed', 'Step {id}', { id: e.stepId || '?' });
    return e.layer ? `${name} (${t('mapping.upgrade.in_flowlet', 'in flowlet {name}', { name: e.layer })})` : name;
}

/** One line of either list: the step and field, then what it reads (or why it stays). */
function EntryRow({ entry, kept }: { entry: UpgradeEntry; kept: boolean }) {
    const { t } = useTranslation();
    const reads = readText(t, entry);
    let what: string;
    if (entry.kind === 'for_each') what = t('mapping.upgrade.entry_repeat', 'Runs separately for each item of {label}', { label: reads || '…' });
    else if (entry.take === 'each') what = t('mapping.upgrade.entry_each', '{label} (of this item)', { label: reads });
    else what = reads;
    return (
        <li className="flex flex-col gap-0.5 px-3 py-2" data-testid={kept ? 'upgrade-kept' : 'upgrade-changed'}>
            <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-medium text-[var(--text-primary)] truncate">{stepText(t, entry)}</span>
                {entry.kind !== 'for_each' && <span className="text-[var(--text-tertiary)] truncate">· {fieldName(entry.field)}</span>}
            </div>
            {what && <div className="text-[var(--text-secondary)] truncate">{what}</div>}
            {kept && <div className="text-[var(--text-tertiary)]">{reasonText(t, entry.reason)}</div>}
        </li>
    );
}

function EntryList({ title, entries, kept }: { title: string; entries: UpgradeEntry[]; kept: boolean }) {
    if (!entries.length) return null;
    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="text-[12px] font-semibold text-[var(--text-secondary)]">{title}</h3>
            <ul className="rounded-[10px] border border-[var(--border-default)] divide-y divide-[var(--border-default)] text-[12px]">
                {entries.map((e, i) => <EntryRow key={`${e.stepId}:${e.field}:${i}`} entry={e} kept={kept} />)}
            </ul>
        </section>
    );
}

/** "X velden bijgewerkt, Y blijven Formule": the fields that move, the ones that stay. */
function Summary({ report, done }: { report: UpgradeReport; done: boolean }) {
    const { t } = useTranslation();
    const params = { changed: report.changed.length, kept: report.kept.length };
    return (
        <p role="status" className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
            {done && <CheckCircle2 className="w-4 h-4 text-[var(--success)]" aria-hidden />}
            {done
                ? t('mapping.upgrade.done_summary', '{changed} field(s) updated, {kept} stay a Formula', params)
                : t('mapping.upgrade.preview_summary', '{changed} field(s) can be updated, {kept} stay a Formula', params)}
        </p>
    );
}

/** Waiting for the dry run, or the report: the summary and both lists. */
function ReportBody({ report, failed, done }: { report: UpgradeReport | null; failed: boolean; done: boolean }) {
    const { t } = useTranslation();
    if (!report) {
        return (
            <p className="flex items-center gap-2 text-[var(--text-secondary)]" role="status">
                {failed
                    ? t('mapping.upgrade.check_failed', 'Bee could not check the mappings right now.')
                    : <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />{t('mapping.upgrade.checking', 'Bee is comparing the fields with the last run…')}</>}
            </p>
        );
    }
    const noData = !done && !report.evidence.lastRun && !report.evidence.sample;
    const empty = !report.changed.length && !report.kept.length;
    return (
        <>
            {!done && <p className="text-[var(--text-secondary)] leading-[17px]">{t('mapping.upgrade.intro', 'Bee compares every field with the last run and leaves any field alone whose result would change. Nothing is saved until you apply it.')}</p>}
            <Summary report={report} done={done} />
            {noData && <p className="text-[var(--warning)]">{t('mapping.upgrade.no_evidence_note', 'There is no run or pinned example to compare with yet. Run the automation once, then check again.')}</p>}
            {empty && <p className="text-[var(--text-secondary)]">{t('mapping.upgrade.nothing', 'There is nothing to update.')}</p>}
            <EntryList title={done ? t('mapping.upgrade.done_title', 'Updated') : t('mapping.upgrade.changed_title', 'Will be updated')} entries={report.changed} kept={false} />
            <EntryList title={t('mapping.upgrade.kept_title', 'Stays as it is')} entries={report.kept} kept />
        </>
    );
}

/** Cancel + Apply while previewing; Close once it is applied. */
function Footer({ done, canApply, pending, count, onApply, onClose }: {
    done: boolean; canApply: boolean; pending: boolean; count: number; onApply: () => void; onClose: () => void;
}) {
    const { t } = useTranslation();
    if (done) return <button type="button" onClick={onClose} className={PRIMARY_BTN}>{t('mapping.upgrade.close', 'Close')}</button>;
    return (
        <>
            <button type="button" onClick={onClose} className={SECONDARY_BTN}>{t('mapping.upgrade.cancel', 'Cancel')}</button>
            <button type="button" onClick={onApply} disabled={!canApply || pending} className={PRIMARY_BTN}>
                {pending
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />{t('mapping.upgrade.applying', 'Updating…')}</>
                    : t('mapping.upgrade.apply', 'Update {n} field(s)', { n: count })}
            </button>
        </>
    );
}

/**
 * "Koppelingen bijwerken" (M8 of the data-mapping work): show a routine's
 * stored refs as values instead of formulas (an expr stays one), and its "run
 * once per item" steps as a repeat, only where the result stays the same.
 *
 * Opening it runs the dry run (POST /:id/upgrade-mappings?dryRun=1): a
 * summary ("3 fields can be updated, 1 stays a Formula"), what would be
 * updated and what stays, and why. Apply saves a new version of what the
 * preview showed; a routine saved in between is refused (409), and the
 * preview is read again. `onApplied` gets the saved row, so the builder can
 * adopt the new definition.
 */
export default function UpgradeMappingsDialog({ open, automationId, onClose, onApplied }: {
    open: boolean;
    automationId: string;
    onClose: () => void;
    onApplied?: (automation: Record<string, unknown>) => void;
}) {
    const { t } = useTranslation();
    const preview = useUpgradeMappingsPreview(automationId, { enabled: open });
    const apply = useApplyUpgradeMappings(automationId);
    const [done, setDone] = useState<UpgradeReport | null>(null);
    const [stale, setStale] = useState(false);
    const heading = t('mapping.upgrade.title', 'Update mappings');

    const onApply = () => {
        if (!preview.data) return;
        setStale(false);
        apply.mutate(preview.data.version, {
            onSuccess: (r) => {
                setDone(r);
                if (r.saved && r.automation) onApplied?.(r.automation);
            },
            onError: (e) => {
                if (e.code !== 'version_changed') return;
                setStale(true);
                void preview.refetch();
            },
        });
    };

    const count = preview.data?.changed.length ?? 0;
    const canApply = !done && !preview.isFetching && count > 0;
    const failure = apply.isError && !stale ? (apply.error?.message || t('mapping.upgrade.apply_failed', 'Could not update the mappings. Nothing was changed.')) : null;
    return (
        <Modal open={open} onClose={onClose} size="auto" className="w-full max-w-[600px]" label={heading} variant="bare">
            <div className="rounded-[14px] bg-[var(--bg-card)] shadow-xl text-xs text-[var(--text-primary)] flex flex-col max-h-[90vh] overflow-hidden">
                <div className="px-[18px] py-3.5 flex items-center gap-2 border-b border-[var(--border-default)]">
                    <h2 className="font-semibold text-sm">{heading}</h2>
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <X className="w-[15px] h-[15px]" aria-hidden />
                    </button>
                </div>
                <div className="p-[18px] flex flex-col gap-3 overflow-y-auto">
                    <ReportBody report={done || preview.data || null} failed={preview.isError} done={!!done} />
                    {stale && <p role="alert" className="text-[var(--warning)]">{t('mapping.upgrade.stale', 'This automation changed after the check. Bee checked it again; look at the result before you apply it.')}</p>}
                    {failure && <p role="alert" className="text-[var(--error)]">{failure}</p>}
                </div>
                <div className="px-[18px] py-3 border-t border-[var(--border-default)] flex gap-2 justify-end">
                    <Footer done={!!done} canApply={canApply} pending={apply.isPending} count={count} onApply={onApply} onClose={onClose} />
                </div>
            </div>
        </Modal>
    );
}
