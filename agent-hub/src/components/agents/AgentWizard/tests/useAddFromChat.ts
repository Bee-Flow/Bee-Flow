import { useCallback, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type SuggestedTestForm from './SuggestedTestForm';
import { REFUSAL } from './testSetFacts';
import type { Refusal } from './testSetFacts';
import type { TestChatTurn } from './testChatTurn';
import type { TranslateFn } from '@/hooks/useTranslation';

type FormProps = ComponentProps<typeof SuggestedTestForm>;
type Suggestion = NonNullable<FormProps['suggestion']>;
type Draft = Parameters<NonNullable<FormProps['onSave']>>[0];

/** The part of useAgentTests this flow needs, so it can be tested without a network. */
interface TestSetApi {
    suggest: (turn: TestChatTurn) => Promise<{ suggestion: Suggestion | null; refusal: Refusal | null }>;
    createTest: (test: Draft) => Promise<{ test: unknown; refusal: Refusal | null }>;
}

/**
 * "This conversation as a test": ask the server for a proposal for one turn, show it in
 * SuggestedTestForm, and only a press on Save creates the test. Nothing is stored before that.
 */
export default function useAddFromChat({ t, testSet }: { t: TranslateFn; testSet: TestSetApi }) {
    const [turn, setTurn] = useState<TestChatTurn | null>(null);
    const [state, setState] = useState<'loading' | 'ready'>('loading');
    const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    // Closing while a request is on its way must not reopen the form when it answers.
    const ticket = useRef(0);

    const open = useCallback(async (picked: TestChatTurn) => {
        const mine = ++ticket.current;
        setTurn(picked);
        setState('loading');
        setSuggestion(null);
        setRefusal(null);
        setSaveError(null);
        const out = await testSet.suggest(picked);
        if (ticket.current !== mine) return;
        setSuggestion(out.suggestion);
        setRefusal(out.refusal);
        setState('ready');
    }, [testSet]);

    const close = useCallback(() => {
        ticket.current += 1;
        setTurn(null);
        setSaving(false);
    }, []);

    const save = useCallback(async (draft: Draft) => {
        const mine = ticket.current;
        setSaving(true);
        setSaveError(null);
        const out = await testSet.createTest(draft);
        if (ticket.current !== mine) return;
        setSaving(false);
        if (out.test) {
            close();
            return;
        }
        setSaveError(out.refusal?.kind === REFUSAL.TOO_MANY
            ? t('agent_studio.test.refused_too_many', 'This agent already holds as many tests as it can.')
            : t('agent_studio.test.save_failed', 'Could not save this test.'));
    }, [testSet, close, t]);

    return { turn, state, suggestion, refusal, saving, saveError, open, close, save };
}
