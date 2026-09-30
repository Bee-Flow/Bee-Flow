/**
 * Conversation details — everything about a chat that is not the chat.
 *
 * Reached from the title and the overflow button on the chat screen. A screen
 * rather than a sheet because there are six independent things here and a
 * bottom sheet that scrolls is a sheet pretending to be a screen.
 *
 * Rename, pin and labels are ONE endpoint: `PATCH /ai/direct/conversations/:id`
 * applies whichever of `{ title, pinned, labels }` are present
 * (routes/ai/directChat/conversationRoutes.js), so each control sends only its
 * own field and they never fight over each other's values. The sections each
 * say what else they rest on; the reads and writes are useChatDetails.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { RefreshControl, ScrollView } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Banner, Divider, EmptyState, ErrorState, LoadingState, Spacer } from '@/shared/ui';

import { DangerZone } from '../components/details/DangerZone';
import { DetailsFrame } from '../components/details/DetailsFrame';
import { LabelsSection } from '../components/details/LabelsSection';
import { NameSection } from '../components/details/NameSection';
import { PinCard } from '../components/details/PinCard';
import { ProjectSection } from '../components/details/ProjectSection';
import { SessionSkillsSection } from '../components/details/SessionSkillsSection';
import { TranscriptSection } from '../components/details/TranscriptSection';
import { useChatDetails } from '../hooks/useChatDetails';

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
});

export function ChatDetailsScreen({ id }: { id: string | undefined }) {
    const conversationId = id ?? '';
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const details = useChatDetails(conversationId);
    const { conversationQuery, labelsQuery, projectsQuery, conversation, failure } = details;
    const heading = t('mobile.chat.details.title', 'Details');
    // The person's pull only; above the early returns, as hooks must be.
    const refresh = useUserRefresh(() => Promise.all([conversationQuery.refetch(), labelsQuery.refetch(), projectsQuery.refetch()]));

    if (!conversationId || conversationId === 'new') {
        return (
            <DetailsFrame title={heading}>
                <EmptyState
                    icon="MessageSquare"
                    title={t('mobile.chat.details.empty_title', 'Nothing to show yet')}
                    message={t(
                        'mobile.chat.details.empty_message',
                        'Send a message first — a chat gets a name, labels and a project once it exists on the server.',
                    )}
                    actionLabel={t('mobile.chat.details.back_to_chat', 'Back to the chat')}
                    onAction={() => router.back()}
                />
            </DetailsFrame>
        );
    }

    if (conversationQuery.isLoading) {
        return (
            <DetailsFrame title={heading}>
                <LoadingState label={t('mobile.chat.details.loading', 'Loading this conversation')} />
            </DetailsFrame>
        );
    }

    if (conversationQuery.isError || !conversation) {
        return (
            <DetailsFrame title={heading}>
                <ErrorState error={conversationQuery.error} onRetry={() => void conversationQuery.refetch()} />
            </DetailsFrame>
        );
    }

    return (
        <DetailsFrame title={conversation.title || t('sidebar.untitled_chat', 'Untitled Chat')} busy={details.patch.isPending} avoidKeyboard>
            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                refreshControl={
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {failure ? (
                    <Banner tone="error">{`${describeError(failure).title}. ${describeError(failure).message}`}</Banner>
                ) : null}
                <NameSection details={details} />
                <PinCard details={details} />
                <LabelsSection details={details} />
                <ProjectSection details={details} />
                <SessionSkillsSection details={details} />
                <TranscriptSection conversation={conversation} />
                <Spacer />
                <Divider />
                <DangerZone details={details} />
            </ScrollView>
        </DetailsFrame>
    );
}
