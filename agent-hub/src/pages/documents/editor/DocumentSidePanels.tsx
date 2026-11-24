// The right-hand panels of a document editor: the outline, the version
// history (shared VersionHistoryPanel) and the comments (shared
// CommentsPanel). One at a time, beside the document, or over it where the
// editor is too narrow to share (`placement`).

import type { CommentAnchor } from '@/api/queries/comments';
import type { ProjectRole } from '@/api/queries/projects';
import CommentsPanel from '@/components/comments/CommentsPanel';
import SuggestionsPanel, { type SuggestionsPanelProps } from '@/components/suggestions/SuggestionsPanel';
import VersionHistoryPanel from '@/components/versions/VersionHistoryPanel';
import type { WorkspaceUser } from '@/components/projects/workspace/types';
import useTranslation from '@/hooks/useTranslation';
import type { OutlineItem } from '../canvasBridge';
import type { People, StudioDocument } from '../documentQueries';
import OutlinePanel from './OutlinePanel';
import { panelFrame, type PanelPlacement } from './ui';
import type { SidePanel } from './DesignedToolbar';

export interface DocumentSidePanelsProps {
    side: SidePanel;
    onClose: () => void;
    doc: StudioDocument;
    canEdit: boolean;
    currentUser: WorkspaceUser | null;
    people: People;
    outline: { items: OutlineItem[]; activeSection: string | null; busySections: Record<string, string>; onGo: (item: OutlineItem) => void };
    onRestored: (current: unknown) => void;
    /**
     * The revision a restore is checked against; defaults to the document's.
     * A page edited live passes null: checkpoints move its revision while
     * people type, so any revision this screen holds is already stale.
     */
    expectedVersion?: string | null;
    comments: {
        getSelectionAnchor: () => CommentAnchor | null;
        highlightAnchors: (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;
        scrollToAnchor: (anchor: CommentAnchor) => boolean;
        getDocumentText?: () => string;
    };
    /** Pages only: the AI's proposed changes, beside the page. */
    suggestions?: Pick<SuggestionsPanelProps, 'focusedId' | 'onFocus' | 'highlight' | 'scrollToAnchor' | 'onAccepted'>;
    /** Beside the document (default), or over it where there is no room (see ui.ts panelFrame). */
    placement?: PanelPlacement;
}

/** The reader's role for the comments: the project's word, or what the document says they may do. */
function commentRole(doc: StudioDocument, canEdit: boolean): ProjectRole {
    return doc.projectRole || (canEdit ? 'editor' : 'viewer');
}

export default function DocumentSidePanels(props: DocumentSidePanelsProps) {
    const { t } = useTranslation();
    const { side, doc, onClose, placement = 'beside' } = props;
    if (side === 'outline') {
        if (placement === 'beside') return <OutlinePanel {...props.outline} onClose={onClose} />;
        return <div className={panelFrame(placement)}><OutlinePanel {...props.outline} onClose={onClose} fill /></div>;
    }
    if (side === 'history') {
        return (
            // The history is a drawer of its own (fixed, it widens to compare), so
            // its wrapper takes no room: a column beside the sheet would stay empty.
            <div className="contents" data-testid="document-history">
                <VersionHistoryPanel
                    baseUrl={`/api/studio-documents/${encodeURIComponent(doc.id)}`}
                    canEdit={props.canEdit}
                    managed={doc.managed}
                    onRestored={props.onRestored}
                    onClose={onClose}
                    projectId={doc.projectId || null}
                    people={props.people}
                    currentUserId={props.currentUser?.id || null}
                    expectedVersion={props.expectedVersion === undefined ? doc.versionId : props.expectedVersion}
                    title={t('documents.history_title', 'Version history')}
                />
            </div>
        );
    }
    if (side === 'suggestions' && props.suggestions) {
        return (
            <div className={panelFrame(placement)} data-testid="document-suggestions">
                <SuggestionsPanel documentId={doc.id} canEdit={props.canEdit} onClose={onClose} className="h-full" {...props.suggestions} />
            </div>
        );
    }
    if (side === 'comments' && doc.projectId) {
        return (
            <div className={panelFrame(placement)} data-testid="document-comments">
                <CommentsPanel
                    projectId={doc.projectId}
                    targetType="document"
                    targetId={doc.id}
                    role={commentRole(doc, props.canEdit)}
                    currentUser={props.currentUser}
                    getSelectionAnchor={props.comments.getSelectionAnchor}
                    highlightAnchors={props.comments.highlightAnchors}
                    scrollToAnchor={props.comments.scrollToAnchor}
                    getDocumentText={props.comments.getDocumentText}
                    onClose={onClose}
                    className="h-full"
                />
            </div>
        );
    }
    return null;
}
