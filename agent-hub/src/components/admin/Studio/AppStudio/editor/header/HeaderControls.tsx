/**
 * Three controls of the header's row 1: the five view segments, the save
 * notices ("⚠ n to check" and its portalled panel) and the publish pill.
 */
import { Database, Eye, Pencil, Shield, UploadCloud, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HeaderView, PublishState, RevealTarget } from './headerModel';
import useTranslation from '@/hooks/useTranslation';
import SegmentedControl from '@/components/shared/SegmentedControl';
import StatusActionPill from '@/components/shared/StatusActionPill';
import { SaveNoticeCapsule, SaveNoticesPanel } from '../SaveStatusPill';
import type { SaveNotice } from '../saveNotices';

interface ViewSegmentsProps {
    view: HeaderView;
    onSelect: (next: HeaderView) => void;
    isManaged: boolean;
    streamLock: boolean;
    /** Edit stays reachable while the AI streams only if it is already open. */
    editing: boolean;
    logicCount: number;
}

const segmentLabel = (text: string) => <span className="@max-6xl/edhead:sr-only">{text}</span>;

/** The five segments — centered. Below @6xl the words go sr-only, so the names survive. */
export function ViewSegments({ view, onSelect, isManaged, streamLock, editing, logicCount }: ViewSegmentsProps) {
    const { t } = useTranslation();
    return (
        <div className="flex min-w-0 flex-1 justify-center">
            <SegmentedControl<HeaderView>
                size="sm"
                ariaLabel={t('app_studio.header.view_aria', 'Editor view')}
                value={view}
                onChange={(next) => onSelect(next)}
                options={[
                    { value: 'edit', label: segmentLabel(t('app_studio.header.view_edit', 'Edit')), icon: <Pencil className="h-3 w-3" aria-hidden="true" />, disabled: isManaged || (streamLock && !editing) },
                    { value: 'preview', label: segmentLabel(t('app_studio.header.view_preview', 'Preview')), icon: <Eye className="h-3 w-3" aria-hidden="true" /> },
                    { value: 'data', label: segmentLabel(t('app_studio.header.view_data', 'Data')), icon: <Database className="h-3 w-3" aria-hidden="true" />, disabled: streamLock },
                    { value: 'logic', label: segmentLabel(t('app_studio.header.view_logic', 'Logic')), icon: <Workflow className="h-3 w-3" aria-hidden="true" />, badge: logicCount || null, disabled: streamLock },
                    { value: 'roles', label: segmentLabel(t('app_studio.header.view_roles', 'Roles')), icon: <Shield className="h-3 w-3" aria-hidden="true" />, disabled: streamLock },
                ]}
            />
        </div>
    );
}

export interface HeaderNotice extends SaveNotice {
    target: RevealTarget | null;
}

interface SaveNoticesControlProps {
    status?: string;
    error?: string | null;
    onRetry?: () => void;
    notices: HeaderNotice[];
    /** "Show me": go to the notice's screen and component. */
    onShow: (target: RevealTarget) => void;
}

/** What the server reported about the last save. */
export function SaveNoticesControl({ status, error, onRetry, notices, onShow }: SaveNoticesControlProps) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!notices.length) setOpen(false);
    }, [notices]);
    // Anchor for the portalled save-notices panel. It used to be a plain
    // `absolute right-0 top-full` child of the pill's wrapper — the one header
    // overlay that was not a portal — and the center column's overflow-x-clip
    // cut it off whenever the wrapped header put the pill near the column's
    // left edge. Same cure as every other menu here: AnchoredMenu.
    const anchorRef = useRef<HTMLDivElement>(null);
    const showNotice = (entry: HeaderNotice) => {
        if (!entry.target) return;
        onShow(entry.target);
        setOpen(false);
    };
    return (
        <>
            <div className="shrink-0 empty:hidden" ref={anchorRef}>
                <SaveNoticeCapsule
                    status={status}
                    error={error}
                    onRetry={onRetry}
                    noticeCount={notices.length}
                    noticesOpen={open}
                    onToggleNotices={() => setOpen((o) => !o)}
                />
            </div>
            <SaveNoticesPanel
                open={open}
                anchorRef={anchorRef}
                notices={notices}
                onShow={showNotice}
                onClose={() => setOpen(false)}
            />
        </>
    );
}

interface PublishPillProps {
    publishState: PublishState;
    pillStatus: string;
    isManaged: boolean;
    disabled: boolean;
    onPublish: () => void;
}

/** Publish — the shared split pill: status word | the one next action. */
export function PublishPill({ publishState, pillStatus, isManaged, disabled, onPublish }: PublishPillProps) {
    const { t } = useTranslation();
    const publishTitle = isManaged || publishState === 'unknown'
        ? t('app_studio.header.publish_unknown_title', 'Choose who can use this app')
        : publishState === 'behind'
            ? t('app_studio.header.publish_behind_title', 'The version people use is older than what you see here — publish to make these changes live.')
            : t('app_studio.header.publish_current_title', 'Everything on this canvas is live.');
    const publishLabel = publishState === 'behind' && !isManaged
        ? t('app_studio.header.publish_changes', 'Publish changes')
        : t('app_studio.header.publish', 'Publish');
    return (
        <StatusActionPill
            status={pillStatus}
            containerName="edhead"
            testId="publish-pill"
            action={{
                label: publishLabel,
                ariaLabel: publishLabel,
                icon: UploadCloud,
                onClick: onPublish,
                disabled,
                title: publishTitle,
                primary: publishState !== 'current',
            }}
        />
    );
}
