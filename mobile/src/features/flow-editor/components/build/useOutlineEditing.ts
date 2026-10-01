/**
 * The outline's edits, as the build screen runs them against the draft
 * store: putting a picked step where its "+" was (asking first before a
 * trigger replaces the one there, as the web does), and every card action.
 * Each edit is one pure operation through `applyOp`, so it is one undo step
 * and is saved by the store's autosave.
 *
 * A new step's inputs are auto-mapped as the web's BuildTab maps them: with
 * the last test run's real outputs, only while the author's "auto-map when
 * connecting" preference is on, and — for a step added before the catalog
 * answered — once it has (auto-map never overwrites a binding, so late is
 * safe).
 */

import { useEffect, useRef, useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import type { StepRunMode } from '@/features/flow-editor/api';
import { applyAutoMapToStep, autoMapInserted, buildRealOutputMap, type Catalog, type MappedInsert, type RunStepRow } from '@/features/flow-editor/bindings';
import { createLayerInDefinition, defaultTriggerLabel, isTerminalStepType, type FlowDefinition, type StepPayload } from '@/features/flow-editor/model';
import { detachStep, findAtAddress, insertStep, moveStep, stepIdOf, toggleDisabled, togglePin, type AddTarget, type InsertResult, type StepActionId } from '@/features/flow-editor/model/outline';
import { autoMapOnConnect, loadAutoMapPreference, type DraftStore } from '@/features/flow-editor/state';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { deleteKindOf, deleteStep, type DeleteKind } from './deleteModel';
import { duplicateSafely } from './duplicateModel';
import type { RunRow } from '../outline/cardModel';

interface Options {
    store: DraftStore;
    catalog: Catalog | null;
    runByStep: ReadonlyMap<string, RunRow>;
    /** The last test run's rows, for the real outputs auto-map reads. */
    runRows: RunRows;
    onOpen: (address: string) => void;
    onTest: (stepId: string, mode: StepRunMode) => void;
    /** Drill into a flowlet (definition.layers[key]). */
    onOpenFlowlet: (key: string) => void;
}

/**
 * "Create flowlet" — the web's scope-spanning insert: a new flowlet on the
 * whole document and a call to it where the "+" was, as ONE edit, after
 * which the editor drills straight into it.
 */
export function createFlowletOp(target: AddTarget, title: string, made: { key: string | null }) {
    return (d: FlowDefinition) => {
        const { definition, layerKey } = createLayerInDefinition(d, title);
        made.key = layerKey;
        return insertStep(definition, target, { kind: 'call_layer', layerKey, label: title }).definition;
    };
}

type RunRows = readonly Pick<RunStepRow, 'stepId' | 'parentStepId' | 'output'>[];

const realOutputs = (def: FlowDefinition, rows: RunRows) => buildRealOutputMap(def, rows as RunStepRow[]);

const mappedWords = (t: TranslateFn, n: number) => t('mobile.flow.auto_mapped', 'Filled {n} inputs from the step before', { n });

/** Map the steps added before the catalog answered, once it has; one edit, one toast. */
function useLateAutoMap(store: DraftStore, catalog: Catalog | null, runRows: RunRows) {
    const t = useTranslation();
    const { toast } = useToast();
    const pending = useRef<string[]>([]);
    useEffect(() => {
        if (!catalog || !pending.current.length) return;
        const ids = pending.current.splice(0);
        let mapped = 0;
        store.getState().applyOp((def) => {
            let next = def;
            for (const id of ids) {
                const r = applyAutoMapToStep(next, id, catalog, { realOutputById: realOutputs(next, runRows) });
                next = r.definition;
                mapped += r.mappedKeys.length;
            }
            return next;
        });
        if (mapped) toast(mappedWords(t, mapped), 'success');
    }, [catalog, store, runRows, toast, t]);
    return pending;
}

function deleteQuestion(kind: Exclude<DeleteKind, 'plain'>, t: TranslateFn) {
    return kind === 'branching'
        ? {
            title: t('mobile.flow.delete_branching.title', 'Delete this step and its branches’ lines?'),
            message: t(
                'mobile.flow.delete_branching.message',
                'The steps its branches lead to stay, unconnected, so you can wire them as you mean. Undo brings everything back.',
            ),
            confirmLabel: t('common.delete', 'Delete'),
        }
        : {
            title: t('mobile.flow.delete_container.title', 'Delete this step and everything inside it?'),
            message: t('mobile.flow.delete_container.message', 'The steps it holds are deleted with it. Undo brings everything back.'),
            confirmLabel: t('common.delete', 'Delete'),
        };
}

/**
 * A step that ends the run (Stop with error, Back to the app) put between
 * two steps kept its line to the next one, so the outline and the canvas
 * drew those steps as if they still ran after it. That line goes.
 */
export function endHere(result: InsertResult, payload: StepPayload): { result: InsertResult; cut: number } {
    const id = result.addedId;
    if (!id || !isTerminalStepType(payload.kind)) return { result, cut: 0 };
    const edges = result.definition.edges.filter((e) => e.from !== id);
    const cut = result.definition.edges.length - edges.length;
    return cut ? { result: { ...result, definition: { ...result.definition, edges } }, cut } : { result, cut: 0 };
}

/**
 * The "+" under a stack of triggers splices the primary trigger's line to
 * the first step. A second trigger feeding the same step kept its own line
 * past the new step, so a run it started skipped it. Every trigger that
 * enters that step now enters the new step instead.
 */
export function spliceEveryTrigger(result: InsertResult, target: AddTarget, def: FlowDefinition): InsertResult {
    const id = result.addedId;
    if (!id || target.kind !== 'splice' || def.trigger?.id !== target.sourceId) return result;
    const secondary = new Set((def.triggers ?? []).map((tr) => tr?.id).filter(Boolean));
    const edges = result.definition.edges.map((e) =>
        secondary.has(e.from) && e.to === target.targetId ? { ...e, to: id } : e,
    );
    return { ...result, definition: { ...result.definition, edges } };
}

function replaceQuestion(def: FlowDefinition, payload: StepPayload, t: TranslateFn) {
    return {
        title: t('mobile.flow.replace_trigger_title', 'Replace the {from} trigger with {to}?', {
            from: defaultTriggerLabel(def.trigger?.kind || 'manual'), to: defaultTriggerLabel(payload.triggerKind || 'manual'),
        }),
        message: t('mobile.flow.replace_trigger', 'A routine can only have one trigger of these kinds, so the current one and its settings are replaced.'),
        confirmLabel: t('mobile.flow.replace', 'Replace'),
    };
}

/**
 * Does this pick replace the primary trigger? Asked every time, the same kind
 * included: a replacement starts blank, so picking "On form submission" over
 * a form trigger threw its fields away without a word.
 */
function replacesTrigger(def: FlowDefinition, payload: StepPayload): boolean {
    return payload.kind === 'trigger' && !payload.asSecondaryTrigger && !!def.trigger;
}

export function useOutlineEditing({ store, catalog, runByStep, runRows, onOpen, onTest, onOpenFlowlet }: Options) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const [menu, setMenu] = useState<string | null>(null);
    const lateAutoMap = useLateAutoMap(store, catalog, runRows);
    useEffect(() => {
        void loadAutoMapPreference();
    }, []);

    const apply = (op: (def: FlowDefinition) => FlowDefinition) => store.getState().applyOp(op);

    const insert = async (payload: StepPayload, target: AddTarget) => {
        const def = store.getState().definition;
        if (!def) return;
        if (payload.kind === 'create_layer') {
            const made: { key: string | null } = { key: null };
            const title = typeof payload.title === 'string' && payload.title ? payload.title : t('mobile.flow.flowlets.new_title', 'New flowlet');
            if (apply(createFlowletOp(target, title, made)) && made.key) onOpenFlowlet(made.key);
            return;
        }
        if (replacesTrigger(def, payload) && !(await confirm(replaceQuestion(def, payload, t)))) return;
        let result: MappedInsert | null = null;
        let cut = 0;
        apply((d) => {
            const placed = endHere(spliceEveryTrigger(insertStep(d, target, payload), target, d), payload);
            cut = placed.cut;
            result = autoMapInserted(placed.result, { catalog, realOutputById: realOutputs(d, runRows), autoMap: autoMapOnConnect() });
            return result.definition;
        });
        if (cut > 0) toast(t('mobile.flow.ends_here', 'This step ends the run, so the steps after it are no longer connected to it'), 'success');
        if (result) afterInsert(result, payload);
    };

    /** What follows an insert: queue a late auto-map, say what was mapped, open the new step. */
    const afterInsert = (done: MappedInsert, payload: StepPayload) => {
        if (done.awaitingCatalog && done.addedId) lateAutoMap.current.push(done.addedId);
        if (done.mapped) toast(mappedWords(t, done.mapped), 'success');
        if (done.address && payload.kind !== 'trigger' && payload.kind !== 'note') onOpen(done.address);
    };

    /** Delete, asking first where the delete does more than take one step out. */
    const remove = async (address: string) => {
        const kind = deleteKindOf(store.getState().definition, address);
        if (kind !== 'plain' && !(await confirm(deleteQuestion(kind, t)))) return;
        if (apply((d) => deleteStep(d, address))) toast(t('mobile.flow.removed', 'Step removed — Undo brings it back'), 'success');
    };

    const act = (address: string, id: StepActionId) => {
        const handlers: Record<StepActionId, () => void> = {
            open: () => onOpen(address),
            openFlowlet: () => {
                const key = findAtAddress(store.getState().definition, address)?.layerKey;
                if (typeof key === 'string') onOpenFlowlet(key);
            },
            test: () => onTest(stepIdOf(address), 'only'),
            runUpTo: () => onTest(stepIdOf(address), 'upTo'),
            runFrom: () => onTest(stepIdOf(address), 'from'),
            duplicate: () => {
                let copy: string | null = null;
                if (apply((d) => {
                    const done = duplicateSafely(d, address);
                    copy = done.address;
                    return done.definition;
                }) && copy) onOpen(copy);
            },
            moveUp: () => apply((d) => moveStep(d, address, 'up')),
            moveDown: () => apply((d) => moveStep(d, address, 'down')),
            pin: () => apply((d) => togglePin(d, address, runByStep.get(stepIdOf(address))?.output)),
            unpin: () => apply((d) => togglePin(d, address, undefined)),
            disable: () => apply((d) => toggleDisabled(d, address)),
            enable: () => apply((d) => toggleDisabled(d, address)),
            detach: () => apply((d) => detachStep(d, address)),
            delete: () => void remove(address),
            // The sheets open the picker for it (FlowSheets); nothing to do on the card.
            addTrigger: () => undefined,
        };
        handlers[id]();
    };

    return { menu, openMenu: setMenu, closeMenu: () => setMenu(null), insert, act };
}
