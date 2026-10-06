import React, { useMemo } from 'react';
import { Braces, Hash, Table2, ToggleLeft, Type, Circle } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import OutputView from '../OutputView';
import type { IoField, IoKind } from './runIo';
import { configFields, humanKey, ioFields, mainList } from './runIo';
import BindingWarnings from './BindingWarnings';
import { stepBindingWarnings } from './bindingMisses';

const KIND_ICON: Record<IoKind, typeof Hash> = {
    number: Hash, list: Table2, record: Braces, text: Type, flag: ToggleLeft, empty: Circle,
};

function FieldList({ title, fields, empty, className = '' }: { title: string; fields: IoField[]; empty: string; className?: string }) {
    return (
        <div className={`px-4 py-3 min-w-0 ${className}`}>
            <div className="font-semibold text-[var(--text-primary)]">{title}</div>
            <div className="mt-1 flex flex-col gap-1 text-[var(--text-secondary)]">
                {fields.length ? fields.map((f) => {
                    const Icon = KIND_ICON[f.kind];
                    return (
                        <span key={f.key || f.label} className="flex items-center gap-2 min-w-0">
                            <Icon size={13} aria-hidden className="shrink-0" />
                            {/* The name keeps up to half the row, so a long value never squeezes it to "T…". */}
                            <span className="shrink-0 max-w-[50%] truncate" title={f.label}>{f.label}</span>
                            <span className="ml-auto pl-2 min-w-0 text-[var(--text-tertiary)] truncate" title={f.preview}>{f.preview}</span>
                        </span>
                    );
                }) : <span className="text-[var(--text-tertiary)]">{empty}</span>}
            </div>
        </div>
    );
}

// Its own width decides: under 600px the two lists stack above the output;
// from 600px they sit side by side; from 1100px they become a 400px column
// beside the output, so a name stays near its value and the table gets the rest.
const IO_LAYOUT = 'flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar @[1100px]/runio:grid @[1100px]/runio:grid-cols-[400px_minmax(0,1fr)] @[1100px]/runio:grid-rows-[minmax(0,1fr)] @[1100px]/runio:overflow-hidden';
const LISTS = 'grid grid-cols-1 content-start shrink-0 border-b border-[var(--border-default)] @[600px]/runio:grid-cols-2 @[1100px]/runio:grid-cols-1 @[1100px]/runio:border-b-0 @[1100px]/runio:border-r @[1100px]/runio:min-h-0 @[1100px]/runio:overflow-y-auto custom-scrollbar';
const SECOND_LIST = 'border-t border-[var(--border-default)] @[600px]/runio:border-t-0 @[600px]/runio:border-l @[1100px]/runio:border-l-0 @[1100px]/runio:border-t';

/** Got in / Passed on for one step, and its output as a table. */
export default function RunIo({ step, label, stepDef = null, labelById = null }: {
    step: RunStepRecord | null;
    label: string;
    /** The step as this run's version defined it (BFSF-456): what it was set up to do. */
    stepDef?: Record<string, unknown> | null;
    labelById?: Map<string, string> | null;
}) {
    const { t } = useTranslation();
    const settings = useMemo(() => configFields(t, stepDef, labelById), [t, stepDef, labelById]);
    const inFields = useMemo(() => ioFields(t, step?.input), [t, step]);
    const outFields = useMemo(() => ioFields(t, step?.output), [t, step]);
    const list = useMemo(() => mainList(step?.output, step?.stepType), [step]);
    const misses = useMemo(() => stepBindingWarnings(step), [step]);

    if (!step) {
        return <div className="p-4 text-xs text-[var(--text-tertiary)]">{t('runs.tab.pick_step', 'Pick a step to see what it got and passed on.')}</div>;
    }
    const tableTitle = list?.key ? humanKey(list.key) : label;
    const shown = list ? list.rows : step.output;

    return (
        <div className="@container/runio flex flex-col min-h-0 min-w-0 text-xs">
            <div className={IO_LAYOUT}>
                <div className={LISTS}>
                    <FieldList title={t('runs.tab.got_in', 'Got in')} fields={inFields} empty={t('runs.io.nothing', 'Nothing')} />
                    <FieldList title={t('runs.tab.passed_on', 'Passed on')} fields={outFields} empty={t('runs.io.nothing', 'Nothing')} className={SECOND_LIST} />
                    {settings.length > 0 && (
                        <FieldList title={t('runs.tab.settings', 'Settings in this run')} fields={settings} empty="" className={SECOND_LIST} />
                    )}
                </div>
                <div className="px-4 py-3 flex flex-col gap-2 flex-1 min-h-[320px] min-w-0 @[1100px]/runio:min-h-0">
                    {/* An input that came up empty is why an output looks wrong. */}
                    <BindingWarnings warnings={misses} labelById={labelById} />
                    <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)] truncate">{tableTitle}</span>
                        {list && (
                            <span className="text-[var(--text-tertiary)]">{t('runs.tab.rows_count', '{n} rows', { n: list.rows.length })}</span>
                        )}
                    </div>
                    {step.error && !step.output ? (
                        <div className="max-w-[720px] rounded-lg border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--error)_6%,transparent)] px-3 py-2 text-[var(--error)]">
                            {step.error}
                        </div>
                    ) : (
                        <OutputView value={shown} fill emptyMessage={t('runs.tab.no_output', 'This step passed nothing on.')} />
                    )}
                </div>
            </div>
        </div>
    );
}
