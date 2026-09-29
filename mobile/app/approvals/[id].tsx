/**
 * One decision, waiting on you.
 *
 * This screen exists because the notification router used to answer
 * `WEB_ONLY('Approving a step')` for a link the phone was perfectly capable of
 * acting on — and because approving is the most phone-shaped thing in the
 * whole automation product. You are away from your desk, a routine has stopped
 * on a yes-or-no, and the alternative to answering it here is that it waits
 * until you are back at a computer.
 *
 * Keyed by APPROVAL id, not run id. That is what `/app/studio/approvals/:id`
 * carries (server/automation/approvalHooks.js), and an App Studio approval has
 * no run at all — so the run-keyed `decideRunStep` the app already had could
 * not have served this link even if the router had pointed at it.
 *
 * `canDecide` comes from the server and is never recomputed here. Panels,
 * stage chains, quorum rules and votes-already-cast are resolved in
 * approvalService, and a client that second-guessed them would eventually show
 * an Approve button to someone whose seat was already spent.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { automateKeys, decideApproval, getApproval } from '../../src/features/automate/api';
import { Markdown } from '../../src/features/chat/Markdown';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { ErrorState, LoadingState } from '../../src/ui/Feedback';
import { Group, InfoRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning' | 'neutral'> = {
    approved: 'success',
    rejected: 'error',
    expired: 'warning',
    cancelled: 'warning',
    pending: 'neutral',
};

export default function ApprovalScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    /** Set to the decision being confirmed — rejection asks for a reason. */
    const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
    const [reason, setReason] = useState('');

    const query = useQuery({
        queryKey: automateKeys.approval(id),
        queryFn: ({ signal }) => getApproval(id, signal),
    });

    const decide = useMutation({
        mutationFn: (decision: 'approve' | 'reject') =>
            decideApproval(id, decision, reason.trim() || undefined),
        onSuccess: (_data, decision) => {
            setConfirming(null);
            setReason('');
            toast(decision === 'approve' ? 'Approved' : 'Rejected', 'success');
            // The decision changes the run, the recent-runs list and the bell,
            // so none of them may keep serving what they had a moment ago.
            void queryClient.invalidateQueries({ queryKey: automateKeys.approval(id) });
            void queryClient.invalidateQueries({ queryKey: automateKeys.recentRuns });
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
        onError: (err: Error) => toast(err.message || 'That did not go through', 'error'),
    });

    const detail = query.data;
    const approval = detail?.approval;
    const pending = approval?.status === 'pending';

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader title="Approval" subtitle={approval?.automationTitle || undefined} />

            {query.isLoading ? (
                <LoadingState />
            ) : query.isError || !approval || !detail ? (
                <ErrorState
                    error={
                        query.error ??
                        // A 404 here is deliberately indistinguishable from
                        // "belongs to someone else" — the server refuses to let
                        // an approval id become an oracle. So the copy cannot
                        // claim it was deleted.
                        new Error('This approval is not available to you. It may have been withdrawn.')
                    }
                    onRetry={() => void query.refetch()}
                />
            ) : (
                <>
                    <ScrollView
                        contentContainerStyle={{
                            padding: theme.spacing.lg,
                            gap: theme.spacing.lg,
                            paddingBottom: theme.spacing.xxxl,
                        }}
                    >
                        <View style={{ gap: theme.spacing.sm }}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                <Badge
                                    label={approval.status}
                                    tone={STATUS_TONE[approval.status] ?? 'neutral'}
                                />
                                <Text variant="caption" tone="tertiary">
                                    asked {relativeTime(approval.createdAt)}
                                </Text>
                            </View>
                            <Text variant="heading">{approval.prompt || 'A decision is needed'}</Text>
                        </View>

                        {approval.detailsMd ? <Markdown value={approval.detailsMd} /> : null}

                        <Group>
                            {approval.projectTitle ? (
                                <InfoRow label="Solution" value={approval.projectTitle} />
                            ) : null}
                            {approval.automationTitle ? (
                                <InfoRow label="Routine" value={approval.automationTitle} />
                            ) : null}
                            {approval.expiresAt ? (
                                <InfoRow label="Expires" value={relativeTime(approval.expiresAt)} />
                            ) : null}
                            {approval.decidedAt ? (
                                <InfoRow
                                    label="Decided"
                                    value={`${approval.decidedByName || 'Someone'} · ${relativeTime(approval.decidedAt)}`}
                                />
                            ) : null}
                            {approval.decisionReason ? (
                                <InfoRow label="Reason given" value={approval.decisionReason} />
                            ) : null}
                        </Group>

                        {/*
                          * Only for a run-backed approval, and only once it is
                          * decided — before that the run is paused on this very
                          * question and the run screen has nothing to add.
                          */}
                        {approval.source === 'run' && approval.automationId && !pending ? (
                            <Button
                                label="See the run"
                                variant="secondary"
                                onPress={() => router.push(`/automations/${approval.automationId}/runs`)}
                            />
                        ) : null}

                        {pending && !detail.canDecide ? (
                            <Text variant="caption" tone="tertiary">
                                This is waiting on someone else. You can see it because it concerns
                                something of yours.
                            </Text>
                        ) : null}
                    </ScrollView>

                    {pending && detail.canDecide ? (
                        <View
                            style={{
                                flexDirection: 'row',
                                gap: theme.spacing.md,
                                padding: theme.spacing.lg,
                                borderTopWidth: 1,
                                borderTopColor: theme.colors.borderSubtle,
                            }}
                        >
                            <Button
                                label="Reject"
                                variant="secondary"
                                style={{ flex: 1 }}
                                onPress={() => setConfirming('reject')}
                            />
                            <Button
                                label="Approve"
                                style={{ flex: 1 }}
                                onPress={() => setConfirming('approve')}
                                icon={
                                    <Feather
                                        name="check"
                                        size={16}
                                        color={theme.colors.accentPrimaryFg}
                                    />
                                }
                            />
                        </View>
                    ) : null}

                    <Sheet
                        visible={confirming !== null}
                        onClose={() => setConfirming(null)}
                        title={confirming === 'reject' ? 'Reject this?' : 'Approve this?'}
                        subtitle={
                            confirming === 'reject'
                                ? 'The routine stops here. Say why, so the next person reading this knows.'
                                : 'The routine carries on from where it paused.'
                        }
                        footer={
                            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                                <Button
                                    label="Cancel"
                                    variant="ghost"
                                    style={{ flex: 1 }}
                                    onPress={() => setConfirming(null)}
                                />
                                <Button
                                    label={confirming === 'reject' ? 'Reject' : 'Approve'}
                                    // Destructive only inside the confirmation
                                    // sheet: the row behind it is a choice, and
                                    // painting one half red there would make
                                    // rejecting look like the dangerous answer
                                    // rather than an equal one.
                                    variant={confirming === 'reject' ? 'destructive' : 'primary'}
                                    style={{ flex: 1 }}
                                    loading={decide.isPending}
                                    onPress={() => confirming && decide.mutate(confirming)}
                                />
                            </View>
                        }
                    >
                        <TextField
                            label={confirming === 'reject' ? 'Reason' : 'Note (optional)'}
                            value={reason}
                            onChangeText={setReason}
                            multiline
                            placeholder={
                                confirming === 'reject'
                                    ? 'What needs to change before this can go ahead?'
                                    : ''
                            }
                        />
                    </Sheet>
                </>
            )}
        </Screen>
    );
}
