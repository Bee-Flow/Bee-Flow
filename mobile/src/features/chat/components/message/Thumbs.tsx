/**
 * Was this answer any good?
 *
 * Both thumbs stay visible after you press one — the pressed one fills in with
 * the accent colour. Hiding the other would make a mis-tap unfixable, and this
 * is the only control in the app whose whole purpose is to be pressed by
 * someone who is already annoyed.
 *
 * The rating is filed at once; `onRated` then opens the optional follow-up
 * (a comment, and the conversation if the person ticks it), as on the web.
 */

import * as Haptics from 'expo-haptics';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { rateMessage, useMessageRating } from '@/features/chat/hooks/ratings';
import type { FeedbackRating, FeedbackTarget } from '@/features/chat/model/feedback';
import { useToast } from '@/shared/ui';

import { MessageAction } from './MessageAction';

export function Thumbs({ target, onRated }: { target: FeedbackTarget; onRated: (rating: FeedbackRating) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const current = useMessageRating(target);

    const rate = (rating: FeedbackRating) => {
        if (current === rating) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onRated(rating);
        rateMessage(target, rating).catch(() => {
            // The optimistic fill has already been rolled back by the store, so
            // the icon and the message agree. Saying nothing here would leave a
            // person believing they had reported a bad answer when they had not.
            toast(t('mobile.chat.feedback_failed', 'Could not send that just now'));
        });
    };

    return (
        <>
            <MessageAction
                icon="ThumbsUp"
                label={t('chat.msg.thumbs_up', 'Good response')}
                onPress={() => rate('up')}
                color={current === 'up' ? theme.colors.accentText : undefined}
                selected={current === 'up'}
            />
            <MessageAction
                icon="ThumbsDown"
                label={t('chat.msg.thumbs_down', 'Bad response')}
                onPress={() => rate('down')}
                color={current === 'down' ? theme.colors.accentText : undefined}
                selected={current === 'down'}
            />
        </>
    );
}
