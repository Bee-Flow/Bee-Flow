/**
 * One form: its address, whether it is taking answers, and what came in.
 *
 * The route param is the form PAGE id — the token in the /f/<id> address —
 * because that is what the list row has and what the link is keyed by. The
 * routine behind it is `automationId`, and everything except the link is keyed
 * by THAT: submissions, and open/closed.
 *
 * There is no `GET /api/automation/forms/:id`, so the form is read out of the
 * org-wide list, which is already cached by the screen that got you here. That
 * is not a workaround for a missing endpoint so much as the right shape: the
 * list is one small query, and a per-form fetch would refetch the same rows.
 *
 * Two honest limits stated on the screen rather than worked around:
 *   - Hosted forms are currently NOT anonymous. PUBLIC_FORMS_ENABLED is off in
 *     routes/automation/formPublic.js, so /f/<token> opens only for a signed-in
 *     member of the owner's organisation. Telling someone to "share the public
 *     link" with a customer would be a wasted afternoon.
 *   - Closing a form disarms the whole routine, every other trigger included.
 *     There is no per-form switch on the server, and a schedule that quietly
 *     stopped is not a thing to discover a week later.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
    listFormSubmissions,
    listForms,
    publicFormUrl,
    publishingKeys,
    setFormOpen,
} from '../../src/features/publishing/api';
import { LinkActions } from '../../src/features/publishing/components/LinkActions';
import { humaniseField, submissionAnswers, submissionStatus } from '../../src/features/publishing/format';
import type { FormSubmission } from '../../src/features/publishing/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { Banner, ErrorState, ListSkeleton, LoadingState, describeError } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function FormDetailScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const params = useLocalSearchParams<{ id: string }>();
    const id = typeof params.id === 'string' ? params.id : '';

    const [confirmClose, setConfirmClose] = useState(false);
    const [reading, setReading] = useState<FormSubmission | null>(null);

    const forms = useQuery({
        queryKey: publishingKeys.forms,
        queryFn: ({ signal }) => listForms(signal),
    });

    const form = (forms.data ?? []).find((row) => row.id === id) ?? null;

    const submissions = useQuery({
        queryKey: publishingKeys.formSubmissions(form?.automationId ?? ''),
        queryFn: ({ signal }) => listFormSubmissions(form?.automationId ?? '', signal),
        // The run endpoints are owner-only (403 for a colleague's routine), so
        // a form you can merely see never fires this query at all.
        enabled: Boolean(form?.mine && form.automationId),
    });

    const toggle = useMutation({
        mutationFn: (open: boolean) => setFormOpen(form?.automationId ?? '', open),
        onSuccess: (_result, open) => {
            setConfirmClose(false);
            toast(open ? 'Form is open' : 'Form is closed', 'success');
            void queryClient.invalidateQueries({ queryKey: publishingKeys.forms });
        },
        onError: (err: unknown) => {
            setConfirmClose(false);
            // Activation re-validates the whole routine, so a 400 here names a
            // real problem in the flow. Its message is the useful part.
            toast(describeError(err).message, 'error');
        },
    });

    if (forms.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Form" />
                <LoadingState />
            </Screen>
        );
    }

    if (forms.isError || !form) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Form" />
                <ErrorState
                    error={forms.error ?? new Error('This form no longer exists.')}
                    onRetry={() => void forms.refetch()}
                />
            </Screen>
        );
    }

    const url = publicFormUrl(form);
    const rows = submissions.data ?? [];

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={form.title}
                subtitle={form.description ?? undefined}
                actions={
                    <Badge
                        label={form.live ? 'Open' : 'Closed'}
                        tone={form.live ? 'success' : 'neutral'}
                    />
                }
            />

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={forms.isRefetching || submissions.isRefetching}
                        onRefresh={() => {
                            void forms.refetch();
                            if (form.mine) void submissions.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <Banner tone="info" icon="edit-3">
                    The fields and the routine behind this form are built in the web app on a
                    desktop. From here you can share it, close it and read what came in.
                </Banner>

                <Section title="The link">
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            <LinkActions url={url} shareTitle={form.title} />
                            <Text variant="caption" tone="tertiary">
                                Only signed-in members of your organisation can open this form.
                                Anyone else — and anyone at all while it is closed — gets a
                                not-found page.
                            </Text>
                        </View>
                    </Card>
                </Section>

                <Section title="Taking answers">
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            <Text variant="body" tone="secondary">
                                {form.live
                                    ? 'The form is open and the routine behind it is armed.'
                                    : 'The form is closed. Its address returns a not-found page until it is opened again.'}
                            </Text>
                            {form.mine ? (
                                <>
                                    <Text variant="caption" tone="tertiary">
                                        There is no switch for the form on its own: opening and
                                        closing arms and disarms the whole routine, including any
                                        other trigger on it.
                                    </Text>
                                    <Button
                                        label={form.live ? 'Close form' : 'Open form'}
                                        variant={form.live ? 'secondary' : 'primary'}
                                        loading={toggle.isPending}
                                        onPress={() => {
                                            if (form.live) setConfirmClose(true);
                                            else toggle.mutate(true);
                                        }}
                                    />
                                </>
                            ) : (
                                <Text variant="caption" tone="tertiary">
                                    A colleague owns the routine behind this form, so opening and
                                    closing it is theirs to do.
                                </Text>
                            )}
                        </View>
                    </Card>
                </Section>

                <Section
                    title="Submissions"
                    subtitle={
                        form.mine
                            ? 'Everything that arrived through a form trigger on this routine'
                            : undefined
                    }
                    action={
                        form.mine ? (
                            <Button
                                label="Run history"
                                variant="ghost"
                                onPress={() => router.push(`/automations/${form.automationId}/runs`)}
                            />
                        ) : undefined
                    }
                >
                    {!form.mine ? (
                        <Card>
                            <Text variant="body" tone="tertiary">
                                {form.submissions === 1
                                    ? 'One submission so far.'
                                    : `${form.submissions} submissions so far.`}{' '}
                                Reading the answers needs the routine&apos;s owner — submissions
                                are only visible to them.
                            </Text>
                        </Card>
                    ) : submissions.isLoading ? (
                        <ListSkeleton rows={3} />
                    ) : submissions.isError ? (
                        <Banner
                            tone={describeError(submissions.error).retryable ? 'error' : 'info'}
                            action={
                                describeError(submissions.error).retryable ? (
                                    <Button
                                        label="Retry"
                                        variant="ghost"
                                        onPress={() => void submissions.refetch()}
                                    />
                                ) : undefined
                            }
                        >
                            {describeError(submissions.error).message}
                        </Banner>
                    ) : rows.length === 0 ? (
                        <Card>
                            <Text variant="body" tone="tertiary">
                                Nothing has come in yet. Share the link with the people you want
                                answers from.
                            </Text>
                        </Card>
                    ) : (
                        <Card padded={false}>
                            {rows.map((run, index) => (
                                <View key={run.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <SubmissionRow run={run} onPress={() => setReading(run)} />
                                </View>
                            ))}
                        </Card>
                    )}
                </Section>
            </ScrollView>

            <ConfirmSheet
                visible={confirmClose}
                title="Close this form?"
                message="The address stops working straight away. Because a form has no switch of its own, this also disarms every other trigger on the routine behind it — a schedule on the same routine will stop firing."
                confirmLabel="Close form"
                busy={toggle.isPending}
                onConfirm={() => toggle.mutate(false)}
                onCancel={() => setConfirmClose(false)}
            />

            <SubmissionSheet submission={reading} onClose={() => setReading(null)} />
        </Screen>
    );
}

function SubmissionRow({ run, onPress }: { run: FormSubmission; onPress: () => void }) {
    const status = submissionStatus(run.status);
    const answers = submissionAnswers(run.triggerPayload);
    // The first answer is nearly always the one that identifies the person —
    // a name, an email, a subject line — so it earns the subtitle far better
    // than a field count would.
    const preview = answers[0];

    return (
        <ListRow
            title={preview ? preview.value : 'Submission'}
            subtitle={
                answers.length > 1
                    ? `${humaniseField(preview?.field ?? '')} · ${answers.length} answers`
                    : preview
                      ? humaniseField(preview.field)
                      : undefined
            }
            meta={relativeTime(run.startedAt)}
            wrapTitle
            trailing={<Badge label={status.label} tone={status.tone} />}
            onPress={onPress}
        />
    );
}

/**
 * One submission, read.
 *
 * Field ids rather than the author's labels: the labels live in the form
 * trigger's definition and the run payload does not carry them, so
 * humaniseField turns `full_name` into "Full name" instead of pretending to
 * know what the builder called it.
 */
function SubmissionSheet({
    submission,
    onClose,
}: {
    submission: FormSubmission | null;
    onClose: () => void;
}) {
    const theme = useTheme();
    const answers = submission ? submissionAnswers(submission.triggerPayload) : [];
    const status = submission ? submissionStatus(submission.status) : null;

    return (
        <Sheet
            visible={submission !== null}
            onClose={onClose}
            title="Submission"
            subtitle={submission?.startedAt ? relativeTime(submission.startedAt, { suffix: true }) : undefined}
            tall
        >
            <View style={{ gap: theme.spacing.lg }}>
                {status ? <Badge label={status.label} tone={status.tone} /> : null}

                {submission?.error ? (
                    <Banner tone="error">{submission.error}</Banner>
                ) : submission?.summary ? (
                    <Text variant="caption" tone="tertiary">
                        {submission.summary}
                    </Text>
                ) : null}

                {answers.length === 0 ? (
                    <Text variant="body" tone="tertiary">
                        This submission arrived without any answers recorded on it.
                    </Text>
                ) : (
                    <View style={{ gap: theme.spacing.lg }}>
                        {answers.map((answer) => (
                            <View key={answer.field} style={{ gap: theme.spacing.xxs }}>
                                <Text variant="label" tone="tertiary">
                                    {humaniseField(answer.field)}
                                </Text>
                                <Text variant="body" selectable>
                                    {answer.value}
                                </Text>
                            </View>
                        ))}
                    </View>
                )}

                <Text variant="caption" tone="tertiary">
                    Files attached to a submission stay on the server — they are reachable from
                    the run history in the web app, not from here.
                </Text>
            </View>
        </Sheet>
    );
}
