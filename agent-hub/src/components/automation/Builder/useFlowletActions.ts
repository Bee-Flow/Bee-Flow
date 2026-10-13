import { useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import useFlowletAgentStream from '../../../hooks/useFlowletAgentStream';
import { toast } from '../../shared/Toast';
import {
    deleteLayerFromDefinition, deleteLayerAndCalls,
    isLayerEmpty, renameLayer, countLayerRefs,
} from './flow/flowletScope';

export interface UseFlowletActionsOptions {
    effectiveDef: any;
    scopeKey: string | null;
    setScopeKey: (key: string | null) => void;
    ensureAutomationCreated: (defForCreate?: any) => Promise<any>;
    onVisualEditRoot: (def: any) => void;
    onSaveAutomation: (patch: any) => Promise<void>;
    confirm: (opts: any) => Promise<boolean>;
    readOnlyRef: MutableRefObject<boolean>;
}

/**
 * The flowlet the canvas is drilled into: building or refining one with AI,
 * renaming it from the header's title, leaving it, and deleting it. Split out
 * of BuilderShell without a change in behaviour.
 */
export default function useFlowletActions({
    effectiveDef, scopeKey, setScopeKey, ensureAutomationCreated, onVisualEditRoot, onSaveAutomation, confirm, readOnlyRef,
}: UseFlowletActionsOptions) {
    // ── AI flowlet builder (separate from chat) ─────────────────────────────
    // Drives the Flowlets panel's "Build a flowlet with AI" / "Refine with AI".
    // The endpoint already persists the new def server-side; we mirror it
    // into the local draft + history via onVisualEditRoot (one undo entry),
    // exactly like every other flowlet edit. Returns true on success so the
    // panel can collapse its composer.
    const layerAgent = useFlowletAgentStream();
    const onBuildLayer = useCallback(async (instruction: any) => {
        if (!instruction || !instruction.trim() || readOnlyRef.current) return false;
        const aid = await ensureAutomationCreated();
        if (!aid) { toast.error('Could not save the automation. Try again.'); return false; }
        const r = await layerAgent.send({ automationId: aid, instruction, mode: 'create' });
        if (r.error) { toast.error(`Couldn't build the flowlet. ${r.error}`.trim()); return false; }
        if (r.draft) {
            onVisualEditRoot(r.draft);
            if (r.layerKey) setScopeKey(r.layerKey); // drill into the new flowlet
            toast.success('Flowlet built.');
            return true;
        }
        return false;
    }, [ensureAutomationCreated, layerAgent, onVisualEditRoot]);

    const onRefineLayer = useCallback(async (layerKey: any, instruction: any) => {
        if (!layerKey || !instruction || !instruction.trim() || readOnlyRef.current) return false;
        const aid = await ensureAutomationCreated();
        if (!aid) { toast.error('Could not save the automation. Try again.'); return false; }
        const r = await layerAgent.send({ automationId: aid, instruction, mode: 'refine', layerKey });
        if (r.error) { toast.error(`Couldn't refine the flowlet. ${r.error}`.trim()); return false; }
        if (r.draft) { onVisualEditRoot(r.draft); toast.success('Flowlet updated.'); return true; }
        return false;
    }, [ensureAutomationCreated, layerAgent, onVisualEditRoot]);

    const onRename = async (nextTitle: any) => {
        // While drilled into a flowlet the inline title edits the FLOWLET's
        // title — a definition edit, not an automation-row PATCH.
        if (scopeKey) {
            if (effectiveDef?.layers?.[scopeKey]) {
                onVisualEditRoot(renameLayer(effectiveDef, scopeKey, nextTitle));
            }
            return;
        }
        try { await onSaveAutomation({ title: nextTitle }); }
        catch (e: any) { console.warn('[BuilderShell] rename failed:', e.message); }
    };

    // Header scope descriptor + delete-flowlet action. refCount blocks the
    // delete button while any call_layer (root or sibling flowlet) still
    // references this flowlet — unless the flowlet is EMPTY, in which case
    // there is nothing to lose and the call sites go with it (BFSF-340).
    const scope = useMemo(() => {
        if (!scopeKey) return null;
        const layer = effectiveDef?.layers?.[scopeKey];
        if (!layer) return null;
        return {
            key: scopeKey,
            title: layer.title || scopeKey,
            refCount: countLayerRefs(effectiveDef, scopeKey),
            empty: isLayerEmpty(effectiveDef, scopeKey),
        };
    }, [scopeKey, effectiveDef]);

    const onExitScope = useCallback(() => setScopeKey(null), []);

    const onDeleteLayer = useCallback(async () => {
        if (!scopeKey || !effectiveDef?.layers?.[scopeKey]) return;
        const refs = countLayerRefs(effectiveDef, scopeKey);
        if (refs > 0) {
            if (!isLayerEmpty(effectiveDef, scopeKey)) return;
            const label = effectiveDef.layers[scopeKey].title || scopeKey;
            const ok = await confirm({
                title: `Delete the empty flowlet “${label}”?`,
                description: `Its ${refs} “Call flowlet” ${refs === 1 ? 'step' : 'steps'} on the canvas ${refs === 1 ? 'is' : 'are'} removed too; the steps around ${refs === 1 ? 'it' : 'them'} reconnect.`,
                confirmLabel: 'Delete',
                destructive: true,
            });
            if (!ok) return;
            onVisualEditRoot(deleteLayerAndCalls(effectiveDef, scopeKey));
            setScopeKey(null);
            return;
        }
        onVisualEditRoot(deleteLayerFromDefinition(effectiveDef, scopeKey));
        setScopeKey(null);
    }, [scopeKey, effectiveDef, onVisualEditRoot, confirm]);

    return { layerAgent, onBuildLayer, onRefineLayer, onRename, scope, onExitScope, onDeleteLayer };
}
