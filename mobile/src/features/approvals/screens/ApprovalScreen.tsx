/**
 * One decision, waiting on you.
 *
 * This screen exists because the notification router used to answer
 * `WEB_ONLY('Approving a step')` for a link the phone was perfectly capable of
 * acting on — and because approving is the most phone-shaped thing in the
 * whole automation product: a routine has stopped on a yes-or-no, and the
 * alternative to answering it here is that it waits until you are back at a
 * computer.
 *
 * `canDecide` comes from the server and is never recomputed here. Panels,
 * stage chains, quorum rules and votes-already-cast are resolved in
 * approvalService, and a client that second-guessed them would eventually show
 * an Approve button to someone whose seat was already spent.
 */

import { Stack } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { ScreenHeader, useToast } from '@/shared/ui';

import { ApprovalBody } from '../components/ApprovalBody';
import { DecideSheet } from '../components/DecideSheet';
import { DecisionBar } from '../components/DecisionBar';
import { useDecideApproval } from '../hooks/mutations';
import { useApproval } from '../hooks/queries';
import type { ApprovalDecision, ApprovalDetail } from '../model/types';

export function ApprovalScreen({ id }: { id: string }) {
    const { toast } = useToast();
    /** Set to the decision being confirmed — rejection asks for a reason. */
    const [confirming, setConfirming] = useState<ApprovalDecision | null>(null);
    const [reason, setReason] = useState('');

    const query = useApproval(id);
    const decide = useDecideApproval(id, {
        onSuccess: ({ decision }) => {
            setConfirming(null);
            setReason('');
            toast(decision === 'approve' ? 'Approved' : 'Rejected', 'success');
        },
        onError: (err: Error) => toast(describeError(err).message, 'error'),
    });

    const detailQuery: DetailQuery<ApprovalDetail> = {
        data: query.data ?? undefined,
        isLoading: query.isLoading,
        isError: query.isError,
        // A 404 here is deliberately indistinguishable from "belongs to someone
        // else" — the server refuses to let an approval id become an oracle. So
        // the copy cannot claim it was deleted.
        error: query.error ?? new Error('This approval is not available to you. It may have been withdrawn.'),
        refetch: query.refetch,
    };

    return (
        <QueryScreen
            query={detailQuery}
            screen={{ avoidKeyboard: true }}
            scroll={false}
            header={(detail) => (
                <>
                    <Stack.Screen options={{ headerShown: false }} />
                    <ScreenHeader title="Approval" subtitle={detail?.approval.automationTitle || undefined} />
                </>
            )}
        >
            {(detail) => (
                <>
                    <ApprovalBody detail={detail} />

                    {detail.approval.status === 'pending' && detail.canDecide ? (
                        <DecisionBar onChoose={setConfirming} />
                    ) : null}

                    <DecideSheet
                        confirming={confirming}
                        reason={reason}
                        onReasonChange={setReason}
                        submitting={decide.isPending}
                        onConfirm={(decision) => decide.mutate({ decision, reason: reason.trim() || undefined })}
                        onClose={() => setConfirming(null)}
                    />
                </>
            )}
        </QueryScreen>
    );
}
