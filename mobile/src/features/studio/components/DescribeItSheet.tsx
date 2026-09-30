/**
 * "Describe it — AI picks the building blocks" — the web's DescribeItPanel
 * (Studio/studioAi) as a bottom sheet, opened from the New menu's AI row.
 * Three states and nothing in between:
 *
 *   1. EMPTY  the field with the web's example sentence; "Show the plan" is
 *             off while there is nothing to send.
 *   2. BUSY   the field stays readable (you can reread what you asked) but
 *             not editable, and Cancel really aborts the request.
 *   3. PLAN   the card (DescribeItPlanCard), "Make this" — which opens the
 *             kind's NATIVE create flow, through the same door as its
 *             New-menu item — and "Something else", back to the field with
 *             the words still in it.
 *
 * An answer without a kind is never a guess: it is one sentence saying why —
 * nothing here you may build, could not find out, or not clear enough
 * (model/describeIt.ts). The host mounts a fresh sheet per opening (a `key`),
 * so every opening starts empty.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Sheet, Text, TextField } from '@/shared/ui';

import { DescribeItPlanCard } from './DescribeItPlanCard';
import { useRouteDescription } from '../hooks/mutations';
import { useOpenTarget } from '../hooks/useOpenTarget';
import { doorForKind, noKindProblem, planOf, problemText, routeProblem } from '../model/describeIt';
import type { ResolvedSection } from '../model/types';

export interface DescribeItSheetProps {
    visible: boolean;
    onClose: () => void;
    /** What the New menu is built from: the sections this person may open, and the locked ones. */
    sections: readonly ResolvedSection[];
}

export function DescribeItSheet({ visible, onClose, sections }: DescribeItSheetProps) {
    const t = useTranslation();
    const open = useOpenTarget();
    const [text, setText] = useState('');
    const describe = useRouteDescription();
    const busy = describe.isPending;
    const answer = describe.data;
    const plan = answer ? planOf(answer, text) : null;
    const door = plan ? doorForKind(plan.kind, sections, plan.available) : null;
    const problem = describe.error ? routeProblem(describe.error) : answer && !plan ? noKindProblem(answer) : null;
    const submit = () => {
        if (text.trim() && !busy) describe.mutate(text);
    };
    const make = () => {
        if (door?.state !== 'open') return;
        onClose();
        open(door.target);
    };

    const footer = plan ? (
        <>
            <Button
                label={t('studio.ai.create', 'Make this')}
                onPress={make}
                disabled={door?.state !== 'open'}
                fullWidth
                size="lg"
                testID="studio-ai-create"
            />
            <Button label={t('studio.ai.other', 'Something else')} onPress={describe.reset} variant="ghost" fullWidth testID="studio-ai-other" />
        </>
    ) : (
        <>
            <Button
                label={t('studio.ai.submit', 'Show the plan')}
                onPress={submit}
                disabled={!text.trim()}
                loading={busy}
                fullWidth
                size="lg"
                testID="studio-ai-submit"
            />
            {busy ? (
                <Button label={t('studio.ai.cancel', 'Cancel')} onPress={describe.cancel} variant="ghost" fullWidth testID="studio-ai-cancel" />
            ) : null}
        </>
    );

    return (
        <Sheet visible={visible} onClose={onClose} title={t('studio.ai.title', 'Build with AI')} footer={footer}>
            {plan && door ? (
                <DescribeItPlanCard plan={plan} door={door} />
            ) : (
                <>
                    <TextField
                        label={t('studio.ai.describe_title', 'Describe what you want')}
                        value={text}
                        onChangeText={setText}
                        multiline
                        editable={!busy}
                        placeholder={t('studio.ai.placeholder', 'an agent that answers questions about our quotes, with the Quotes table as its knowledge')}
                        hint={t('studio.ai.hint', 'The AI picks the building blocks and shows you the plan first.')}
                        error={problem ? problemText(problem, t) : null}
                        testID="studio-ai-input"
                    />
                    {busy ? (
                        <Text testID="studio-ai-busy" variant="caption" tone="secondary" accessibilityLiveRegion="polite">
                            {t('studio.ai.busy', 'Reading your description…')}
                        </Text>
                    ) : null}
                </>
            )}
        </Sheet>
    );
}
