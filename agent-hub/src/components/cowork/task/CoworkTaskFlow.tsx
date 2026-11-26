import { useState } from 'react';
import { ArrowDown, ChevronDown, FileSearch, Hand, PenLine, Send } from 'lucide-react';
import { paletteItemForType } from '@/components/automation/Builder/flow/stepPalette';
import IntegrationLogo from '@/components/automation/Builder/flow/nodes/IntegrationLogo';
import type { TranslateFn } from '@/hooks/useTranslation';
import { stepWord, type TaskStep } from './coworkTaskModel';
import { TAG_WARN } from './taskUi';

const TILE: Record<TaskStep['sort'], string> = {
    read: 'text-[var(--text-secondary)]',
    change: 'text-[var(--warning-ink)]',
    send: 'text-[var(--success-ink)]',
    ai: 'text-[var(--type-ai)]',
    ask: 'text-[var(--warning-ink)]',
};
const ICON = { read: FileSearch, change: PenLine, send: Send, ask: Hand } as const;
/** The tile of a step a model does: a mark, the same in every language (hidden from screen readers; the word below says it). */
const AI_MARK = 'AI';

export function StepTile({ step }: { step: TaskStep }) {
    const base = 'w-8 h-8 rounded-[var(--radius-md)] border grid place-items-center flex-shrink-0 text-[12px] font-semibold';
    const tone = `${base} border-[var(--border-subtle)] bg-[var(--bg-tertiary)] ${TILE[step.sort]}`;
    const Icon = paletteItemForType(step.type ?? '')?.icon ?? (step.sort === 'ai' ? null : ICON[step.sort]);
    const fallback = Icon ? <Icon size={16} /> : AI_MARK;
    return (
        <span aria-hidden="true" className={tone}>
            {step.integrationId ? <IntegrationLogo integrationId={step.integrationId} size={18} fallback={fallback} /> : fallback}
        </span>
    );
}

function preparation(step: TaskStep) {
    return step.helper || step.script;
}

function appRead(step: TaskStep) {
    return step.sort === 'read' && !!step.integrationId && !preparation(step);
}

// Only combine adjacent reads from the same app and the transformations between them.
function stagesOf(steps: TaskStep[]) {
    const stages: TaskStep[][] = [];
    for (const step of steps) {
        const current = stages.at(-1);
        const first = current?.[0];
        const relatedRead = first && appRead(first) && appRead(step) && first.integrationId === step.integrationId;
        const relatedPreparation = first && preparation(step) && (appRead(first) || preparation(first));
        if (current && first?.depth === step.depth && (relatedRead || relatedPreparation)) current.push(step);
        else stages.push([step]);
    }
    return stages;
}

function stageTitle(rows: TaskStep[], t: TranslateFn) {
    const first = rows[0]!;
    if (rows.length === 1) return first.title;
    if (preparation(first)) return t('cowork_task.flow.prepare', 'Prepare data');
    if (rows.filter(appRead).length > 1) return t('cowork_task.flow.read_app', 'Read from {app}', { app: first.app });
    return first.title;
}

function Changed({ t }: { t: TranslateFn }) {
    return <span className={TAG_WARN}>{t('cowork_task.steps.changed', 'Changed')}</span>;
}

function stageDescription(rows: TaskStep[], t: TranslateFn) {
    if (rows.length > 1) return t('cowork_task.flow.step_count', '{count} steps', { count: rows.length });
    const first = rows[0]!;
    if (first.script) return first.description;
    return [stepWord(first, t), first.app].filter(Boolean).join(' · ');
}

function Stage({ rows, t }: { rows: TaskStep[]; t: TranslateFn }) {
    const [open, setOpen] = useState(false);
    const first = rows[0]!;
    const expandable = rows.length > 1 || !!first.inputNames?.length;
    return <div className="relative">
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)]">
            <div className="flex items-center gap-3 px-4 py-3" data-testid="cowork-task-step">
                <StepTile step={first} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
                        <span className="break-words">{stageTitle(rows, t)}</span>
                        {rows.some(step => step.changed) && <Changed t={t} />}
                    </div>
                    <div className="text-[13px] text-[var(--text-secondary)]" data-testid="cowork-task-step-word">
                        {stageDescription(rows, t)}
                    </div>
                </div>
                {expandable && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    {t('cowork_task.flow.details', 'Details')}<ChevronDown aria-hidden="true" size={14} className={open ? 'rotate-180' : ''} />
                </button>}
            </div>
            {open && <ol className="m-0 list-none space-y-3 border-t border-[var(--border-subtle)] px-4 py-3">
                {rows.map(step => <li key={step.id} className="flex items-start gap-3">
                    <StepTile step={step} />
                    <div className="min-w-0 break-words text-[13px]">
                        <span className="font-medium">{step.title}</span> {step.changed && <Changed t={t} />}
                        <div className="text-[var(--text-secondary)]">{step.description || stepWord(step, t)}</div>
                        {!!step.inputNames?.length && <div className="text-[var(--text-secondary)]">{t('cowork_task.flow.inputs', 'Inputs: {fields}', { fields: step.inputNames.join(', ') })}</div>}
                    </div>
                </li>)}
            </ol>}
        </div>
    </div>;
}

export default function CoworkTaskFlow({ steps, t }: { steps: TaskStep[]; t: TranslateFn }) {
    return <ol className="m-0 list-none p-0">
        {stagesOf(steps).map((rows, index) => <li key={rows[0]!.id}>
            {index > 0 && <ArrowDown aria-hidden="true" size={18} className="ml-[23px] text-[var(--text-tertiary)]" />}
            <Stage rows={rows} t={t} />
        </li>)}
    </ol>;
}
