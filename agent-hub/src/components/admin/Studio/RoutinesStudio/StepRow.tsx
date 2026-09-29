import { History, Package, Trash2 } from 'lucide-react';
import type { ComponentType, KeyboardEvent } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { StepIcon as StepIconJs } from '../../../automation/Builder/flow/stepIcons';

// A .jsx module whose `fallback = null` default would type the prop as null-only.
const StepIcon = StepIconJs as unknown as ComponentType<Record<string, unknown>>;

/** One reusable Step (an automation of kind 'block') as the list reads it. */
export interface StepRowData {
    id: string;
    title?: string;
    description?: string | null;
    icon?: string | null;
    category?: string | null;
    /** null until the first Publish. */
    publishedVersion?: number | null;
    /** Shared beyond its owner (the whole organisation, or groups). */
    isPublished?: boolean;
    sharedGroups?: unknown[] | null;
    /** Callable as a tool in chat. */
    exposeAsTool?: boolean;
    [key: string]: unknown;
}

/** "Published · Organisation · In chat": what a building block is, in one quiet line. */
export function stepMeta(step: StepRowData, t: TranslateFn): string {
    const parts: string[] = [
        step.publishedVersion != null
            ? t('routines.library.blockPublished', 'Published')
            : t('routines.library.blockDraft', 'Draft'),
    ];
    const groups = Array.isArray(step.sharedGroups) && step.sharedGroups.length > 0;
    if (step.isPublished && groups) parts.push(t('routines.library.blockGroups', 'Groups'));
    else if (step.isPublished) parts.push(t('routines.library.blockOrg', 'Organisation'));
    else parts.push(t('routines.library.blockPersonal', 'Personal'));
    if (step.exposeAsTool) parts.push(t('routines.library.blockInChat', 'In chat'));
    if (step.category) parts.push(step.category);
    return parts.join(' · ');
}

/**
 * One building block in the automations list: its symbol, its name and one
 * quiet line saying whether it is published, who may use it and whether chat
 * can call it. Runs and delete appear on hover, like the automation rows
 * around it. The sidebar and the in-editor list flyout both draw this row.
 */
export default function StepRow({ step, selected = false, onOpen, onOpenRuns, onDelete }: {
    step: StepRowData;
    selected?: boolean;
    onOpen?: (id: string) => void;
    onOpenRuns?: ((id: string) => void) | null;
    onDelete?: ((step: StepRowData) => void) | null;
}) {
    const { t } = useTranslation();
    const title = step.title || t('routines.library.blockUntitled', 'Untitled building block');
    // The name first (the sidebar may cut it short), then the description.
    const description = (step.description || '').trim();
    const meta = stepMeta(step, t);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.(step.id);
        }
    };
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onOpen?.(step.id)}
            onKeyDown={onKeyDown}
            title={description && description !== title ? `${title}\n${description}` : title}
            data-testid="step-row"
            className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-sm transition ${
                selected
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'
            }`}
        >
            <span className="flex-shrink-0 text-[var(--text-tertiary)]">
                <StepIcon name={step.icon} size={14} fallback={<Package size={14} aria-hidden="true" />} />
            </span>
            <div className="flex-1 min-w-0">
                <div className="truncate">{title}</div>
                <div className="text-[10.5px] text-[var(--text-tertiary)] truncate" title={meta}>{meta}</div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
                {onOpenRuns && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenRuns(step.id); }}
                        title={t('routines.library.blockRuns', 'View runs')}
                        aria-label={t('routines.library.blockRuns', 'View runs')}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                        <History size={13} aria-hidden="true" />
                    </button>
                )}
                {onDelete && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDelete(step); }}
                        title={t('routines.library.blockDelete', 'Delete building block')}
                        aria-label={t('routines.library.blockDelete', 'Delete building block')}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                    >
                        <Trash2 size={13} aria-hidden="true" />
                    </button>
                )}
            </div>
        </div>
    );
}
