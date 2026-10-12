// What the frame reports about a designed document (outline, counts, caret,
// selection), who else is in which section, and what that means for the
// screen: the outline's markers, the peers drawn over their sections, the
// "Anna is also editing Pricing" line.

import { useMemo, useRef, useState } from 'react';
import type { CommentAnchor } from '../../../api/queries/comments';
import { peerColor } from '../../../editor/collab/colors';
import useTranslation from '../../../hooks/useTranslation';
import type { FramePeer, FrameStats, OutlineItem } from '../canvasBridge';
import type { People, StudioDocument } from '../documentQueries';
import useSectionPresence from '../useSectionPresence';

export interface FrameStateOptions {
    doc: StudioDocument;
    editing: boolean;
    currentUserId: string | null;
    extraPeople: People;
}

export default function useFrameState({ doc, editing, currentUserId, extraPeople }: FrameStateOptions) {
    const { t } = useTranslation();
    const [outline, setOutline] = useState<OutlineItem[]>([]);
    const [stats, setStats] = useState<FrameStats | null>(null);
    const [caretSection, setCaretSection] = useState<string | null>(null);
    const selection = useRef<CommentAnchor | null>(null);
    // Who else is here is asked only where somebody else can be: a project, or a document shared with others.
    const shared = !!doc.sharing?.audience && doc.sharing.audience !== 'private';
    const presence = useSectionPresence({
        documentId: doc.id, enabled: !!doc.projectId || shared, editing, caretSection: editing ? caretSection : null, currentUserId,
    });
    const people = useMemo(() => ({ ...extraPeople, ...presence.people }), [extraPeople, presence.people]);
    const nameOf = (id: string) => people[id]?.name || t('documents.presence.someone', 'Someone');

    const sectionLabel = (id: string | null): string | null => {
        if (!id) return null;
        const fromOutline = outline.find((o) => o.sectionId === id && o.text)?.text;
        const fromContract = doc.contract?.sections?.find((s) => s.id === id)?.title;
        return fromOutline || fromContract || null;
    };

    const editingPeers = presence.peers.filter((p) => p.state === 'editing' && p.sectionId);
    const busyLabel = (userId: string) => t('documents.presence.frame_label', '{name} is editing', { name: nameOf(userId) });
    // A new list each render; the canvas compares by content before it redraws.
    const framePeers: FramePeer[] = editingPeers.map((p) => ({ sectionId: p.sectionId as string, label: busyLabel(p.userId), colour: peerColor(p.userId) }));
    const busySections: Record<string, string> = Object.fromEntries(editingPeers.map((p) => [p.sectionId as string, busyLabel(p.userId)]));

    const sameSection = editing && caretSection ? editingPeers.find((p) => p.sectionId === caretSection) : undefined;
    const sharing = sameSection
        ? t('documents.presence.same_section', '{name} is also editing {section}. Keep typing: your changes are combined when you save, and if you both change the same sentence you choose which to keep.', {
            name: nameOf(sameSection.userId), section: sectionLabel(caretSection) || t('documents.outline.untitled', 'Untitled section'),
        })
        : null;

    return {
        outline, setOutline, stats, setStats, caretSection, setCaretSection, selection,
        presence, people, sectionLabel, framePeers, busySections, sharing,
    };
}
