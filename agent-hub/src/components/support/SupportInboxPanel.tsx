import { useState } from 'react';
import SupportAIConfig from './SupportAIConfig';
import SupportConnectionsConfig from './SupportConnectionsConfig';
import SupportInboxHeader from './SupportInboxHeader';
import SupportMailboxBanner from './SupportMailboxBanner';
import SupportThreadDetail from './SupportThreadDetail';
import SupportThreadList from './SupportThreadList';
import useConfirm from '../shared/useConfirm';
import type { SupportInboxPanelProps } from './SupportInboxPanel.types';
import { useSupportBulk, useSupportReplyComposer, useSupportThreadEdits } from './useSupportInboxActions';
import { useSupportMailbox } from './useSupportMailbox';
import { useSupportSelectedThread } from './useSupportSelectedThread';
import { useSupportStream } from './useSupportStream';
import { useSupportThreadList } from './useSupportThreadList';

export default function SupportInboxPanel({ focusThreadId = null }: SupportInboxPanelProps) {
    const { confirm, confirmDialog } = useConfirm();
    const [selectedId, setSelectedId] = useState<string | null>(focusThreadId || null);
    const [view, setView] = useState('inbox'); // 'inbox' | 'ai-config' | 'connections'
    const list = useSupportThreadList();
    const { counts, loading, fetchThreads } = list;
    const { mailbox, disconnecting, fetchMailbox, disconnectMailbox } = useSupportMailbox({ confirm, setSelectedId, fetchThreads });
    const selected = useSupportSelectedThread(selectedId);
    const { fetchThread } = selected;
    useSupportStream({ selectedId, setSelectedId, fetchThreads, fetchThread, fetchMailbox });
    const refresh = { selectedId, fetchThread, fetchThreads };
    const bulk = useSupportBulk(refresh);
    const edits = useSupportThreadEdits({ ...refresh, thread: selected.thread });
    const composer = useSupportReplyComposer(refresh);

    const counter = (key: string) => counts[key] || 0;
    const activeTotal = counter('open') + counter('ai_responding') + counter('awaiting_user') + counter('awaiting_agent');

    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            {/* Header */}
            <SupportInboxHeader activeTotal={activeTotal} resolved={counter('resolved')} view={view} setView={setView} loading={loading} onRefresh={fetchThreads} />

            {/* A mailbox is feeding this inbox — offer a way out of it. */}
            {view === 'inbox' && mailbox?.connected && (
                <SupportMailboxBanner mailbox={mailbox} disconnecting={disconnecting} onDisconnect={disconnectMailbox} />
            )}

            {view === 'connections' ? (
                <div className="flex-1 min-h-0">
                    <SupportConnectionsConfig />
                </div>
            ) : view === 'ai-config' ? (
                <div className="flex-1 min-h-0">
                    <SupportAIConfig />
                </div>
            ) : (
            <>
            {/* Inbox view (default) */}

            <div className="flex-1 min-h-0 grid grid-cols-12">
                {/* Left: thread list */}
                <SupportThreadList list={list} bulk={bulk} selectedId={selectedId} setSelectedId={setSelectedId} counter={counter} activeTotal={activeTotal} />

                {/* Right: thread detail */}
                <SupportThreadDetail selected={selected} edits={edits} composer={composer} selectedId={selectedId} fetchThreads={fetchThreads} />
            </div>
            </>
            )}
            {confirmDialog}
        </div>
    );
}
