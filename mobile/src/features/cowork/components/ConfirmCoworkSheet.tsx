/**
 * The confirm sheet — the moment of consent. Everything on it is what WILL
 * happen, not what was asked: the AI's title, the AI's instruction, and the
 * schedule as a sentence. One button creates; closing the sheet creates
 * nothing.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Icon, Sheet, Text } from '@/shared/ui';

import type { Proposal } from '../model/proposal';
import { repeatLabel } from '../model/schedule';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.lg },
        heading: { gap: theme.spacing.xs },
        when: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        quote: { borderLeftWidth: 2, borderLeftColor: theme.colors.borderSubtle, paddingLeft: theme.spacing.md },
        actions: { gap: theme.spacing.sm },
    });

function ProposalBody({
    proposal,
    error,
    creating,
    onCreate,
    onDismiss,
}: {
    proposal: Proposal;
    error: Error | null;
    creating: boolean;
    onCreate: () => void;
    onDismiss: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.body}>
            <View style={styles.heading}>
                <Text variant="subheading" weight="semibold">
                    {proposal.title}
                </Text>
                <View style={styles.when}>
                    <Icon name="Clock" size={14} color={theme.colors.accentText} />
                    <Text variant="caption" tone="secondary">
                        {proposal.scheduleSentence}
                    </Text>
                </View>
            </View>

            <View style={styles.quote}>
                <Text variant="caption" tone="tertiary" numberOfLines={6}>
                    {proposal.prompt}
                </Text>
            </View>

            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}

            <View style={styles.actions}>
                <Button
                    label={
                        proposal.repeat
                            ? `Schedule it — ${repeatLabel(proposal.repeat).toLowerCase()}`
                            : 'Schedule it'
                    }
                    onPress={onCreate}
                    loading={creating}
                />
                <Button label="Not this" variant="ghost" onPress={onDismiss} />
            </View>
        </View>
    );
}

export function ConfirmCoworkSheet({
    proposal,
    error,
    creating,
    onCreate,
    onDismiss,
}: {
    proposal: Proposal | null;
    error: Error | null;
    creating: boolean;
    onCreate: (proposal: Proposal) => void;
    onDismiss: () => void;
}) {
    return (
        <Sheet visible={Boolean(proposal)} onClose={onDismiss} title="Schedule this?">
            {proposal ? (
                <ProposalBody
                    proposal={proposal}
                    error={error}
                    creating={creating}
                    onCreate={() => onCreate(proposal)}
                    onDismiss={onDismiss}
                />
            ) : null}
        </Sheet>
    );
}
