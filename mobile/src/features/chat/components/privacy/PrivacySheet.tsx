/**
 * What the Privacy Shield did on this turn (the web's PrivacyPanel.jsx): the
 * action and where the prompt went, what it found, per attachment, a
 * sentence that claims only what it can back, and — when the org opted in —
 * the raw payloads: the original question, what was sent, the token map and
 * what came back.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { aiReturnedText, categoryList, privacyActionOf, privacyBadgeOf } from '@/features/chat/model/privacyPanel';
import type { ChatMessage, TokenisationInfo } from '@/features/chat/model/types';
import { Sheet, Text } from '@/shared/ui';

import { PrivacyAttachmentList } from './PrivacyAttachmentList';
import { PrivacyExplainer } from './PrivacyExplainer';
import { RevealRow } from './RevealRow';
import { TokenMapRow } from './TokenMapRow';

const makeStyles = (theme: Theme) => ({
    block: { gap: theme.spacing.sm },
    raw: { marginTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
});

export function PrivacySheet({ message, visible, onClose }: { message: ChatMessage; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const info: TokenisationInfo = message.tokenisation ?? { categories: [] };
    const action = privacyActionOf(info);
    const badge = privacyBadgeOf(info);
    const categories = categoryList(info.categories);
    const by = info.automatic
        ? t('mobile.chat.privacy_by_automatic', ' (automatic)')
        : t('mobile.chat.privacy_by_choice', ' (you chose)');
    const sentTo = info.provider ? ` · ${t('privacy.sent_to', 'Sent to')} ${info.provider}` : '';
    const hasRaw = Boolean(info.tokenizedPrompt || info.rawResponse || info.tokenMap);

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('privacy.panel_title', 'Privacy protection')}
            subtitle={t(badge.i18nKey, badge.en, { count: badge.count })}
            tall={hasRaw}
        >
            <View style={styles.block}>
                <Text variant="body">
                    <Text variant="body" weight="semibold">
                        {t(action.i18nKey, action.en)}
                    </Text>
                    {`${sentTo}${by}`}
                </Text>
                {categories ? (
                    <Text variant="caption" tone="secondary">
                        {`${t('privacy.detected', 'Detected:')} ${categories}`}
                    </Text>
                ) : null}
                {info.attachments?.length ? <PrivacyAttachmentList attachments={info.attachments} /> : null}
                <PrivacyExplainer info={info} question={message.questionText ?? ''} />
            </View>
            {hasRaw ? (
                <View style={styles.raw}>
                    <RevealRow
                        label={t('privacy.row_original', 'Original message')}
                        hint={t('privacy.row_original_hint', 'stays on your device')}
                        text={message.questionText}
                        revealable
                    />
                    <RevealRow
                        label={t('privacy.row_sent', 'Sent to AI')}
                        hint={info.provider ? t('privacy.row_sent_hint', 'via {provider}', { provider: info.provider }) : undefined}
                        text={info.tokenizedPrompt}
                    />
                    <TokenMapRow tokenMap={info.tokenMap} />
                    <RevealRow
                        label={t('privacy.row_returned', 'What the AI returned')}
                        hint={
                            info.rawTruncated
                                ? t('mobile.chat.privacy_returned_truncated', 'truncated · tokens intact')
                                : t('mobile.chat.privacy_returned_intact', 'tokens intact')
                        }
                        text={aiReturnedText(info, message.content)}
                    />
                </View>
            ) : null}
        </Sheet>
    );
}
