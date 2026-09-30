/**
 * "Ask AI" — the web builder's assistant panel (Builder/chat/*) as a tall
 * sheet over the build screen: the conversation this routine has had with
 * the builder (restored from its session), the turn streaming now, and the
 * composer. The flow changes behind the sheet as the drafts arrive; edits
 * are paused meanwhile, and one undo takes a whole turn back.
 *
 * Before the first message it offers three suggestions that fill the
 * composer (never send), the first one fitting the routine's trigger.
 */

import React, { createContext, useContext, useRef } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { BuilderMessage } from '@/features/flow-editor/api';
import { useBuilderSession, useDraftState, type FlowDraft } from '@/features/flow-editor/hooks';
import { useTurn } from '@/shared/stream';
import { Chip, EmptyState, Sheet } from '@/shared/ui';

import type { AppLabel } from './activity';
import { AiComposer } from './AiComposer';
import { AiMessage } from './AiMessage';
import { LiveTurn } from './LiveTurn';
import { PlanCard } from './PlanCard';
import { SummaryCard } from './SummaryCard';
import { messageActivity, planOf } from './turnModel';
import type { Assistant } from './useAssistant';
import { welcomeSuggestions } from './welcome';

const makeStyles = (theme: Theme) => ({
    list: { paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.md } satisfies ViewStyle,
    chips: { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg } satisfies ViewStyle,
});

const AppLabels = createContext<AppLabel | undefined>(undefined);

function Message({ message }: { message: BuilderMessage }) {
    const t = useTranslation();
    const appLabel = useContext(AppLabels);
    return <AiMessage role={message.role} content={message.content} activity={messageActivity(message, t, appLabel)} />;
}
const renderMessage: ListRenderItem<BuilderMessage> = ({ item }) => <Message message={item} />;
const keyOf = (_m: BuilderMessage, index: number) => String(index);

function Welcome({ triggerKind, onPick }: { triggerKind: string | null; onPick: (text: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View>
            <EmptyState
                icon="Sparkles"
                title={t('mobile.flow.ai.welcome', 'Build with the assistant')}
                message={t('mobile.flow.ai.welcome_hint', 'Describe what you want and it wires the trigger and steps for you.')}
            />
            <View style={styles.chips}>
                {welcomeSuggestions(triggerKind, t).map((s) => (
                    <Chip key={s} label={s} onPress={() => onPick(s)} />
                ))}
            </View>
        </View>
    );
}

export interface AiBuilderSheetProps {
    assistant: Assistant;
    draft: FlowDraft;
    onFindings: () => void;
    appLabel?: AppLabel;
}

export function AiBuilderSheet({ assistant, draft, onFindings, appLabel }: AiBuilderSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const list = useRef<FlatList<BuilderMessage>>(null);
    const { ai } = assistant;
    const automationId = useDraftState(draft.store, (s) => s.automationId);
    const triggerKind = useDraftState(draft.store, (s) => s.definition?.trigger?.kind ?? null);
    const snapshot = useBuilderSession(automationId).data ?? null;
    const liveTodos = useTurn(ai.turn, (s) => s.todos);
    const todos = planOf(liveTodos, snapshot);
    const header = (
        <>
            <SummaryCard summary={snapshot?.summary ?? ''} />
            <PlanCard todos={todos} />
        </>
    );
    return (
        <Sheet
            visible={assistant.open}
            onClose={() => assistant.setOpen(false)}
            title={t('mobile.flow.ai.title', 'Ask AI')}
            subtitle={ai.streaming ? t('routines.builder.act.building', 'Building') : undefined}
            scroll={false}
            tall
            footer={
                <AiComposer
                    text={assistant.text}
                    onText={assistant.setText}
                    tier={assistant.tier}
                    onTier={assistant.setTier}
                    streaming={ai.streaming}
                    onSend={() => assistant.send()}
                    onStop={ai.stop}
                />
            }
        >
            <AppLabels.Provider value={appLabel}>
                <FlatList
                    ref={list}
                    data={ai.transcript}
                    renderItem={renderMessage}
                    keyExtractor={keyOf}
                    ListHeaderComponent={header}
                    ListEmptyComponent={ai.streaming ? null : <Welcome triggerKind={triggerKind} onPick={assistant.setText} />}
                    ListFooterComponent={<LiveTurn turn={ai.turn} streaming={ai.streaming} store={draft.store} onFindings={onFindings} appLabel={appLabel} />}
                    onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.list}
                    testID="ai-transcript"
                />
            </AppLabels.Provider>
        </Sheet>
    );
}
