import { Users } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import VisibilityCapsule from '../../../components/shared/VisibilityCapsule';
import { toast } from '../../../components/shared/Toast';
import useTranslation from '../../../hooks/useTranslation';
import * as api from '../lib/transcriptionsApi';

/**
 * The meeting's "who can see this" capsule — the shared VisibilityCapsule
 * (Track 0.3) in its 32px header variant, CONTROLLED by this wrapper.
 * Replaces detail/PublishMenu.jsx, which was the third hand-inlined copy of
 * the Personal / Org / Groups menu (borrowing `kb_detail.*` keys, an emerald
 * trigger, an unportalled popover).
 *
 * State lives in the note (`meeting.isPublished` / `meeting.sharedGroups`);
 * every transition PATCHes `/publish` and reports the server's answer back
 * through `onChange({ isPublished, sharedGroups })` so the detail and the
 * library row agree. A failed save toasts and leaves the note as it was —
 * no optimistic flip that the next refresh would silently undo.
 *
 * Non-owners get the capsule disabled: the audience is still readable, the
 * trigger simply cannot open.
 */
export default function MeetingVisibility({ meeting, canManage = true, onChange }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [orgGroups, setOrgGroups] = useState([]);

    useEffect(() => {
        if (!canManage) return undefined;
        let mounted = true;
        api.listOrgGroups().then((groups) => {
            if (mounted) setOrgGroups(Array.isArray(groups) ? groups : []);
        }).catch(() => {});
        return () => { mounted = false; };
    }, [canManage]);

    // A note in a project is open to the members of that project and to nobody else, so who can see it is not
    // a choice here: it is not Personal, and it cannot be opened to the organisation or to groups.
    if (meeting?.projectId) {
        const why = t('visibility.project_locked', 'This note is in a project, so it is open to the whole project and cannot be shared another way. Take it out of the project to change that.');
        return (
            <span title={why} aria-label={`${t('visibility.project', 'Project')}. ${why}`} data-testid="visibility-project-locked"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] cursor-not-allowed">
                <Users size={14} aria-hidden="true" />{t('visibility.project_members', 'Project members')}
            </span>
        );
    }

    const isPublished = !!meeting?.isPublished;
    const sharedGroups = Array.isArray(meeting?.sharedGroups) ? meeting.sharedGroups : [];

    async function save(nextPublished, groups) {
        if (!meeting?.id || saving) return;
        const nextGroups = nextPublished ? (groups || []) : [];
        setSaving(true);
        try {
            const data = await api.publishTranscription(meeting.id, nextPublished, nextGroups);
            onChange?.({
                isPublished: !!data.isPublished,
                sharedGroups: Array.isArray(data.sharedGroups) ? data.sharedGroups : nextGroups,
            });
        } catch (e) {
            toast.error(`${t('meeting_notes.publish_failed', 'Publish failed')}: ${e.message}`);
        } finally {
            setSaving(false);
        }
    }

    const toggleGroup = (gid) => {
        const next = sharedGroups.includes(gid)
            ? sharedGroups.filter((g) => g !== gid)
            : [...sharedGroups, gid];
        // Ticking a group while Personal flips the note to published — groups
        // only make sense once shared (the KB / Agent menu semantics).
        save(true, next);
    };

    return (
        <VisibilityCapsule
            t={t}
            agent={meeting}
            variant="capsule"
            anchored
            confirmWidening
            open={open}
            onToggle={() => setOpen((v) => !v)}
            onClose={() => setOpen(false)}
            isPublished={isPublished}
            sharedGroups={sharedGroups}
            orgGroups={orgGroups}
            onSetPersonal={() => { setOpen(false); save(false, []); }}
            onSetEntireOrg={() => { setOpen(false); save(true, []); }}
            onToggleGroup={toggleGroup}
            disabled={!canManage || saving}
        />
    );
}
