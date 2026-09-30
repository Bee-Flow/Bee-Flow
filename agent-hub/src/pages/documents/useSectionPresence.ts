// Who else has this designed document open, and which section they are
// typing in ("Anna is editing Pricing"), for a document filed in a project.
//
// This editor sends a heartbeat (POST /:id/presence) when it opens, every
// BEAT_MS, and when its mode or caret section changes; the answer lists the
// others. Inside the project workspace the same beats also arrive at once as
// transient `document.presence` events on the project's live stream. Nothing
// here ever blocks or pops up: presence is optional, a failed beat is a log
// line, and the peers simply age out.
//
// The answer to a beat is only what the server that took it knows: with more
// than one server, a colleague whose beats land on another one is never in
// it, and reaches this editor through the live stream alone. So an answer is
// folded INTO what the stream said, never put in its place: a peer the answer
// leaves out that came from the stream stays until it ages out or leaves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectLive } from '../../components/projects/workspace/ProjectLiveContext';
import { logger } from '../../utils/logger';
import { postPresence } from './documentsApi';
import type { People } from './documentQueries';

export const BEAT_MS = 20_000;
const DEFAULT_TTL_MS = 45_000;
const CHANGE_DEBOUNCE_MS = 400;

export interface PresencePeer {
    userId: string;
    clientId: string;
    sectionId: string | null;
    state: 'viewing' | 'editing';
    at: number;
    /** Last heard of through the live stream (it may be on another server). */
    viaStream?: boolean;
}

export interface SectionPresenceOptions {
    documentId: string;
    /** Only a document filed in a project has anybody else to see. */
    enabled: boolean;
    editing: boolean;
    caretSection: string | null;
    currentUserId: string | null;
}

function newClientId(): string {
    try { return crypto.randomUUID().replace(/-/g, '').slice(0, 24); } catch { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
}

export type PeerMap = Record<string, PresencePeer>;

/**
 * A beat's answer folded into the peers. A peer the live stream told us about
 * is the stream's: it carries every beat, whichever server took it, so it is
 * never older than one server's memory; that peer stays until it leaves or
 * ages out. Every other peer is as the answer has it now.
 */
export function foldAnswer(prev: PeerMap, peers: unknown, now: number): PeerMap {
    const next: PeerMap = {};
    for (const [id, p] of Object.entries(prev)) if (p.viaStream) next[id] = p;
    for (const p of Array.isArray(peers) ? peers : []) {
        if (!p?.clientId || !p?.userId || next[p.clientId]) continue;
        next[p.clientId] = { userId: p.userId, clientId: p.clientId, sectionId: p.sectionId || null, state: p.state === 'editing' ? 'editing' : 'viewing', at: now };
    }
    return next;
}

/** The live stream's beats, folded into the map. */
function useLiveBeats(documentId: string, clientId: string, enabled: boolean, setPeers: React.Dispatch<React.SetStateAction<PeerMap>>) {
    const { subscribe } = useProjectLive();
    useEffect(() => {
        if (!enabled) return undefined;
        return subscribe((kind, event) => {
            if (kind !== 'document.presence' || event?.targetId !== documentId) return;
            const p = event.payload || {};
            if (!p.clientId || p.clientId === clientId || !event.actorId) return;
            setPeers((prev) => {
                const next = { ...prev };
                if (p.state === 'left') delete next[p.clientId];
                else next[p.clientId] = { userId: event.actorId as string, clientId: p.clientId, sectionId: p.sectionId || null, state: p.state === 'editing' ? 'editing' : 'viewing', at: Date.now(), viaStream: true };
                return next;
            });
        });
    }, [documentId, clientId, enabled, subscribe, setPeers]);
}

/** Peers older than the TTL go. */
function useExpiry(ttl: number, setPeers: React.Dispatch<React.SetStateAction<PeerMap>>) {
    useEffect(() => {
        const timer = setInterval(() => {
            const now = Date.now();
            setPeers((prev) => {
                const keep = Object.fromEntries(Object.entries(prev).filter(([, p]) => now - p.at <= ttl));
                return Object.keys(keep).length === Object.keys(prev).length ? prev : keep;
            });
        }, 10_000);
        return () => clearInterval(timer);
    }, [ttl, setPeers]);
}

export default function useSectionPresence({ documentId, enabled, editing, caretSection, currentUserId }: SectionPresenceOptions) {
    const clientId = useMemo(newClientId, []);
    const [peers, setPeers] = useState<PeerMap>({});
    const [people, setPeople] = useState<People>({});
    const [ttl, setTtl] = useState(DEFAULT_TTL_MS);
    const state = useRef({ editing, caretSection });
    useEffect(() => { state.current = { editing, caretSection }; });

    const beat = useCallback(async () => {
        const { editing: isEditing, caretSection: section } = state.current;
        try {
            const out = await postPresence(documentId, { clientId, state: isEditing ? 'editing' : 'viewing', sectionId: isEditing ? section : null });
            setPeers((prev) => foldAnswer(prev, out?.peers, Date.now()));
            if (out?.people) setPeople((prev) => ({ ...prev, ...out.people }));
            if (Number(out?.ttlMs) > 0) setTtl(Number(out.ttlMs));
        } catch (err: any) {
            logger.warn('[Documents] presence heartbeat failed:', err?.status || err?.message);
        }
    }, [documentId, clientId]);

    useEffect(() => {
        if (!enabled) return undefined;
        beat();
        const timer = setInterval(beat, BEAT_MS);
        const leave = () => { postPresence(documentId, { clientId, state: 'left' }).catch(() => undefined); };
        window.addEventListener('pagehide', leave);
        return () => { clearInterval(timer); window.removeEventListener('pagehide', leave); leave(); };
    }, [enabled, beat, documentId, clientId]);

    // Where this editor is changed: say so soon, once it settles.
    useEffect(() => {
        if (!enabled) return undefined;
        const timer = setTimeout(beat, CHANGE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [enabled, editing, caretSection, beat]);

    useLiveBeats(documentId, clientId, enabled, setPeers);
    useExpiry(ttl, setPeers);

    const list = useMemo(() => Object.values(peers).filter((p) => p.clientId !== clientId && p.userId !== currentUserId), [peers, clientId, currentUserId]);
    return { peers: list, people, clientId };
}
