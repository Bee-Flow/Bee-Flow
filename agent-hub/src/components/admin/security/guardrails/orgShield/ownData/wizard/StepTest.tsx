import { FlaskConical, TriangleAlert, Wand2 } from 'lucide-react';
import React from 'react';

import Button from '../../../../../../shared/Button';
import type { TestResult } from '../../../../../../../api/queries/customData';
import { customDataErrorCode, useTestMutation, useTuneMutation } from '../../../../../../../api/queries/customData';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { errorLine } from '../ownDataCopy';
import type { CustomDataType } from '../ownDataModel';
import { configFingerprint, resolveType } from '../ownDataModel';
import type { RunFindings } from '../testBench';
import {
    foundSpansOf, goldSentenceCount, summarise, wireSentences,
} from '../testBench';
import type { TuneInfo } from '../useTypeWizard';
import { isRunStale, mergeConfig } from '../useTypeWizard';
import { Note } from '../ui';
import AssistantCard from './AssistantCard';
import QualityReadout from './QualityReadout';
import SentenceList, { ADD_SENTENCE_ID } from './SentenceList';
import type { StepProps } from './stepTypes';
import { DegradedNote } from './TestSentence';
import TryOwnText from './TryOwnText';
import TuneResult from './TuneResult';

/**
 * Step 2: write or collect test sentences, mark what should be hidden, run
 * the type against them, and let Tune try other settings on the same set.
 *
 * Tests run on the server, through the same matcher production uses, so the
 * read-out is a statement about the real thing and not a browser guess.
 */

const MIN_GOLD_FOR_TUNE = 5;

function findingsOf(res: TestResult, type: CustomDataType): RunFindings {
    return {
        found: Object.fromEntries(res.results.map(r => [r.id, foundSpansOf(r.marks)])),
        fingerprint: configFingerprint(type),
        engine: res.engine,
        degraded: res.degraded,
    };
}

function TunePanel({
    goldCount, busy, disabled, onTune, info, canUndo, onUndo, error, t,
}: {
    goldCount: number; busy: boolean; disabled: boolean; onTune: () => void;
    info: TuneInfo | null; canUndo: boolean; onUndo: () => void; error: string | null; t: TranslateFn;
}) {
    const enough = goldCount >= MIN_GOLD_FOR_TUNE;
    return (
        <div className="flex flex-col gap-2">
            <span className="flex items-center gap-3 flex-wrap">
                <Button size="sm" variant="secondary" icon={Wand2} onClick={onTune} disabled={!enough || disabled} busy={busy}>
                    {t('shield_data.tune_button', 'Tune automatically')}
                </Button>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {enough
                        ? t('shield_data.tune_helper', 'We try different settings on these sentences and keep the best one.')
                        : t('shield_data.tune_needs_gold', 'Mark what should be hidden in at least 5 sentences first.')}
                </span>
            </span>
            {error && <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]">{error}</p>}
            {info && <TuneResult info={info} canUndo={canUndo} onUndo={onUndo} t={t} />}
        </div>
    );
}

export function StepTest(props: StepProps) {
    const { state, dispatch, ctx, t } = props;
    const test = useTestMutation(ctx.orgId);
    const tune = useTuneMutation(ctx.orgId);
    const { sentences } = state.tests;
    const aiBlocked = state.type.method === 'ai' && ctx.guardDown;

    const runTest = async (type: CustomDataType = state.type) => {
        if (sentences.length === 0) return;
        try {
            const res = await test.mutateAsync({ type: resolveType(type), sentences: wireSentences(sentences) });
            dispatch({ type: 'test_done', run: findingsOf(res, type) });
        } catch { /* worded below from test.error */ }
    };

    const runTune = async () => {
        const { patterns, aiLabels } = state.candidates;
        try {
            const res = await tune.mutateAsync({
                type: resolveType(state.type),
                sentences: wireSentences(sentences),
                examples: state.tests.examples,
                ...(patterns.length || aiLabels.length ? { candidates: { patterns: patterns.slice(0, 3), aiLabels: aiLabels.slice(0, 6) } } : {}),
            });
            const info: TuneInfo = {
                improved: res.improved, method: state.type.method, before: res.before.summary, after: res.best.summary, describe: res.best.describe,
            };
            dispatch({ type: 'tune_done', config: res.best.config, info });
            // Re-test with what was kept, so the marks under each sentence
            // show the tuned result rather than the one it replaced.
            if (res.improved) await runTest(mergeConfig(state.type, res.best.config));
        } catch { /* worded below from tune.error */ }
    };

    const focusAdd = () => document.querySelector<HTMLInputElement>(`#${ADD_SENTENCE_ID} input`)?.focus();
    const summary = summarise(sentences, state.run);

    return (
        <div className="flex flex-col gap-4 max-w-4xl">
            <AssistantCard {...props} onWriteOwn={focusAdd} />
            <SentenceList state={state} dispatch={dispatch} t={t} />
            {aiBlocked && (
                <Note Icon={TriangleAlert} tone="warn" role="status">
                    {t('shield_data.test_ai_guard_down', "AI recognition can't be tested while the detection service is not running.")}
                </Note>
            )}
            <span className="flex items-center gap-3 flex-wrap">
                <Button size="sm" icon={FlaskConical} onClick={() => runTest()} disabled={sentences.length === 0 || aiBlocked} busy={test.isPending}>
                    {t('shield_data.test_button', 'Test')}
                </Button>
                {test.error && <span role="alert" className="text-[11px] text-[var(--error-ink)]">{errorLine(customDataErrorCode(test.error), t)}</span>}
            </span>
            {state.run?.degraded && <DegradedNote t={t} />}
            {state.run && <QualityReadout summary={summary} stale={isRunStale(state)} t={t} />}
            <TunePanel
                goldCount={goldSentenceCount(sentences)}
                busy={tune.isPending}
                disabled={aiBlocked}
                onTune={runTune}
                info={state.tune}
                canUndo={!!state.tuneUndo}
                onUndo={() => dispatch({ type: 'undo_tune' })}
                error={tune.error ? errorLine(customDataErrorCode(tune.error), t) : null}
                t={t}
            />
            <TryOwnText {...props} />
        </div>
    );
}

export default StepTest;
