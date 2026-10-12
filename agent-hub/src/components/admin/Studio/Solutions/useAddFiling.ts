import React, { useState } from 'react';
import { keyOf } from './AddKindList';
import { attachItem, type AddItem, type KindLoad } from './addPartsSources';
import { comingAlong, type RelatedState } from './relatedParts';
import { partLabel, whyText } from './relatedText';
import { useTranslation } from '../../../../hooks/useTranslation';
import { projectErrorText } from '../../../projects/workspace/projectErrorText';

/**
 * Files the ticked items and what they need, one PUT each, and says what
 * happened: what was added, what came along (and why), what was refused in
 * the server's own words.
 *
 * Order: the related parts first, dependencies before what needs them, then
 * the ticked items. A refusal stops nothing else: the next one is still tried.
 * What went in leaves the lists, so a part that came along is not offered
 * again as a free one.
 */

export interface Failure { key: string; label: string; reason: string }
export interface Filed { key: string; label: string }
export interface CameAlong extends Filed { why: string }

export interface AddOutcome {
    added: Filed[];
    cameAlong: CameAlong[];
    failures: Failure[];
    /** Everything attempted: the ticked items plus what came along. */
    total: number;
}

interface FilingInput {
    projectId: string;
    loads: Record<string, KindLoad>;
    picked: Set<string>;
    related: RelatedState;
    setPicked: React.Dispatch<React.SetStateAction<Set<string>>>;
    drop: (keys: Set<string>) => void;
    onAdded?: () => void;
}

interface Step { kind: string; id: string; label: string; why: string | null }

export function useAddFiling({ projectId, loads, picked, related, setPicked, drop, onAdded }: FilingInput) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<AddOutcome | null>(null);

    const add = async () => {
        const chosen: AddItem[] = [];
        for (const l of Object.values(loads)) {
            if (l.status === 'ok') chosen.push(...l.items.filter(i => picked.has(keyOf(i))));
        }
        if (chosen.length === 0 || busy) return;
        const steps: Step[] = comingAlong(related)
            .filter(p => !picked.has(keyOf(p)))
            .map(p => ({ kind: p.kind, id: p.id, label: partLabel(t, p), why: whyText(t, p) }));
        steps.push(...chosen.map(i => ({ kind: i.kind, id: i.id, label: i.label, why: null })));

        setBusy(true);
        setOutcome(null);
        const done = new Set<string>();
        const outcomeNow: AddOutcome = { added: [], cameAlong: [], failures: [], total: steps.length };
        for (const step of steps) {
            const key = keyOf(step);
            const res = await attachItem(projectId, step.kind, step.id);
            if (!res.ok) {
                outcomeNow.failures.push({ key, label: step.label, reason: projectErrorText(t, res.body, t('solutions.add_failed', 'That could not be added.')) });
                continue;
            }
            done.add(key);
            if (step.why) outcomeNow.cameAlong.push({ key, label: step.label, why: step.why });
            else outcomeNow.added.push({ key, label: step.label });
        }
        drop(done);
        setPicked(prev => new Set([...prev].filter(k => !done.has(k))));
        setOutcome(outcomeNow);
        setBusy(false);
        if (done.size > 0) onAdded?.();
    };

    return { add, busy, outcome };
}
