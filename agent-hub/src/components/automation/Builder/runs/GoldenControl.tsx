import React, { useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { GoldenItem } from '@/api/queries/automation/runChecks';
import type { RunRowData } from '@/api/queries/automation/runs';
import { useGoldens, useMarkGolden, useUnmarkGolden } from '@/api/queries/automation/runChecks';
import HelpPopover from './HelpPopover';
import IgnorePathsEditor from './IgnorePathsEditor';
import RunAction from './RunAction';
import { goldenErrorText } from './runChecksErrors';
import { POPOVER_PANEL, PRIMARY_BTN, SECONDARY_BTN, TEXT_INPUT } from './runChecksStyles';

/** What a golden run is, once, for anybody who has not met one. */
export function GoldenHelp() {
    const { t } = useTranslation();
    return (
        <HelpPopover label={t('automation_run_checks.golden.help_label', 'What is a golden run?')}>
            {t('automation_run_checks.golden.help', 'A golden run is a run you trust. Replaying goldens runs the same input again as a test run (nothing is sent) and shows what changed. Goldens are run data: they are deleted together with the run (run retention) and are never exported or deployed.')}
        </HelpPopover>
    );
}

interface MarkFormProps {
    label: string;
    onLabel: (v: string) => void;
    paths: string[];
    onPaths: (v: string[]) => void;
    busy: boolean;
    onSave: () => void;
    onCancel: () => void;
}

/** The label and the ignored fields of a run about to become golden. */
function MarkForm({ label, onLabel, paths, onPaths, busy, onSave, onCancel }: MarkFormProps) {
    const { t } = useTranslation();
    return (
        <>
            <label className="flex flex-col gap-1">
                <span className="font-medium text-[var(--text-primary)]">{t('automation_run_checks.golden.label_field', 'Label (optional)')}</span>
                <input
                    value={label}
                    onChange={e => onLabel(e.target.value)}
                    maxLength={80}
                    placeholder={t('automation_run_checks.golden.label_placeholder', 'For example: a normal week')}
                    className={TEXT_INPUT}
                />
            </label>
            <IgnorePathsEditor paths={paths} onChange={onPaths} />
            <div className="flex gap-2">
                <button type="button" className={PRIMARY_BTN} onClick={onSave} disabled={busy}>
                    {t('automation_run_checks.golden.save', 'Save golden run')}
                </button>
                <button type="button" className={SECONDARY_BTN} onClick={onCancel}>
                    {t('automation_run_checks.golden.cancel', 'Cancel')}
                </button>
            </div>
        </>
    );
}

/** A run that already is golden: its label, what it ignores, and the way out. */
function GoldenInfo({ golden, busy, onRemove }: { golden: GoldenItem; busy: boolean; onRemove: () => void }) {
    const { t } = useTranslation();
    return (
        <>
            <p className="text-[var(--text-secondary)]">
                {golden.label || t('automation_run_checks.golden.no_label', 'This run is a golden run.')}
            </p>
            {golden.ignorePaths.length > 0 && (
                <p className="text-[var(--text-tertiary)]">
                    {t('automation_run_checks.golden.ignoring', 'Ignored when comparing: {fields}', { fields: golden.ignorePaths.join(', ') })}
                </p>
            )}
            <div className="flex gap-2">
                <button type="button" className={SECONDARY_BTN} onClick={onRemove} disabled={busy}>
                    {t('automation_run_checks.golden.remove', 'Remove golden')}
                </button>
            </div>
        </>
    );
}

/** "Mark as golden" on a finished run, or "Golden ✓" with the way to remove it. */
export default function GoldenControl({ automationId, run }: { automationId: string; run: RunRowData }) {
    const { t } = useTranslation();
    const goldens = useGoldens(automationId);
    const mark = useMarkGolden(automationId);
    const unmark = useUnmarkGolden(automationId);
    const [open, setOpen] = useState(false);
    const [label, setLabel] = useState('');
    const [paths, setPaths] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const golden = goldens.data?.goldens.find(g => g.runId === run.id || (!!run.parentRunId && g.runId === run.parentRunId)) ?? null;
    const busy = mark.isPending || unmark.isPending;

    const toggle = () => { setOpen(o => !o); setError(null); };
    /** Run the call; a refusal is shown in plain words and the panel stays open. */
    const attempt = async (call: () => Promise<unknown>, done: () => void) => {
        setError(null);
        try {
            await call();
            done();
        } catch (e) {
            setError(goldenErrorText(e, t));
        }
    };
    const save = () => attempt(
        () => mark.mutateAsync({ runId: run.id, label: label.trim() || undefined, ignorePaths: paths }),
        () => { setOpen(false); setLabel(''); setPaths([]); },
    );
    const remove = () => attempt(() => unmark.mutateAsync(golden?.runId ?? run.id), () => setOpen(false));

    return (
        <div className="relative">
            <RunAction
                icon={Star}
                label={golden ? t('automation_run_checks.golden.is_golden', 'Golden ✓') : t('automation_run_checks.golden.mark', 'Mark as golden')}
                onClick={toggle}
                expanded={open}
            />
            {open && (
                <div className={POPOVER_PANEL} role="group" aria-label={t('automation_run_checks.golden.panel_label', 'Golden run')}>
                    <div className="flex items-center gap-1.5 font-semibold text-sm text-[var(--text-primary)]">
                        {t('automation_run_checks.golden.title', 'Golden run')}
                        <GoldenHelp />
                    </div>
                    {golden
                        ? <GoldenInfo golden={golden} busy={busy} onRemove={remove} />
                        : <MarkForm label={label} onLabel={setLabel} paths={paths} onPaths={setPaths} busy={busy} onSave={save} onCancel={toggle} />}
                    {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
                </div>
            )}
        </div>
    );
}
