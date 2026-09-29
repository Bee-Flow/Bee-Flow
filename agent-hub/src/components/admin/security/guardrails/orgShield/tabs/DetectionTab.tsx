import { Eye, ScanSearch, Tags } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ShieldEvidence } from '../activity/useShieldEvidence';
import type { ToolPiiPolicy } from '../orgShieldDoc';
import { builtInOnly, customOnly } from '../ownData/ownDataModel';
import CategoryMatrix from '../parts/CategoryMatrix';
import type { MatrixKind } from '../parts/categoryMatrixModel';
import ShieldLinkCard from '../parts/ShieldLinkCard';
import StrictnessCard from '../parts/StrictnessCard';

/**
 * "What we look for".
 *
 * Widen then narrow: what the shield is, how hard it looks, which kinds it
 * looks for (and which may leave with a tool), then two signposts to "Your
 * own data": the org's own words and patterns, and the exceptions that are
 * never hidden. Both are edited there; this pane only summarises them.
 *
 * The category lists also carry the org's own type ids (the switches on Your
 * own data). The matrix is handed only the built-in part, and every whole-list
 * write it makes ("All", "None") puts the custom part back: without that,
 * "None" here would silently switch off every one of the org's own types.
 */

export interface DetectionFields {
    piiCategories: string[];
    setPiiCategories: (ids: string[]) => void;
    toolPiiPolicy?: Partial<ToolPiiPolicy>;
    piiConfidenceThreshold?: number;
    setPiiConfidenceThreshold: (v: number) => void;
    piiAllowTerms?: string[];
    piiAllowPublicOrgs?: boolean;
    customDataTypes?: unknown[];
}

interface DetectionTabProps {
    f: DetectionFields;
    categories: MatrixKind[];
    readOnly: boolean;
    licence?: { canUseWebSearchGuard?: boolean };
    /** The last 30 days; null when unknown (render nothing, never a zero). */
    evidence?: ShieldEvidence | null;
    toggleToolPiiCat: (cls: 'external' | 'internal', id: string, on: boolean) => void;
    onGoTo?: (tab: string) => void;
    t: TranslateFn;
}

function IntroCard({ t }: { t: TranslateFn }) {
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] px-[18px] py-4 flex gap-3 min-w-0">
            <ScanSearch className="w-[18px] h-[18px] shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <div className="flex flex-col gap-1.5 min-w-0">
                <p className="m-0 text-sm font-semibold text-[var(--text-primary)]">
                    {t('shield_look.intro_title', 'Before a message goes to the AI, Bee Flow reads it and looks for personal details.')}
                </p>
                <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)]">
                    {t('shield_look.intro_body', 'Anything found is hidden from the AI. This happens on your own server — nothing is sent elsewhere to be checked.')}
                </p>
            </div>
        </div>
    );
}

function ownDataSummary(count: number, t: TranslateFn): string {
    if (count === 1) return t('shield_data.detection_link_summary', '{n} type. It now lives under Your own data.', { n: count });
    if (count > 1) return t('shield_data.detection_link_summary_plural', '{n} types. They now live under Your own data.', { n: count });
    return t('shield_look.link_own_empty', 'None yet — add project codes, customer numbers and more.');
}

function neverHiddenSummary(f: DetectionFields, t: TranslateFn): string {
    const n = (f.piiAllowTerms || []).length;
    // The 221 are only claimed while the built-in list is actually on.
    return f.piiAllowPublicOrgs !== false
        ? t('shield_look.link_never_public', '221 well-known companies · {n} of your own. Matches are exact: "Shell" does not cover "Shell Advies BV".', { n })
        : t('shield_look.link_never', '{n} of your own. Matches are exact: "Shell" does not cover "Shell Advies BV".', { n });
}

export function DetectionTab({
    f, categories, readOnly, licence = {}, evidence = null, toggleToolPiiCat, onGoTo, t,
}: DetectionTabProps) {
    const toggleDetect = useCallback((id: string, on: boolean) => {
        const current = f.piiCategories || [];
        f.setPiiCategories(on ? [...new Set([...current, id])] : current.filter(x => x !== id));
    }, [f]);

    // The matrix sees and writes only the built-in kinds; see the header.
    const matrixDetect = useMemo(() => builtInOnly(f.piiCategories), [f.piiCategories]);
    const matrixTools = useMemo(() => ({
        external: { blockCategories: builtInOnly(f.toolPiiPolicy?.external?.blockCategories) },
        internal: { blockCategories: builtInOnly(f.toolPiiPolicy?.internal?.blockCategories) },
    }), [f.toolPiiPolicy]);
    const setDetect = (ids: string[]) => f.setPiiCategories([...ids, ...customOnly(f.piiCategories)]);
    const goToOwnData = () => onGoTo?.('owndata');

    return (
        <div className="flex flex-col gap-3.5 min-h-0">
            <div className="grid gap-3.5 grid-cols-1 @min-[960px]/pane:grid-cols-[minmax(0,1fr)_minmax(0,560px)] @min-[1280px]/pane:grid-cols-[minmax(0,1fr)_minmax(0,620px)]">
                <IntroCard t={t} />
                <StrictnessCard
                    value={f.piiConfidenceThreshold}
                    onChange={f.setPiiConfidenceThreshold}
                    readOnly={readOnly}
                    t={t}
                />
            </div>

            <CategoryMatrix
                categories={categories}
                detect={matrixDetect}
                toolPolicy={matrixTools}
                canBlockExternal={licence.canUseWebSearchGuard !== false}
                allowPublicOrgs={f.piiAllowPublicOrgs !== false}
                readOnly={readOnly}
                toolKinds={evidence ? evidence.toolKinds : null}
                days={evidence?.days}
                onToggleDetect={toggleDetect}
                onSetDetect={setDetect}
                onToggleTool={toggleToolPiiCat}
                t={t}
            />

            {/* Both are edited on "Your own data". The never-hidden list is
                the one control that makes the shield leak by design, so it
                sits last, as a summary, rather than as an editor here. */}
            <div className="grid gap-3.5 grid-cols-1 @min-[720px]/pane:grid-cols-2">
                <ShieldLinkCard
                    Icon={Tags}
                    title={t('shield_data.detection_link_title', 'Your own words and patterns')}
                    summary={ownDataSummary((f.customDataTypes || []).length, t)}
                    onOpen={goToOwnData}
                />
                <ShieldLinkCard
                    Icon={Eye}
                    title={t('admin.shield_posture_allowlist', 'Never hidden')}
                    summary={neverHiddenSummary(f, t)}
                    onOpen={goToOwnData}
                />
            </div>
        </div>
    );
}

export default DetectionTab;
