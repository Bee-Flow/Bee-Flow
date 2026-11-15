import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import SupportAIConfig from './SupportAIConfig';
import SupportInsightsTab from './tabs/SupportInsightsTab';
import SupportInboxHeader from './SupportInboxHeader';
import SupportMailboxBanner from './SupportMailboxBanner';
import SupportThreadDetail from './SupportThreadDetail';
import SupportThreadList from './SupportThreadList';
import useConfirm from '../shared/useConfirm';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { useTranslation } from '@/hooks/useTranslation';
import { useShellProps } from '@/authedApp/useShellProps';
import type { SupportInboxPanelProps } from './SupportInboxPanel.types';
import { resolveSupportPath, supportPath, type SupportSettingsSection, type SupportView } from './supportPath';
import { useSupportBulk, useSupportReplyComposer, useSupportThreadEdits } from './useSupportInboxActions';
import { useSupportMailbox } from './useSupportMailbox';
import { useSupportSelectedThread } from './useSupportSelectedThread';
import { useSupportStream } from './useSupportStream';
import { useSupportThreadList } from './useSupportThreadList';

/**
 * Where the panel is: its address (admin/support/<view>/<item>) when the host
 * names one, and the viewer's own clicks in between, written back to the
 * address so a reload or Back lands in the same place.
 */
function useSupportLocation({ view: viewProp, item, focusThreadId, onNavigate: onNavigateProp }: SupportInboxPanelProps) {
    const { onNavigate } = useShellProps({ onNavigate: onNavigateProp });
    // `focusThreadId` is the old single segment (a ticket id, or now a view name).
    const seg2 = viewProp ?? focusThreadId ?? null;
    const seg3 = viewProp != null ? item ?? null : null;
    const location = resolveSupportPath(seg2, seg3);
    const [view, setView] = useState<SupportView>(location.view);
    const [selectedId, setSelectedId] = useState<string | null>(location.threadId);
    const [section, setSection] = useState<SupportSettingsSection>(location.section);
    useAdjustOnChange([location.view, location.threadId, location.section], () => {
        setView(location.view);
        setSelectedId(location.threadId);
        setSection(location.section);
    });
    const go = (path: string) => onNavigate?.(path);
    return {
        view, selectedId, section, setSelectedId,
        openView: (next: string) => {
            const target = resolveSupportPath(next).view;
            setView(target);
            go(supportPath(target, target === 'inbox' ? selectedId : target === 'settings' ? section : null));
        },
        openThread: (id: string | null) => { setSelectedId(id); go(supportPath('inbox', id)); },
        openSection: (id: SupportSettingsSection) => { setView('settings'); setSection(id); go(supportPath('settings', id)); },
    };
}

/**
 * The support inbox: the tickets with the open one beside them (on a phone
 * the list, then the ticket with a way back), the settings of the support
 * desk, and its insights report, each at its own address.
 */
export default function SupportInboxPanel(props: SupportInboxPanelProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { view, selectedId, section, setSelectedId, openView, openThread, openSection } = useSupportLocation(props);
    const list = useSupportThreadList();
    const { counts, loading, fetchThreads } = list;
    const { mailbox, disconnecting, fetchMailbox, disconnectMailbox } = useSupportMailbox({ confirm, setSelectedId });
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
        <div className="flex h-full flex-col bg-[var(--bg-primary)]">
            <SupportInboxHeader activeTotal={activeTotal} resolved={counter('resolved')} view={view} setView={openView} loading={loading} onRefresh={fetchThreads} />

            {/* A mailbox is feeding this inbox: offer a way out of it. */}
            {view === 'inbox' && mailbox?.connected && (
                <SupportMailboxBanner mailbox={mailbox} disconnecting={disconnecting} onDisconnect={disconnectMailbox} />
            )}

            {view === 'settings' && (
                <div className="min-h-0 flex-1">
                    <SupportAIConfig section={section} onSection={openSection} />
                </div>
            )}
            {view === 'insights' && (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <SupportInsightsTab />
                </div>
            )}
            {view === 'inbox' && (
                // The tickets beside the open one; below md one at a time, the open ticket with a way back to the list.
                <div className="flex min-h-0 flex-1">
                    <aside
                        className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-[var(--border-subtle)] md:w-80 md:border-r lg:w-96`}
                        aria-label={t('support.inbox_tickets', 'Tickets')}
                    >
                        <SupportThreadList
                            list={list} bulk={bulk} selectedId={selectedId} setSelectedId={openThread} counter={counter}
                            activeTotal={activeTotal} onOpenConnections={() => openSection('connections')}
                        />
                    </aside>
                    <main className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col overflow-y-auto`}>
                        {selectedId && (
                            <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-2 md:hidden">
                                <button
                                    type="button"
                                    onClick={() => openThread(null)}
                                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                                >
                                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {t('support.inbox_back_to_list', 'All tickets')}
                                </button>
                            </div>
                        )}
                        <div className="min-h-0 flex-1">
                            <SupportThreadDetail selected={selected} edits={edits} composer={composer} selectedId={selectedId} fetchThreads={fetchThreads} />
                        </div>
                    </main>
                </div>
            )}
            {confirmDialog}
        </div>
    );
}
