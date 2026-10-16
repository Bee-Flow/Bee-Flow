import { useTranslation } from '../../hooks/useTranslation';
import LinkedIssuesPanel from './LinkedIssuesPanel';
import SupportMessageList from './SupportMessageList';
import SupportReplyComposer from './SupportReplyComposer';
import SupportThreadHeader from './SupportThreadHeader';
import { SupportActivityLog, SupportEmailFailureBanner, SupportFollowupBanner } from './SupportThreadNotices';
import type { useSupportSelectedThread } from './useSupportSelectedThread';
import type { useSupportReplyComposer, useSupportThreadEdits } from './useSupportInboxActions';

interface SupportThreadDetailProps {
    selected: ReturnType<typeof useSupportSelectedThread>;
    edits: ReturnType<typeof useSupportThreadEdits>;
    composer: ReturnType<typeof useSupportReplyComposer>;
    selectedId: string | null;
    fetchThreads: () => Promise<void>;
}

/** The right column of the inbox: the open thread with its banners, conversation and reply box. */
export default function SupportThreadDetail({ selected, edits, composer, selectedId, fetchThreads }: SupportThreadDetailProps) {
    const { t } = useTranslation();
    const { thread, messages, fetchThread, showActivity, setShowActivity, activity } = selected;
    return (
        <div className="col-span-8 flex flex-col min-h-0 bg-[var(--bg-card)]">
            {!thread ? (
                <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
                    {t('support.support_inbox_select_a_thread_to_view_the', 'Select a thread to view the conversation')}
                </div>
            ) : (
                <>
                    <SupportThreadHeader thread={thread} edits={edits} />

                    <SupportFollowupBanner thread={thread} onClear={edits.clearFollowup} />

                    <LinkedIssuesPanel thread={thread} onChanged={() => { fetchThread(selectedId); fetchThreads(); }} />

                    <SupportEmailFailureBanner messages={messages} />

                    <SupportActivityLog activity={activity} showActivity={showActivity} setShowActivity={setShowActivity} />

                    <SupportMessageList messages={messages} />
                    <SupportReplyComposer composer={composer} />
                </>
            )}
        </div>
    );
}
