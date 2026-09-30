/**
 * "Edit with AI": the refine conversation over the chat composer.
 *
 * The composer is chat's own, with its tier dial as the web's refine rail has
 * one (the tier the ASSISTANT thinks with — it does not change the agent's
 * model). Files cannot be read here: the refine endpoint takes words only, so
 * attaching one says so instead of silently dropping it.
 *
 * `initial` is the first ask handed over by "Create with AI"; it is sent once,
 * on mount, as the web's builder fires its `initialRefinement`.
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useRefine } from '@/features/agents/hooks/useRefine';
import type { AgentDetail } from '@/features/agents/model/draft';
import { Composer, type Attachment, type ComposerSettings } from '@/features/chat';
import { Text, useToast } from '@/shared/ui';

import { RefineEmpty } from './RefineEmpty';
import { RefineTranscript } from './RefineTranscript';

const DEFAULT_SETTINGS: ComposerSettings = {
    modelTier: 'fast',
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: false,
};

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ disclaimer: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

export function RefineChat({ agent, initial }: { agent: AgentDetail; initial?: string }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const styles = useThemedStyles(makeStyles);
    const chat = useRefine(agent);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    // A suggestion fills the composer, as on the web; the key re-seeds it.
    const [seed, setSeed] = useState('');
    const fired = useRef(false);

    const send = (text: string, attachments: Attachment[] = []) => {
        if (attachments.length > 0) toast(t('mobile.agents.refine.no_files', 'Files are not read here — describe the change in words.'));
        void chat.refine(text, settings.modelTier);
    };

    useEffect(() => {
        if (fired.current || !chat.ready || !initial?.trim()) return;
        fired.current = true;
        void chat.refine(initial, DEFAULT_SETTINGS.modelTier);
    });

    return (
        <>
            {chat.turns.length === 0 && !chat.busy ? (
                <RefineEmpty onPick={setSeed} />
            ) : (
                <RefineTranscript
                    turns={chat.turns}
                    busy={chat.busy}
                    onTest={() => router.push(`/agents/${agent.id}?c=new`)}
                    onUndo={(index, versionId) => void chat.undo(index, versionId)}
                />
            )}
            <Composer
                key={seed}
                initialText={seed}
                onSend={send}
                onStop={() => undefined}
                streaming={false}
                settings={settings}
                onSettingsChange={setSettings}
                tiers={chat.tiers ?? {}}
                sources={false}
                placeholder={t('agent_wizard.builder.chat_placeholder', 'Ask me to change anything about this agent')}
                disabledReason={chat.busy ? t('agent_wizard.builder.updating', 'Updating…') : null}
            />
            <Text variant="caption" tone="tertiary" center style={styles.disclaimer}>
                {t('agent_studio.refine.ai_disclaimer', 'AI can make mistakes. Please verify important information.')}
            </Text>
        </>
    );
}
