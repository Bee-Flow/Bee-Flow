/**
 * "Test" — one question through the steps (the web's TestTab). The answer is
 * shown first and the verdict after, so a person reads what the agent said
 * before being told what a grader thought of it. Everything green here comes
 * off a run the server graded and stored; a failed history read, a refusal
 * and a cut stream each say so instead of rendering "not tested".
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { ApiError } from '@/core/api/client';
import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { openRoute } from '@/shared/navigation';
import { BlockList, useUserRefresh, type Block } from '@/shared/patterns';
import { Banner, Button, Card, Text } from '@/shared/ui';

import { FacetHead } from './FacetHead';
import { TestForm } from './TestForm';
import { TestResultRow } from './TestResultRow';
import { useTestAgents, useTestRuns } from '../hooks/queries';
import { useSkillTest, type SkillTestState } from '../hooks/useSkillTest';
import { adviceRef, refHref } from '../model/testRun';
import type { SkillStep, TestRun } from '../model/types';

function verdictBlocks(t: TranslateFn, state: SkillTestState, steps: readonly SkillStep[], open: (href: string) => void): Block[] {
    const blocks: Block[] = [];
    if (state.error) blocks.push({ key: 'error', gap: 'inner', render: () => <Banner tone="warning">{state.error}</Banner> });
    if (state.kbNotice) {
        const { used, declared } = state.kbNotice;
        blocks.push({ key: 'kb', gap: 'inner', render: () => (
            <Text variant="caption" tone="warning">
                {t('skills_studio.test.kb_dropped', 'Not every knowledge base this skill links is available to you: {used} of {declared} were searched.', { used, declared })}
            </Text>
        ) });
    }
    if (state.answer) {
        blocks.push({ key: 'answer', gap: 'section', render: () => (
            <Card testID="skill-test-answer">
                <Text variant="label" tone="tertiary">{t('skills_studio.test.answer', 'What the agent answered')}</Text>
                <Text variant="body">{state.answer}</Text>
            </Card>
        ) });
    }
    const run = state.run;
    if (!run || run.results.length === 0) return blocks;
    blocks.push({ key: 'per-step', gap: 'section', render: () => <Text variant="subheading">{t('skills_studio.test.per_step', 'Per step')}</Text> });
    run.results.forEach((r, i) => blocks.push({ key: `r:${r.stepId || i}`, gap: 'inner', render: () => (
        <TestResultRow title={`${i + 1}. ${r.title}`} detail={r.evidence} status={r.status} />
    ) }));
    const ref = adviceRef(run, steps);
    const href = ref ? refHref(ref) : null;
    blocks.push({ key: 'advice', gap: 'inner', render: () => (
        <>
            <Text variant="caption" testID="skill-test-advice">
                {`${t('skills_studio.test.advice_label', 'Advice')}: ${run.advice || t('skills_studio.test.no_advice', 'no advice')}`}
            </Text>
            {href ? <Button size="sm" variant="ghost" label={t('skills_studio.test.open_ref', 'Open what this step uses')} onPress={() => open(href)} /> : null}
        </>
    ) });
    return blocks;
}

function historyBlocks(t: TranslateFn, runs: ReturnType<typeof useTestRuns>, forbidden: boolean): Block[] {
    const blocks: Block[] = [{ key: 'history', gap: 'section', render: () => <Text variant="subheading">{t('skills_studio.test.history', 'Earlier runs')}</Text> }];
    let note: string | null = null;
    if (runs.isLoading) note = t('skills_studio.examples.loading', 'Loading…');
    else if (runs.isError && !forbidden) note = t('skills_studio.test.history_failed', 'Could not load earlier runs, so the test history is unknown.');
    else if (runs.data?.length === 0) note = t('skills_studio.test.untested', 'not tested');
    if (note) blocks.push({ key: 'history-note', gap: 'inner', render: () => <Text variant="caption" tone="tertiary">{note}</Text> });
    for (const run of runs.data ?? []) {
        blocks.push({ key: `run:${run.id}`, gap: 'inner', render: () => <RunRow t={t} run={run} /> });
    }
    return blocks;
}

function RunRow({ t, run }: { t: TranslateFn; run: TestRun }) {
    const when = timeAgo(run.ranAt, { suffix: true });
    return <TestResultRow title={run.question} detail={[run.advice || t('skills_studio.test.no_advice', 'no advice'), when].filter(Boolean).join(' · ')} status={run.status === 'ok' ? 'ok' : 'warning'} />;
}

export function TestTab({ skillId, steps, readOnly }: { skillId: string; steps: readonly SkillStep[]; readOnly: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const test = useSkillTest(skillId);
    const agents = useTestAgents(!readOnly);
    const runs = useTestRuns(skillId, !readOnly);
    const refresh = useUserRefresh(() => runs.refetch());
    const forbidden = runs.error instanceof ApiError && runs.error.status === 403;
    const locked = readOnly || forbidden;
    const blocks: Block[] = [{ key: 'head', gap: 'section', render: () => (
        <FacetHead title={t('skills_studio.test.title', 'Test')} hint={t('skills_studio.test.hint', 'one question through the steps')} />
    ) }];
    if (locked) {
        blocks.push({ key: 'locked', gap: 'inner', render: () => (
            <Banner tone="info" icon="Lock">{t('skills_studio.test.read_only', 'You can see this skill but not change it, so you cannot run a test on it.')}</Banner>
        ) });
    } else {
        blocks.push({ key: 'form', gap: 'inner', render: () => (
            <TestForm agents={agents.data} agentsFailed={agents.isError} running={test.running}
                canRun={steps.length > 0 && !agents.isLoading && !test.running} onRun={(input) => void test.start(input)} />
        ) });
    }
    if (steps.length === 0) {
        blocks.push({ key: 'no-steps', gap: 'inner', render: () => <Text variant="caption" tone="tertiary">{t('skills_studio.test.no_steps', 'Add steps first — a test grades one step at a time.')}</Text> });
    }
    const all = [...blocks, ...verdictBlocks(t, test, steps, (href) => openRoute(router, href)), ...(locked ? [] : historyBlocks(t, runs, forbidden))];
    return <BlockList blocks={all} refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} testID="skill-test" />;
}
