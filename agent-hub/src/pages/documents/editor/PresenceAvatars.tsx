// Who else has the document open: one small avatar per person in their
// co-editing colour, a pencil dot when they are typing, the names and
// sections in the tooltip. Nothing when nobody else is here.

import React from 'react';
import '../../../editor/editor.css';
import { peerClass } from '../../../editor/collab/colors';
import useTranslation from '../../../hooks/useTranslation';
import type { People } from '../documentQueries';
import type { PresencePeer } from '../useSectionPresence';
import { initials } from './ui';

const MAX = 4;

export interface PresenceAvatarsProps {
    peers: PresencePeer[];
    people: People;
    sectionLabel: (sectionId: string | null) => string | null;
}

/** One entry per person; an editing tab wins over a viewing one. */
export function byPerson(peers: PresencePeer[]): PresencePeer[] {
    const out = new Map<string, PresencePeer>();
    for (const p of peers) {
        const seen = out.get(p.userId);
        if (!seen || (p.state === 'editing' && seen.state !== 'editing')) out.set(p.userId, p);
    }
    return [...out.values()];
}

export default function PresenceAvatars({ peers, people, sectionLabel }: PresenceAvatarsProps) {
    const { t } = useTranslation();
    const list = byPerson(peers);
    if (!list.length) return null;
    const nameOf = (id: string) => people[id]?.name || t('documents.presence.someone', 'Someone');
    const describe = (p: PresencePeer) => {
        const where = sectionLabel(p.sectionId);
        if (p.state !== 'editing') return t('documents.presence.viewing', '{name} is viewing', { name: nameOf(p.userId) });
        return where
            ? t('documents.presence.editing_section', '{name} is editing {section}', { name: nameOf(p.userId), section: where })
            : t('documents.presence.editing', '{name} is editing', { name: nameOf(p.userId) });
    };
    return (
        <ul className="flex items-center -space-x-1.5 shrink-0" aria-label={t('documents.presence.label', 'Also here')} data-testid="document-presence">
            {list.slice(0, MAX).map((p) => (
                <li key={p.userId} title={describe(p)} className={`${peerClass(p.userId)} relative w-6 h-6 rounded-full grid place-items-center text-[10px] font-semibold text-white bg-[var(--bf-peer)] ring-2 ring-[var(--bg-secondary)]`}>
                    <span aria-hidden="true">{initials(people[p.userId]?.name)}</span>
                    <span className="sr-only">{describe(p)}</span>
                    {p.state === 'editing' && <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--success)] ring-1 ring-[var(--bg-secondary)]" />}
                </li>
            ))}
            {list.length > MAX && (
                <li className="w-6 h-6 rounded-full grid place-items-center text-[10px] font-semibold bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ring-2 ring-[var(--bg-secondary)]" title={list.slice(MAX).map(describe).join('\n')}>
                    +{list.length - MAX}
                </li>
            )}
        </ul>
    );
}
