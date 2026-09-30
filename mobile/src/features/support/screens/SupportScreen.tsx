/**
 * Help and support.
 *
 * A support request from a phone is usually written in the two minutes after
 * something went wrong, so this screen optimises for that: one field for the
 * subject, one for what happened, and the version details attached
 * automatically.
 *
 * Threads are read and replied to in place. The first reply is usually the AI
 * responder — `author_kind` distinguishes it from a human, so the screen says
 * which one answered rather than letting someone thank a machine for a
 * personal touch.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useUserRefresh } from '@/shared/patterns';
import {
    Banner,
    Button,
    EmptyState,
    GroupedScroll,
    ListSkeleton,
    Screen,
    ScreenHeader,
    useToast,
} from '@/shared/ui';

import { ComposeSheet } from '../components/ComposeSheet';
import { SelfHelpGroup } from '../components/SelfHelpGroup';
import { SupportUnavailable } from '../components/SupportUnavailable';
import { ThreadsGroup } from '../components/ThreadsGroup';
import { ThreadSheet } from '../components/ThreadSheet';
import { useMySupportThreads } from '../hooks/queries';

export function SupportScreen() {
    const { toast } = useToast();
    const { user } = useAuth();
    const [composing, setComposing] = useState(false);
    const [openThreadId, setOpenThreadId] = useState<string | null>(null);
    const threads = useMySupportThreads();
    const refresh = useUserRefresh(() => threads.refetch());

    // The support module is optional, so a self-host without it answers 404,
    // which the endpoint folds to null. That is a different thing from "you
    // have no threads" and reads differently below.
    const supportUnavailable = threads.isSuccess && threads.data === null;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title="Help"
                subtitle={user?.email ?? undefined}
                actions={
                    supportUnavailable ? undefined : (
                        <Button label="Ask" onPress={() => setComposing(true)} size="md" />
                    )
                }
            />

            <GroupedScroll refresh={refresh}>
                <SelfHelpGroup />

                {supportUnavailable ? (
                    <SupportUnavailable />
                ) : threads.isLoading ? (
                    <ListSkeleton rows={3} />
                ) : threads.isError ? (
                    <Banner tone="error">{describeError(threads.error).message}</Banner>
                ) : threads.data && threads.data.length > 0 ? (
                    <ThreadsGroup threads={threads.data} onOpen={setOpenThreadId} />
                ) : (
                    <EmptyState
                        icon="LifeBuoy"
                        title="No requests yet"
                        message="Ask anything — how something works, or what went wrong. Bee Flow attaches your version details so nobody has to ask for them."
                        actionLabel="Ask a question"
                        onAction={() => setComposing(true)}
                    />
                )}
            </GroupedScroll>

            <ComposeSheet
                visible={composing}
                onClose={() => setComposing(false)}
                onFiled={() => {
                    setComposing(false);
                    toast('Request sent', 'success');
                }}
            />

            <ThreadSheet threadId={openThreadId} onClose={() => setOpenThreadId(null)} />
        </Screen>
    );
}
