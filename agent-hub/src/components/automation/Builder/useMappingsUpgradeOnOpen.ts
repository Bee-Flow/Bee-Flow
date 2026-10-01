import { useEffect, useMemo, useRef, useState } from 'react';
import { legacyBindings } from '@shared/mapping/index.mjs';
import scopedStorage from '../../../utils/scopedStorage';
import { applyUpgradeOnOpen, type UpgradeReport } from '../../../api/queries/automation/upgradeMappings';
import { useRestoreVersionMutation } from '../../../api/queries/automation/versions';

/**
 * "Update mappings" when an automation is opened (M8b of the data-mapping
 * work). Two ways, both only for someone who may edit it and never on the
 * Runs view:
 *
 *   the banner   "This automation can be updated to the new mappings.
 *                [Update] [Later]": shown when the definition still holds a
 *                legacy binding an upgrade could rewrite (shared/mapping
 *                legacyBindings: no request at all when there is none).
 *                Update opens the same dialog as Settings › General (dry run
 *                first). Later hides it for this automation, for this person
 *                (scopedStorage: per viewer, per browser).
 *   automatic    when the organisation switched "Update mappings
 *                automatically when an automation is opened" on, opening it
 *                applies the provably-equal upgrade once (the server decides:
 *                with the setting off it answers `autoOff` and reads nothing),
 *                as a new version, and offers Undo, which restores the
 *                version before it. Never the AI fix. Not while the canvas
 *                holds edits the server does not have (`pristine`), and not
 *                adopted when it gets such edits while the request is out:
 *                the canvas wins and is written again (`onSuperseded`), so
 *                the server never keeps the upgrade without the edit. Undo
 *                goes as soon as the canvas or the saved version moves on:
 *                restoring the version before the update would throw away
 *                whatever came after it.
 *
 * The banner does not come back for the same legacy bindings once the person
 * has looked (closed the dialog): what stays after that is what the upgrade
 * cannot take. It comes back when they change (a new formula, a new step).
 * Undo counts as Later: the person said no to this automation's upgrade.
 */

type Row = Record<string, unknown>;

interface Memory { later?: boolean; checked?: string }

/** The per-viewer memory key of one automation. */
export const memoryKey = (automationId: string) => `mappingsUpgrade:${automationId}`;

/** A short fingerprint of what is left to upgrade ('' when nothing is). */
export function legacyFingerprint(definition: unknown): string {
    const sites = legacyBindings(definition);
    if (!sites.length) return '';
    const text = JSON.stringify(sites);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${sites.length}:${h.toString(36)}`;
}

function readMemory(id: string | null): Memory {
    if (!id) return {};
    try {
        const v = scopedStorage.getJSON<Memory>(memoryKey(id), {});
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

export interface AutoNotice {
    /** How many fields the update on open rewrote. */
    count: number;
    /** The version row to restore for Undo; null when the server knows none (or none that is exactly what it replaced). */
    previousVersionId: string | null;
    /** The version the update saved: Undo only while the row is still at it. */
    savedVersion: number | null;
    state: 'applied' | 'undoing' | 'undone' | 'undo_failed';
}

/**
 * What the hook reads off the row: its id, whether this person may edit it
 * (as Settings › General decides: owner or edit; a row without a role is the
 * owner's own), and the version an update on open is for.
 */
function rowFacts(automation: Row | null | undefined) {
    const id = typeof automation?.id === 'string' ? automation.id : null;
    const role = typeof automation?.myRole === 'string' ? automation.myRole : 'owner';
    return {
        id,
        canEdit: !!id && (role === 'owner' || role === 'edit') && automation?.definitionRedacted !== true,
        version: typeof automation?.version === 'number' ? automation.version : null,
    };
}

/** How long the "Mappings updated · Undo" line stays. */
const NOTICE_MS = 15_000;

/** The notice of an update on open that saved. */
function appliedNotice(r: UpgradeReport, row: Row): AutoNotice {
    const savedVersion = typeof row.version === 'number' ? row.version : r.version;
    return { count: r.changed.length, previousVersionId: r.previous?.versionId ?? null, savedVersion, state: 'applied' };
}

/**
 * Undo restores the version before the update: once the canvas holds an
 * edit, or the row is at a version after the update's, that would throw the
 * newer work away. The notice goes, Undo with it; Saved versions still has
 * them all.
 */
function undoIsStale(notice: AutoNotice | null, pristine: boolean, version: number | null): boolean {
    if (notice?.state !== 'applied') return false;
    if (!pristine) return true;
    return notice.savedVersion !== null && version !== null && version !== notice.savedVersion;
}

interface UpgradeOnOpenProps {
    /** The saved row (null for a Step or before it loads). */
    automation: Row | null | undefined;
    /** The Editor is showing, and no run is: never during a run view. */
    active: boolean;
    /** The canvas holds what the server holds (no unsaved or AI-drafted edits). */
    pristine: boolean;
    /** The definition was rewritten on the server (applied, or undone): adopt the row. */
    onApplied: (row: Row) => void;
    /** The update on open saved while the canvas was edited: write the canvas again. */
    onSuperseded?: () => void;
}

export default function useMappingsUpgradeOnOpen({ automation, active, pristine, onApplied, onSuperseded }: UpgradeOnOpenProps) {
    const { id, canEdit, version } = rowFacts(automation);
    const fingerprint = useMemo(() => legacyFingerprint(automation?.definition), [automation?.definition]);

    const [memory, setMemory] = useState<{ id: string | null; value: Memory }>(() => ({ id, value: readMemory(id) }));
    const current = memory.id === id ? memory.value : readMemory(id);
    const remember = (patch: Memory) => {
        if (!id) return;
        const value = { ...readMemory(id), ...patch };
        try { scopedStorage.setJSON(memoryKey(id), value); } catch { /* storage unavailable: this visit only */ }
        setMemory({ id, value });
    };

    const [dialogOpen, setDialogOpen] = useState(false);
    const [autoPending, setAutoPending] = useState(false);
    const [notice, setNotice] = useState<AutoNotice | null>(null);
    const restore = useRestoreVersionMutation(id ?? '');

    // The latest of each, for the callbacks below and the one-shot effect.
    const latest = useRef({ fingerprint, onApplied, onSuperseded, pristine });
    latest.current = { fingerprint, onApplied, onSuperseded, pristine };
    const tried = useRef<string | null>(null);
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    // Once per automation per mount: ask the server to apply the update on
    // open. It answers `autoOff` (nothing read, nothing saved) unless the
    // organisation switched it on.
    const ready = active && canEdit && !!fingerprint && !current.later;
    useEffect(() => {
        if (!ready || !pristine || !id || tried.current === id) return;
        tried.current = id;
        setAutoPending(true);
        applyUpgradeOnOpen(id, version)
            .then((r) => {
                if (!mounted.current || !r.saved || !r.automation) return;
                // Edited while the request was out: adopting the row would drop
                // the edit, whose save may have landed before the update did.
                // The canvas wins; the banner can offer the update again later.
                if (!latest.current.pristine) { latest.current.onSuperseded?.(); return; }
                latest.current.onApplied(r.automation);
                const next = legacyFingerprint(r.automation.definition);
                const value = { ...readMemory(id), checked: next };
                try { scopedStorage.setJSON(memoryKey(id), value); } catch { /* this visit only */ }
                setMemory({ id, value });
                setNotice(appliedNotice(r, r.automation));
            })
            .catch(() => {}) // Silent: the banner below still offers the update by hand.
            .finally(() => { if (mounted.current) setAutoPending(false); });
    }, [ready, pristine, id, version]);

    const undoStale = undoIsStale(notice, pristine, version);
    useEffect(() => { if (undoStale) setNotice(null); }, [undoStale]);

    useEffect(() => {
        if (!notice || notice.state === 'undoing') return undefined;
        const timer = setTimeout(() => setNotice(null), NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);

    const banner = ready && current.checked !== fingerprint && !autoPending && !notice && !dialogOpen;

    return {
        automationId: id,
        banner,
        dialogOpen,
        notice: undoStale ? null : notice,
        openDialog: () => setDialogOpen(true),
        /** Closing the dialog: these legacy bindings have been looked at. */
        closeDialog: () => {
            setDialogOpen(false);
            remember({ checked: latest.current.fingerprint });
        },
        later: () => remember({ later: true }),
        dismissNotice: () => setNotice(null),
        onDialogApplied: (row: Row) => latest.current.onApplied(row),
        undo: () => {
            if (!notice?.previousVersionId || notice.state !== 'applied' || undoStale) return;
            const versionId = notice.previousVersionId;
            setNotice({ ...notice, state: 'undoing' });
            restore.mutateAsync(versionId)
                .then((row) => {
                    if (!mounted.current) return;
                    if (row) latest.current.onApplied(row);
                    remember({ later: true });
                    setNotice((n) => (n ? { ...n, state: 'undone' } : n));
                })
                .catch(() => { if (mounted.current) setNotice((n) => (n ? { ...n, state: 'undo_failed' } : n)); });
        },
    };
}
