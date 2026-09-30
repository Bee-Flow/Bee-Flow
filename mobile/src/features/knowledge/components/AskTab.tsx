/**
 * "Test question" — the web's TestQuestionCard: ask the base something and
 * see which passages it finds before an agent relies on it. The passages come
 * first, then the answer as it streams. Nothing found is a result, and is
 * said as one: the sources here do not cover the question yet.
 */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { BlockList, type Block } from '@/shared/patterns';
import { Banner, Button, Card, Text, TextField } from '@/shared/ui';

import { useKbAsk, type AskState } from '../hooks/useKbAsk';

function resultBlocks(t: TranslateFn, state: AskState): Block[] {
    const blocks: Block[] = [];
    if (state.error !== null) {
        blocks.push({ key: 'error', gap: 'inner', render: () => <Banner tone="warning">{state.error || t('knowledge.ask.err', 'Something went wrong while answering.')}</Banner> });
    }
    const sources = state.sources;
    if (sources && sources.length === 0) {
        blocks.push({ key: 'none', gap: 'section', render: () => (
            <Text variant="caption" tone="tertiary">
                {t('knowledge.ask.nothing_found', 'Nothing in this knowledge base matched that question. That is a result: the sources here do not cover it yet.')}
            </Text>
        ) });
    }
    if (state.answer) {
        blocks.push({ key: 'answer', gap: 'section', render: () => <Card><Text variant="body">{state.answer}</Text></Card> });
    }
    if (sources && sources.length > 0) {
        blocks.push({ key: 'passages', gap: 'section', render: () => (
            <Text variant="subheading">{t('knowledge.ask.passages', 'Passages found ({n})', { n: sources.length })}</Text>
        ) });
        sources.forEach((s, i) => blocks.push({ key: `p:${s.chunkId ?? s.id ?? i}`, gap: 'inner', render: () => (
            <Card>
                <Text variant="caption" weight="semibold">{[s.title, s.section, s.page ? t('mobile.knowledge.page', 'p. {page}', { page: s.page }) : null].filter(Boolean).join(' · ')}</Text>
                <Text variant="caption" tone="secondary" numberOfLines={6}>{s.snippet ?? ''}</Text>
            </Card>
        ) }));
    }
    return blocks;
}

export function AskTab({ kbId }: { kbId: string }) {
    const t = useTranslation();
    const [question, setQuestion] = useState('');
    const state = useKbAsk(kbId);
    const head: Block[] = [
        { key: 'hint', gap: 'section', render: () => (
            <Text variant="caption" tone="tertiary">
                {t('knowledge.ask.hint', 'This is how you check the right source is found, before an agent uses it.')}
            </Text>
        ) },
        { key: 'form', gap: 'inner', render: () => (
            <>
                <TextField label={t('knowledge.ask.label', 'Ask this knowledge base a question')} value={question} onChangeText={setQuestion}
                    placeholder={t('knowledge.ask.placeholder', 'e.g. How long is a quote valid?')} multiline maxLines={4} />
                <Button iconName="Send" label={t('knowledge.ask.submit', 'Ask')} loading={state.asking} disabled={!question.trim()}
                    onPress={() => void state.ask(question.trim())} testID="kb-ask" />
            </>
        ) },
    ];
    return <BlockList blocks={[...head, ...resultBlocks(t, state)]} refreshing={false} onRefresh={() => undefined} testID="kb-ask-tab" />;
}
