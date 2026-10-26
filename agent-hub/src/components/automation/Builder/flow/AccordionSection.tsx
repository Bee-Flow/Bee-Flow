import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import CollapsibleSection from './CollapsibleSection';
import { hiddenInSimple, resolveMode, useFormDensity } from './settings/formDensity';
import scopedStorage from '@/utils/scopedStorage';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

interface AccordionSectionProps {
    stepType: string;
    sectionKey: string;
    title?: ReactNode;
    defaultOpen?: boolean;
    forceOpen?: boolean;
    badge?: ReactNode;
    meta?: ReactNode;
    hasContent?: boolean;
    errorCount?: number;
    children?: ReactNode;
}

/**
 * Inspector accordion section. Thin wrapper over CollapsibleSection that
 * groups a step type's fields into a named, collapsible block and adds:
 *   - the persistKey scheme `inspector.<stepType>.<sectionKey>` (per-user,
 *     via scopedStorage key `collapse.inspector.<type>.<key>`),
 *   - a `defaultOpen` seed (primary/has-content sections open by default),
 *   - `forceOpen` — when a validation error targets a field in this section
 *     it opens so the error is always reachable.
 *
 * Force-open never writes the persisted preference: once the error clears,
 * the user's own collapsed/expanded choice returns. Sections are
 * independent (multiple may be open at once), matching the existing
 * CollapsibleSection behaviour the AI step already relies on.
 *
 * VISIBILITY is decided by the resolved form MODE (Simple / All options —
 * formDensity.resolveMode), not by density alone: the user's persisted choice
 * wins, and with no choice the gesture decides exactly as before. In Simple,
 * a section is left out when the step type's `simpleSections` (nodeDefs.js)
 * excludes it — UNLESS it holds a validation error (`forceOpen`) or the user
 * has already configured it (`hasContent`): hiding a thing that is switched
 * on reads as data loss.
 *
 * ADVANCED (`sectionKey === 'advanced'`) is not a collapsible block any more:
 * the header's Simple / Advanced switch is the one control. In Simple its
 * block is left out entirely (a validation error inside it still shows it);
 * in Advanced its settings are shown inline, without a band or toggle.
 */
export default function AccordionSection({
    stepType,
    sectionKey,
    title,
    defaultOpen = false,
    forceOpen = false,
    badge = null,
    // Rendered beside the title on the band, outside the toggle button (a
    // FieldHint, a count chip). Never plain text: the button's textContent is
    // how tests locate a section.
    meta = null,
    // This section already carries user configuration. Never hidden in
    // Simple, and badged "set" there so it is obvious WHY it stayed.
    hasContent = false,
    // Validation errors inside this section — a red count chip on the band.
    errorCount = 0,
    children,
}: AccordionSectionProps) {
    const storageKey = `collapse.inspector.${stepType}.${sectionKey}`;
    const isAdvanced = sectionKey === 'advanced';
    const [open, setOpen] = useState(() => {
        if (forceOpen) return true; // an error is present on first mount
        if (isAdvanced) return false;
        const v = scopedStorage.getItem(storageKey);
        if (v === '1') return true;
        if (v === '0') return false;
        return defaultOpen;
    });

    // Force open only on the false→true transition, so the user can still
    // collapse the section afterwards while the error persists.
    useAdjustOnChange([forceOpen], ([wasForced]) => { if (forceOpen && !wasForced) setOpen(true); });

    const ctx = useFormDensity();
    const mode = resolveMode(ctx);
    const { onHiddenSection, onShownSection } = ctx;
    // Advanced is the MODE now, not a second button: in Simple its block is
    // left out (unless an error sits in it), in Advanced it is simply there.
    const hidden = isAdvanced
        ? mode === 'simple' && !forceOpen
        : mode === 'simple' && hiddenInSimple(stepType, sectionKey) && !forceOpen && !hasContent;

    // Report both directions so the host's "Show all options (N)" count can
    // go down as well as up. A visible section's report is a harmless no-op
    // for hosts that only track hidden ones.
    useEffect(() => {
        if (hidden) onHiddenSection?.(sectionKey);
        else onShownSection?.(sectionKey);
    }, [hidden, sectionKey, onHiddenSection, onShownSection]);

    // A section REVEALED because the author pressed "Show all options" opens —
    // revealing it still collapsed would make the switch look like it did
    // nothing. Only that: a section that appears because it now HOLDS
    // something (the builder set a forEach after a connect) stays closed, and
    // Advanced never opens this way. Never written to the persisted preference.
    useAdjustOnChange([hidden, mode] as const, ([wasHidden, prevMode]) => {
        const switchedToAll = prevMode === 'simple' && mode !== 'simple';
        if (wasHidden && !hidden && !forceOpen && switchedToAll && !isAdvanced) setOpen(true);
    });

    if (hidden) return null;
    // No band, no toggle: the Simple / Advanced switch in the header already
    // decided that these settings are wanted. Errors still show their count.
    if (isAdvanced) {
        return (
            <div className="pt-2 space-y-2" data-section-key={sectionKey}>
                {errorCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 tabular-nums">
                        {errorCount}
                    </span>
                )}
                {children}
            </div>
        );
    }

    const onToggle = (next: boolean) => {
        setOpen(next);
        scopedStorage.setItem(storageKey, next ? '1' : '0');
    };

    const errorChip = errorCount > 0 ? (
        <span
            title={`${errorCount} problem${errorCount === 1 ? '' : 's'} in this section`}
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 tabular-nums"
        >
            {errorCount}
        </span>
    ) : null;

    // Inputs are what the step is FOR: a plain heading, never folded away.
    const isInputs = sectionKey === 'inputs';
    return (
        <CollapsibleSection
            variant={isInputs ? 'static' : (isAdvanced ? 'quiet' : 'section')}
            title={title}
            open={isInputs || open}
            onToggle={onToggle}
            // In Simple, say WHY a normally-hidden section is still here.
            badge={badge ?? (hasContent && ((mode === 'simple' && hiddenInSimple(stepType, sectionKey)) || (isAdvanced && !open)) ? 'set' : null)}
            meta={errorChip || meta ? <>{errorChip}{meta}</> : null}
        >
            {children}
        </CollapsibleSection>
    );
}
