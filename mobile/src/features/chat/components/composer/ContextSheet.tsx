/**
 * What the assistant will read before it answers.
 *
 * This replaces the composer's options row, which showed up to eight model
 * tiers and six `Think: <effort>` chips behind an unlabelled slider glyph —
 * fifteen controls, in a vocabulary (Flow / Think / Write / Deep Thinking)
 * that means nothing to anyone who has not read the pricing page, all of it
 * demanded BEFORE the question, which is the one moment nobody can answer it.
 *
 * The row above the composer (ContextRow) shows only what is ON, so an empty
 * row means "just you and the assistant". The sheet is where you add to it:
 * knowledge bases, attachments, skills and web search, in the order they
 * matter. The model tier is NOT here: it is the gauge on the composer's
 * toolbar (TierDial), in the web's own shape.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatContext } from '@/features/chat/model/types';
import { Sheet } from '@/shared/ui';

import { ContextAttach } from './ContextAttach';
import { ContextBases } from './ContextBases';
import { ContextSkills } from './ContextSkills';
import { ContextTools, type ContextToolHandlers } from './ContextTools';
import { WebSearchToggle } from './WebSearchToggle';

export type { ChatContext } from '@/features/chat/model/types';

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.xl },
});

export function ContextSheet({
    visible,
    onClose,
    context,
    onChange,
    sources = true,
    onDocument,
    onImage,
    onCamera,
    tools = {},
}: {
    visible: boolean;
    onClose: () => void;
    context: ChatContext;
    onChange: (next: ChatContext) => void;
    /** See the `sources` note on ComposerProps. */
    sources?: boolean;
    /** The three attachment sources, moved here from the composer's toolbar. */
    onDocument?: () => void;
    onImage?: () => void;
    onCamera?: () => void;
    /** The tools that open a panel of their own: media, apps, voice. */
    tools?: ContextToolHandlers;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.chat.context_title', 'Add to this chat')}
            subtitle={t('mobile.chat.context_subtitle', 'Whatever you add here, the assistant reads before it answers.')}
            tall
        >
            <View style={styles.body}>
                {sources ? (
                    <ContextBases visible={visible} context={context} onChange={onChange} onClose={onClose} />
                ) : null}
                {onDocument || onImage || onCamera ? (
                    <ContextAttach onClose={onClose} onDocument={onDocument} onImage={onImage} onCamera={onCamera} />
                ) : null}
                <ContextSkills onClose={onClose} />
                <ContextTools onClose={onClose} {...tools} />
                <WebSearchToggle
                    value={context.webSearchEnabled}
                    onChange={(webSearchEnabled) => onChange({ ...context, webSearchEnabled })}
                />
            </View>
        </Sheet>
    );
}
