import type { LucideIcon } from 'lucide-react';

import { ACTIVITY_TAB, CHECKS_TAB_IDS, PIPELINE_TAB_IDS, TABS, isChecksTab } from './orgShieldTabs';
import { ownDataSummary } from './ownData/ownDataCopy';
import { builtInOnly } from './ownData/ownDataModel';
import type { CustomDataType } from './ownData/ownDataModel';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { presetFor } from '../../../../privacy/PiiSensitivityPicker';

/**
 * The path strip's items, each carrying its own read-out.
 *
 * A pure module (no JSX, no React) so "what does each step say, and when is
 * it amber" is unit-tested on data rather than through a rendered editor.
 *
 * ── Why each read-out comes from where it does ────────────────────────────
 * The strip is visible from every pane, so it must never disagree with the
 * pane it names. Overview reads the SAME posture count as the Overview's
 * review list; step 1 counts only the built-in kinds, like the matrix; step 2
 * is the Your own data pane's own summary. Nothing here invents a number.
 */

export type StripTone = 'warn';

export interface StripItem {
    id: string;
    label: string;
    Icon: LucideIcon;
    /** 1–4 on the path; absent on the two standalone pills. */
    step?: number;
    summary?: string;
    summaryTone?: StripTone;
    disabled: boolean;
    inPipeline: boolean;
}

/** The shield fields the read-outs look at. `useOrgShield` is untyped JS. */
export interface StripFields {
    enabled?: boolean;
    piiCategories?: readonly string[];
    piiConfidenceThreshold?: number;
    piiAction?: string;
    dlpEnabled?: boolean;
    customDataTypes?: readonly CustomDataType[];
    toolPiiPolicy?: { external?: { blockCategories?: readonly string[] } } | null;
}

export interface StripInput {
    f: StripFields;
    /** How many built-in kinds exist (the matrix's row count). */
    total: number;
    posture: { review?: number; attention?: number } | null;
    licence: { canTokenizePii?: boolean; canUseCustomData?: boolean };
    guard: { configured?: boolean; reachable?: boolean } | null;
    /** The licence that unlocks What happened; without it the pill has no read-out. */
    canSeeActivity: boolean;
    showActivityTab: boolean;
    t: TranslateFn;
}

interface ReadOut { text?: string; tone?: StripTone }

/** The window What happened opens on (its default range), and so what its pill promises. */
export const ACTIVITY_DAYS = 30;

const SEP = ' · ';

function overviewReadOut({ posture, t }: StripInput): ReadOut {
    const review = posture?.review ?? 0;
    if (review === 0) return { text: t('admin.shield_summary_all_clear', 'all clear') };
    // Amber only for real problems. An optional safeguard that is off still
    // counts towards the list, but must not make the strip look alarmed.
    return {
        text: t('shield_shell.summary_review', '{n} to review', { n: review }),
        tone: (posture?.attention ?? 0) > 0 ? 'warn' : undefined,
    };
}

function detectionReadOut({ f, total, t }: StripInput): ReadOut {
    // The category list also carries the org's own type ids; counted here
    // they would read "23 of 21".
    const n = builtInOnly(f.piiCategories).length;
    const preset = presetFor(f.piiConfidenceThreshold);
    const strictness = preset
        ? t(`privacy.sensitivity_${preset.id}`, preset.label)
        : t('admin.shield_posture_custom_pct', 'Custom ({pct}%)', { pct: Math.round((f.piiConfidenceThreshold ?? 0.7) * 100) });
    // One string, so the preset name never becomes a second text node that
    // collides with the sensitivity cards' own labels.
    return {
        text: t('shield_shell.summary_kinds', '{n} of {total} kinds', { n, total }) + SEP + strictness,
        // Shield on and nothing ticked: nothing is ever found.
        tone: n === 0 ? 'warn' : undefined,
    };
}

function processingReadOut({ f, licence, t }: StripInput): ReadOut {
    const tokenize = f.piiAction === 'tokenize';
    return {
        text: tokenize
            ? t('shield_shell.summary_replace', 'replace with placeholders')
            : t('admin.shield_summary_stopped', 'stopped'),
        // Stored 'tokenize' on a lapsed licence: the runtime stops instead.
        tone: tokenize && !licence.canTokenizePii ? 'warn' : undefined,
    };
}

function outboundReadOut({ f, t }: StripInput): ReadOut {
    const check = f.dlpEnabled
        ? t('admin.shield_summary_check_on', 'check on')
        : t('admin.shield_summary_check_off', 'no last check');
    // No kind held back from outside tools: whatever a connected app sends
    // leaves as it is. A setting, so it is known without any evidence.
    const toolsOpen = builtInOnly(f.toolPiiPolicy?.external?.blockCategories).length === 0;
    return toolsOpen
        ? { text: check + SEP + t('shield_shell.summary_tools_open', 'tools open'), tone: 'warn' }
        : { text: check };
}

function activityReadOut({ canSeeActivity, t }: StripInput): ReadOut {
    return canSeeActivity
        ? { text: t('shield_shell.summary_last_days', 'last {n} days', { n: ACTIVITY_DAYS }) }
        : {};
}

function readOutFor(id: string, input: StripInput): ReadOut {
    switch (id) {
    case 'overview': return overviewReadOut(input);
    case 'detection': return detectionReadOut(input);
    case 'owndata': return ownDataSummary(input.f.customDataTypes, {
        licensed: !!input.licence.canUseCustomData, guard: input.guard, t: input.t,
    });
    case 'processing': return processingReadOut(input);
    case 'outbound': return outboundReadOut(input);
    case 'activity': return activityReadOut(input);
    default: return {};
    }
}

export function buildStripItems(input: StripInput): StripItem[] {
    const tabs = input.showActivityTab ? [...TABS, ACTIVITY_TAB] : TABS;
    return tabs.map(({ id, labelKey, fallback, Icon }) => {
        const position = PIPELINE_TAB_IDS.indexOf(id);
        const { text, tone } = readOutFor(id, input);
        return {
            id,
            label: input.t(labelKey, fallback),
            Icon,
            step: position >= 0 ? position + 1 : undefined,
            summary: text,
            summaryTone: tone,
            // The control panes are meaningless while the shield is off;
            // disabling them says so instead of showing panes of inert
            // switches. Overview and What happened stay usable: history
            // exists even when the shield is off.
            disabled: id !== 'overview' && id !== 'activity' && !input.f.enabled,
            inPipeline: position >= 0,
        };
    });
}

/**
 * Both check ids render the combined pane; the one you clicked is the one the
 * pane emphasises, and the strip outlines its sibling so it is clear they
 * share a screen rather than one having vanished.
 */
export function emphasisOf(tab: string): string | null {
    if (!isChecksTab(tab)) return null;
    return CHECKS_TAB_IDS.find(id => id !== tab) ?? null;
}

export interface DirtyChip { id: string; label: string; Icon: LucideIcon; count: number }

/** The save bar's chips: one per step holding unsaved edits, named as on the strip. */
export function dirtyChips(stages: readonly { id: string; count: number }[], t: TranslateFn): DirtyChip[] {
    return stages.flatMap((stage) => {
        const tab = TABS.find(x => x.id === stage.id);
        return tab ? [{ id: stage.id, label: t(tab.labelKey, tab.fallback), Icon: tab.Icon, count: stage.count }] : [];
    });
}
