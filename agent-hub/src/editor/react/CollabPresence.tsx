/**
 * CollabPresence — who else is in this document, and whether the live
 * connection is up. For page headers (notebooks, pages): a small avatar stack
 * in each co-editor's caret colour plus a quiet status chip. It never pops
 * anything up: an offline or ended session is a word in the chip, with the
 * reason in its tooltip.
 */
import { Loader2 } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import type { CollabHandle, CollabPeer } from '../collab/useCollab';
import { peerClass } from '../collab/colors';

const MAX_AVATARS = 4;

interface Props {
    handle: CollabHandle | null;
    className?: string;
}

function initials(name: string | undefined): string {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0][0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
    return (first + last).toUpperCase();
}

/** One entry per person (several tabs of one person are one avatar). */
function people(handle: CollabHandle): CollabPeer[] {
    const byUser = new Map<string, CollabPeer>();
    for (const p of handle.peers) {
        if (p.userId === handle.userId) continue;
        const seen = byUser.get(p.userId);
        if (!seen || (p.editing && !seen.editing)) byUser.set(p.userId, p);
    }
    return [...byUser.values()];
}

export default function CollabPresence({ handle, className = '' }: Props) {
    const { t } = useTranslation();
    if (!handle || handle.status === 'disabled') return null;
    const others = people(handle);
    const shown = others.slice(0, MAX_AVATARS);
    const rest = others.length - shown.length;
    const unknown = t('editor.peer_unknown', 'Someone');

    const errorText = (() => {
        switch (handle.lastError) {
            case 'DELETED': return t('editor.presence_error_deleted', 'This item was deleted.');
            case 'ACCESS_REVOKED': case 'FORBIDDEN': return t('editor.presence_error_revoked', 'You no longer have access to this item.');
            case 'UPDATE_TOO_LARGE': case 'DOC_TOO_LARGE': return t('editor.presence_error_too_large', 'This change is too large to share, so the live session stopped. Reload the page to continue, and add large content in smaller parts.');
            default: return t('editor.presence_error_generic', 'The live connection ended. Reload the page to continue.');
        }
    })();

    const chip = (() => {
        switch (handle.status) {
            case 'connecting':
                return { label: t('editor.presence_connecting', 'Connecting…'), title: t('editor.presence_connecting_title', 'Opening the live document'), tone: 'bf-presence-chip--muted', busy: true };
            case 'synced':
                return { label: t('editor.presence_live', 'Live'), title: t('editor.presence_live_title', 'Changes are shared with everyone in this document as you type'), tone: 'bf-presence-chip--live', busy: false };
            case 'readonly':
                return { label: t('editor.presence_readonly', 'View only'), title: t('editor.presence_readonly_title', 'You can read along; editing needs the editor role'), tone: 'bf-presence-chip--muted', busy: false };
            case 'offline':
                return { label: t('editor.presence_offline', 'Offline'), title: t('editor.presence_offline_title', 'Your changes are kept and sent when the connection is back'), tone: 'bf-presence-chip--warn', busy: false };
            default:
                return { label: t('editor.presence_error', 'Not connected'), title: errorText, tone: 'bf-presence-chip--error', busy: false };
        }
    })();

    return (
        <div className={`flex items-center gap-2 ${className}`}>
            {shown.length > 0 && (
                <ul className="flex items-center -space-x-1.5" aria-label={t('editor.presence_group', 'People in this document')}>
                    {shown.map((p) => {
                        const name = p.name || unknown;
                        const label = p.editing
                            ? t('editor.presence_person_editing', '{name} is editing', { name })
                            : t('editor.presence_person_viewing', '{name} is viewing', { name });
                        return (
                            <li key={p.userId} className={`bf-presence-avatar ${peerClass(p.userId)}`} title={label}>
                                <span aria-hidden="true">{initials(p.name)}</span>
                                <span className="sr-only">{label}</span>
                            </li>
                        );
                    })}
                    {rest > 0 && (
                        <li className="bf-presence-avatar bf-presence-avatar--more" title={t('editor.presence_more', '{count} more', { count: rest })}>
                            <span aria-hidden="true">+{rest}</span>
                            <span className="sr-only">{t('editor.presence_more', '{count} more', { count: rest })}</span>
                        </li>
                    )}
                </ul>
            )}
            <span role="status" aria-live="polite" className={`bf-presence-chip ${chip.tone}`} title={chip.title}>
                {chip.busy
                    ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    : <span className="bf-presence-dot" aria-hidden="true" />}
                {chip.label}
            </span>
        </div>
    );
}
