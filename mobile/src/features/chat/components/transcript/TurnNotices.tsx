/**
 * What the live turn says outside the answer: swarm progress, the privacy
 * review the server is waiting on, and a refusal. Each subscribes to its own
 * field of the turn store, so none of them re-renders per token. (What the
 * server is doing now — the phase line — is part of the answer's own cell.)
 *
 * Shared by direct chat (which has swarms) and agent chat.
 */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { DlpReviewSheet } from '@/features/chat/components/dlp/DlpReviewSheet';
import type { DlpResolver } from '@/features/chat/hooks/dlpResolver';
import { useTurn, type DlpDecision, type SwarmProgress, type TurnBlock, type TurnSource } from '@/shared/stream';
import { Text } from '@/shared/ui';

import { SwarmPanel } from './SwarmPanel';

interface NoticeTurn {
    dlpDecision: DlpDecision | null;
    blocked: TurnBlock | null;
    swarm?: SwarmProgress | null;
}

export interface TurnNoticesProps {
    store: TurnSource<NoticeTurn>;
    onResolveDlp: DlpResolver;
}

const makeStyles = (theme: Theme) => ({
    blocked: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
});

export function TurnNotices({ store, onResolveDlp }: TurnNoticesProps) {
    const styles = useThemedStyles(makeStyles);
    const swarm = useTurn(store, (turn) => turn.swarm ?? null);
    const decision = useTurn(store, (turn) => turn.dlpDecision);
    const blocked = useTurn(store, (turn) => turn.blocked);

    return (
        <>
            {swarm ? <SwarmPanel progress={swarm} /> : null}

            {/* The stream is HELD OPEN until this is answered; without it the
                turn looks like a hang with no error. Keyed on the decision so a
                second question starts with no marks from the first. */}
            {decision ? <DlpReviewSheet key={decision.decisionId} decision={decision} onChoose={onResolveDlp} /> : null}

            {blocked ? (
                <View style={styles.blocked}>
                    <Text variant="caption" tone="warning">
                        {blocked.reason}
                        {blocked.detail ? ` ${blocked.detail}` : ''}
                    </Text>
                </View>
            ) : null}
        </>
    );
}
