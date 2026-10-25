import { CheckCircle2, MoreVertical, Pause, PencilLine } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import ContextMenu from './ContextMenu';
import { buildAutomationMenuItems } from './automationMenuItems';
import { cardStatusOf } from './cardStatus';
import { statusLabelOf, triggerTextOf, type AutomationRecord } from './overviewModel';
import { TONE_CLASSES, toneLabelOf, triggerGlyphKeyOf, triggerToneOf } from './triggerTone';
import { TRIGGER_ICONS } from '../../../automation/Builder/flow/triggerIcons';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { STATUS_TOKENS, statusLabel, tokenFor } from '../../../shared/statusTokens';
import type { AutomationRowProps } from './AutomationRow';
import type { Point } from '../map/studioMap.types';

/**
 * The pieces every view of "All automations" shares — the trigger tile, the
 * state badge, the last-run line and the kebab menu — so a card, a list row
 * and a board tile describe an automation in one vocabulary.
 */

export const titleOf = (a: AutomationRecord, t: TranslateFn) => a.title || t('studio_misc.overview.untitled_automation', 'Untitled automation');

const TILE_SIZE = {
    sm: { box: 'h-5 w-5 rounded-md', icon: 12 },
    md: { box: 'h-7 w-7 rounded-md', icon: 13 },
    lg: { box: 'h-9 w-9 rounded-lg', icon: 16 },
} as const;

/**
 * The anchor of a row or card: the trigger's glyph on a calm tint of its
 * tone. It keeps its colour whatever the state — the state has its own badge
 * — so the same kind of automation looks the same in every lane.
 */
export function TriggerTile({ automation, size = 'md' }: { automation: AutomationRecord; size?: keyof typeof TILE_SIZE }) {
    const { t } = useTranslation();
    const tone = triggerToneOf(automation);
    const Icon = TRIGGER_ICONS[triggerGlyphKeyOf(automation)];
    const { box, icon } = TILE_SIZE[size];
    // "Schedule: Every day at 09:00"; no prefix where the text already says it ("Started by hand").
    const text = triggerTextOf(automation, t);
    const kindName = toneLabelOf(tone, t);
    const label = text.toLowerCase().includes(kindName.toLowerCase()) ? text : `${kindName}: ${text}`;
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            data-testid="overview-trigger-tile"
            data-tone={tone}
            className={`inline-flex ${box} items-center justify-center shrink-0 ${TONE_CLASSES[tone].tile}`}
        >
            <Icon size={icon} aria-hidden="true" />
        </span>
    );
}

/**
 * Live / Paused / Draft, each with its own shape as well as its colour: Live
 * a filled green pill with a dot, Paused a grey pill with a pause glyph, Draft
 * an outlined pill with a pencil. Only Live gets colour; the other two are
 * calm on purpose, so a column of cards shows what is ON at a glance.
 */
export function StatusBadge({ automation }: { automation: AutomationRecord | null }) {
    const { t } = useTranslation();
    const { lifecycle } = cardStatusOf(automation);
    const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 shrink-0';
    let look: string;
    let glyph: React.ReactNode;
    if (lifecycle === 'live') {
        look = 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]';
        glyph = <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" aria-hidden="true" />;
    } else if (lifecycle === 'paused') {
        look = 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]';
        glyph = <Pause size={10} aria-hidden="true" />;
    } else {
        look = 'border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)]';
        glyph = <PencilLine size={10} aria-hidden="true" />;
    }
    return (
        <span className={`${base} ${look}`} data-testid="overview-lifecycle" data-status={lifecycle}>
            {glyph}
            {statusLabelOf(lifecycle, t)}
        </span>
    );
}

/**
 * What the last run did, and when. A failure and a run in progress get a
 * badge; a success is a small check beside the time (the green "Finished"
 * pill next to a green "Live" pill was the same word twice); "Never ran" is
 * only said where it is news — never on a draft.
 */
export function OutcomeBit({ automation, liveRunning, when }: { automation: AutomationRecord; liveRunning: boolean; when?: string | null }) {
    const { t } = useTranslation();
    const { outcome } = cardStatusOf(automation, liveRunning);
    const time = when ? <span className="text-[11px] text-[var(--text-tertiary)] truncate">{when}</span> : null;
    if (outcome === null) return time;
    if (outcome === 'never') {
        return <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="overview-outcome" data-outcome="never">{t('studio_misc.overview.never_ran', 'Never ran')}</span>;
    }
    if (outcome === 'ok') {
        const tok = STATUS_TOKENS.success;
        return (
            <span className="inline-flex items-center gap-1 min-w-0" data-testid="overview-outcome" data-outcome="ok">
                <CheckCircle2 size={12} aria-hidden="true" className={`shrink-0 ${tok.solid}`} />
                <span className="sr-only">{statusLabel(t, tok)}</span>
                {time}
            </span>
        );
    }
    const tok = outcome === 'running' ? STATUS_TOKENS.running : tokenFor(automation.lastStatus);
    const Icon = tok.icon;
    return (
        <span className="inline-flex items-center gap-1.5 min-w-0" data-testid="overview-outcome" data-outcome={outcome}>
            <span className={`inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-md font-semibold shrink-0 ${tok.badge}`}>
                <Icon className={`w-3 h-3 ${outcome === 'running' || tok.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
                {statusLabel(t, tok)}
            </span>
            {outcome === 'running' ? null : time}
        </span>
    );
}

/** The kebab + its menu — one per row/card/tile, opened on click or right-click. */
export function useRowMenu(props: AutomationRowProps | null | undefined) {
    const { t } = useTranslation();
    const [pos, setPos] = useState<Point | null>(null);
    const items = useMemo(() => buildAutomationMenuItems({
        isAutomation: true,
        isActive: !!props?.automation?.isActive,
        onToggleActive: props?.onToggleActive,
        onOpenRuns: props?.onOpenRuns,
        onDuplicate: props?.onDuplicate,
        onExportJson: props?.onExportJson,
        onMoveToFolder: props?.onMoveToFolder,
        onCopyId: props?.onCopyId,
        onDelete: props?.onDelete,
        t,
    }), [props, t]);
    const onContextMenu = (e: React.MouseEvent) => {
        if (!items.length) return;
        e.preventDefault();
        setPos({ x: e.clientX, y: e.clientY });
    };
    const onKebab = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setPos({ x: rect.right, y: rect.bottom });
    };
    const menu = <ContextMenu position={pos} items={items} onClose={() => setPos(null)} />;
    const kebab = items.length > 0 && (
        <button
            type="button"
            onClick={onKebab}
            title={t('studio_misc.overview.more_options', 'More options')}
            aria-label={t('studio_misc.overview.more_options', 'More options')}
            className="opacity-60 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded p-0.5 transition"
        >
            <MoreVertical size={14} aria-hidden="true" />
        </button>
    );
    return { onContextMenu, kebab, menu };
}
