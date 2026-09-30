/**
 * The sentence under the privacy details. It claims only what the scan can
 * back: with part of a document unchecked it says so instead of "the AI only
 * saw placeholders", and it names placeholders only where they provably
 * stand for values in the question (describePrivacyLine).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { describePrivacyLine } from '@/features/chat/model/privacyLine';
import { anyIncomplete } from '@/features/chat/model/privacyPanel';
import type { TokenisationInfo } from '@/features/chat/model/types';
import { Text } from '@/shared/ui';

export function PrivacyExplainer({ info, question }: { info: TokenisationInfo; question: string }) {
    const t = useTranslation();
    if (!((info.count ?? 0) > 0)) return null;
    if (anyIncomplete(info)) {
        return (
            <Text variant="caption" tone="warning">
                {t(
                    'dlp.panel_partial_explainer',
                    'Part of this document could not be checked, so it was left out of what the AI received. Everything that was checked was replaced with placeholders.',
                )}
            </Text>
        );
    }
    const proven = describePrivacyLine({ count: info.count ?? 0, messageText: question, tokenMap: info.tokenMap });
    const tokens = proven?.tokens ?? [];
    const sentence =
        tokens.length === 0
            ? t(
                  'dlp.panel_full_explainer_unnamed',
                  'The AI only saw placeholders instead of the real values. Real values were restored in the reply before you saw it.',
              )
            : proven?.partial
              ? t(
                    'mobile.chat.privacy_named_partial',
                    'The AI only saw placeholders. {count} values were replaced in all; {tokens} stand for values in this message. Real values were restored in the reply before you saw it.',
                    { tokens: tokens.join(', '), count: proven.count },
                )
              : t(
                    'mobile.chat.privacy_named',
                    'The AI only saw placeholders — {tokens}. Real values were restored in the reply before you saw it.',
                    { tokens: tokens.join(', ') },
                );
    return (
        <Text variant="caption" tone="tertiary">
            {sentence}
        </Text>
    );
}
