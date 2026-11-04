import { useEffect, useEffectEvent, useState } from 'react';
import { takeSeedEntry } from '../admin/Studio/studioAi/handoff';
import type { DesignerState } from './useDesignerShell';

/**
 * Studio "Describe it" (studioAi/handoff.ts): the brief and its name wait in
 * the seed channel and the URL says studio/automations/new. Opens a NEW
 * builder that sends the brief at once, so the person lands on the assistant
 * at work instead of an empty canvas. Called after the routing hook, whose
 * effect closes any editor for a bare list URL; only once automations are
 * allowed, or the brief would be taken and dropped. While that build is the
 * open one it returns the title for the draft its first send creates (null
 * when the brief has no name) and the work mode it opens in: 'describe', so
 * the assistant asks, plans and builds after the person's OK.
 */
export default function useDescribedBrief(initialTaskId: string | null, automationsAllowed: boolean, designer: DesignerState) {
    const [brief, setBrief] = useState<{ seed: string; name: string } | null>(null);
    const openDescribedBrief = useEffectEvent(() => {
        if (initialTaskId !== 'new' || !automationsAllowed) return;
        const entry = takeSeedEntry('automation');
        if (!entry) return;
        designer.onPlus();
        designer.setAutoSendInput(entry.seed);
        setBrief(entry);
    });
    useEffect(() => { openDescribedBrief(); }, [initialTaskId, automationsAllowed]);
    // Another New, or another automation, clears the auto-send input or sets an id.
    const ours = !!brief && designer.builderAutomationId === '' && designer.autoSendInput === brief.seed;
    return {
        seedMetadata: ours && brief?.name ? { title: brief.name } : null,
        initialWorkMode: ours ? 'describe' : null,
    };
}
