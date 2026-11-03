/**
 * One decision, waiting on you.
 *
 * This screen exists because the notification router used to answer
 * `WEB_ONLY('Approving a step')` for a link the phone was perfectly capable of
 * acting on — and because approving is the most phone-shaped thing in the
 * whole automation product: an automation has stopped on a yes-or-no, and the
 * alternative to answering it here is that it waits until you are back at a
 * computer.
 *
 * `canDecide` comes from the server and is never recomputed here. Panels,
 * stage chains, quorum rules and votes-already-cast are resolved in
 * approvalService, and a client that second-guessed them would eventually show
 * an Approve button to someone whose seat was already spent.
 *
 * What came of a decision is said from the server's answer: on a panel or a
 * stage chain it is a vote and the approval still waits. An approval that
 * asks for answers asks them in the decide sheet; a run screen sends such an
 * approval here with `?decide=approve`, which opens that sheet at once.
 */

import { Stack } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { decisionOutcome } from '@/features/automations';
import type { Answers } from '@/features/forms';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { ScreenHeader, useToast } from '@/shared/ui';

import { ApprovalBody } from '../components/ApprovalBody';
import { DecideSheet } from '../components/DecideSheet';
import { DecisionBar } from '../components/DecisionBar';
import { useDecideApproval } from '../hooks/mutations';
import { useApproval } from '../hooks/queries';
import type { ApprovalDecision, ApprovalDetail } from '../model/types';

/**
 * Open the decide sheet once, when the approval can be decided and the caller
 * asked for it (`?decide=approve`). Set while rendering, the way React stores
 * what an earlier render saw, so the sheet opens in the same pass.
 */
function useInitialDecision(detail: ApprovalDetail | null | undefined, initial: ApprovalDecision | null, open: (d: ApprovalDecision) => void) {
    const [done, setDone] = useState(false);
    if (initial && !done && detail?.approval.status === 'pending' && detail.canDecide) {
        setDone(true);
        open(initial);
    }
}

export function ApprovalScreen({ id, initialDecision = null }: { id: string; initialDecision?: ApprovalDecision | null }) {
    const t = useTranslation();
    const { toast } = useToast();
    /** Set to the decision being confirmed — rejection asks for a reason. */
    const [confirming, setConfirming] = useState<ApprovalDecision | null>(null);
    const [reason, setReason] = useState('');

    const query = useApproval(id);
    useInitialDecision(query.data, initialDecision, setConfirming);
    const decide = useDecideApproval(id, {
        onSuccess: (_vars, result) => {
            setConfirming(null);
            setReason('');
            const outcome = decisionOutcome(result, t);
            toast(outcome.text, outcome.tone);
        },
        onError: (err: Error) => toast(describeError(err).message, 'error'),
    });
    const confirm = (decision: ApprovalDecision, answers?: Answers) =>
        decide.mutateAsync({ decision, reason: reason.trim() || undefined, ...(answers ? { answers } : {}) }).then(() => undefined);

    const detailQuery: DetailQuery<ApprovalDetail> = {
        data: query.data ?? undefined,
        isLoading: query.isLoading,
        isError: query.isError,
        // A 404 here is deliberately indistinguishable from "belongs to someone
        // else" — the server refuses to let an approval id become an oracle. So
        // the copy cannot claim it was deleted.
        error: query.error ?? new Error(t('mobile.approvals.unavailable', 'This approval is not available to you. It may have been withdrawn.')),
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
                    <ScreenHeader title={t('automations.node.approval.typeLabel', 'Approval')} subtitle={detail?.approval.automationTitle || undefined} />
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
                        onConfirm={(decision, answers) => (answers ? confirm(decision, answers) : void confirm(decision).catch(() => undefined))}
                        onClose={() => setConfirming(null)}
                        fields={detail.approval.status === 'pending' ? detail.approval.fields : []}
                    />
                </>
            )}
        </QueryScreen>
    );
}
