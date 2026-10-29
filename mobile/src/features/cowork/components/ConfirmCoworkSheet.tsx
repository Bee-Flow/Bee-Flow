/**
 * The confirm sheet — the moment of consent. Everything on it is what WILL
 * happen, not what was asked: the AI's title, the AI's instruction, and the
 * schedule as a sentence. One button creates; closing the sheet creates
 * nothing.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
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
    const t = useTranslation();
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
                            ? t('mobile.cowork.schedule_it_repeat', 'Schedule it — {repeat}', {
                                  repeat: repeatLabel(proposal.repeat).toLowerCase(),
                              })
                            : t('mobile.cowork.schedule_it', 'Schedule it')
                    }
                    onPress={onCreate}
                    loading={creating}
                />
                <Button label={t('shield_data.act_not_this', 'Not this')} variant="ghost" onPress={onDismiss} />
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
    const t = useTranslation();
    return (
        <Sheet visible={Boolean(proposal)} onClose={onDismiss} title={t('mobile.cowork.schedule_this', 'Schedule this?')}>
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
