/**
 * Build a routine on the phone — the web builder's Build tab (BuildTab.jsx,
 * BuilderShell.jsx, BuilderHeader.jsx) for a touch screen.
 *
 *   header    the routine's name over "Draft · Saved", Go live / Live
 *             (switch off, asked), ⋯ (rename, findings, run history,
 *             versions, flowlets, settings, details, diagnose)
 *   toolbar   Steps | Canvas, Undo, Redo, Ask AI, a test run and more ways
 *             to run (Run live, Start from); a failed save's banner under it,
 *             and on a live routine the saved changes that are not live yet
 *             with Make vN live (PublishBanner)
 *   run line  the last test run: where it is while it goes, where it failed,
 *             its result sheet (components/run)
 *   Steps     the flow as an outline: cards in run order, branches as lanes,
 *             loop bodies and parallel branches as groups, a "+" between
 *             every two cards; tap a card to edit it, hold it for its menu
 *   Canvas    the flow as the web draws it: pan, pinch, the same cards,
 *             lines with a "+" on each; tap a card to edit it, hold it for
 *             the same menu, hold and drag to move it (components/canvas)
 *   findings  a pill over the flow, a list behind it; each finding opens its
 *             step at the section that fixes it
 *   Ask AI    the assistant sheet over the builder stream (components/ai)
 *
 * One draft store holds the routine (useFlowDraft); every edit here is one
 * undoable operation on it, saved by its autosave. A new routine
 * (`id === NEW_FLOW_ID`) starts from a seed and is created on its first edit,
 * then hands over to its own build route (useHandover) — not while the AI is
 * building into it.
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { ErrorState, LoadingState, Screen } from '@/shared/ui';

import type { FlowCatalog } from '../api';
import { AiBuilderSheet, catalogAppLabel, useAssistant, type Assistant } from '../components/ai';
import { BuildBody } from '../components/build/BuildBody';
import { BuildHeader } from '../components/build/BuildHeader';
import { FlowletsSheet } from '../components/build/FlowletsSheet';
import { FlowSheets } from '../components/build/FlowSheets';
import { hasLiveSplit, liveStateOf, type LiveState } from '../components/build/liveState';
import { PublishBanner } from '../components/build/PublishBanner';
import { RenameSheet } from '../components/build/RenameSheet';
import { TemplateSheet } from '../components/build/TemplateSheet';
import { useCardContext } from '../components/build/useCardContext';
import { useHandover } from '../components/build/useHandover';
import { useOutlineEditing } from '../components/build/useOutlineEditing';
import { issueRows, pillSummary } from '../components/issues/issuesModel';
import { IssuesPill } from '../components/issues/IssuesPill';
import { IssuesSheet } from '../components/issues/IssuesSheet';
import { buildPath, flowletPath, stepEditorPath } from '../components/outline/stepRoute';
import { aliasTestRunStore, useTestRuns } from '../components/run';
import { NEW_FLOW_ID, useCatalog, useDraftState, useFlowDraft, usePendingCount, useUnsavedLeave, type FlowDraft } from '../hooks';
import type { FlowDefinition } from '../model';
import type { AddTarget } from '../model/outline';
import { newFlowSeed, type NewFlowKind } from '../state';

interface EditorHeaderProps {
    draft: FlowDraft;
    definition: FlowDefinition;
    live: LiveState | null;
    automationId: string | null;
    busy: boolean;
    findings: number;
    onRename: () => void;
    onFindings: () => void;
    onFlowlets: () => void;
}

/**
 * Where the working copy stands against the live version, or null on a
 * server without the live split (the editor then shows what it always did).
 */
function useLive(row: FlowDraft['automation']): LiveState | null {
    const pending = usePendingCount(row);
    return row && hasLiveSplit(row) ? liveStateOf(row, pending) : null;
}

/** The header, read off the draft: its name, whether it is on, and whether there is anything to switch on. */
function EditorHeader({ draft, definition, ...rest }: EditorHeaderProps) {
    const t = useTranslation();
    const row = draft.automation;
    return (
        <BuildHeader
            {...rest}
            flowKey={draft.key}
            store={draft.store}
            title={row?.title || t('mobile.flow.untitled', 'Untitled routine')}
            isActive={!!row?.isActive}
            isDraft={row?.isDraft ?? true}
            triggerKind={definition.trigger?.kind ?? null}
            canActivate={!!definition.trigger && definition.steps.length > 0}
        />
    );
}

function BuildEditor({ draft, definition, fromTemplate, onHold }: { draft: FlowDraft; definition: FlowDefinition; fromTemplate: boolean; onHold: (hold: boolean) => void }) {
    const t = useTranslation();
    const router = useRouter();
    const automationId = useDraftState(draft.store, (s) => s.automationId);
    const issues = useDraftState(draft.store, (s) => s.issues);
    const issuesByStep = useDraftState(draft.store, (s) => s.issuesByStep);
    const catalog: FlowCatalog | null = useCatalog({ freshOnMount: true }).data ?? null;
    const [picking, setPicking] = useState<AddTarget | null>(null);
    const [findingsOpen, setFindingsOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [templates, setTemplates] = useState(fromTemplate);
    const [runSheet, setRunSheet] = useState(false);
    const [flowlets, setFlowlets] = useState(false);
    const assistant: Assistant = useAssistant(draft);
    useUnsavedLeave(draft.key, draft.store);
    const runs = useTestRuns(draft.key, draft.store);
    // A new routine's first test run creates it; handing over to its own
    // route mid-run would drop the run (its state is keyed by this draft).
    const holding = assistant.open || assistant.ai.streaming || runs.running;
    useEffect(() => onHold(holding), [onHold, holding]);

    // Before the parent's hand-over (a child's effects run first), so the
    // routine's own screen finds this run under the new id.
    useEffect(() => {
        if (automationId) aliasTestRunStore(draft.key, automationId);
    }, [draft.key, automationId]);

    const flowId = automationId ?? draft.key;
    const openStep = (address: string, section?: string | null) => router.push(stepEditorPath(flowId, address, section));
    const openFlowlet = (key: string) => router.push(flowletPath(flowId, key));
    const editing = useOutlineEditing({
        store: draft.store, catalog, runByStep: runs.runByStep, runRows: runs.state.rows, onOpen: openStep, onTest: runs.testStep, onOpenFlowlet: openFlowlet,
    });
    const card = useCardContext(definition, catalog, runs.runByStep, issuesByStep);
    const findings = issueRows(issues, definition);
    const live = useLive(draft.automation);
    const canActivate = !!definition.trigger && definition.steps.length > 0;
    const busy = assistant.ai.streaming || runs.running;

    return (
        <Screen edges={['top', 'bottom']}>
            <EditorHeader
                draft={draft}
                definition={definition}
                live={live}
                automationId={automationId}
                busy={busy}
                findings={findings.length}
                onRename={() => setRenaming(true)}
                onFindings={() => setFindingsOpen(true)}
                onFlowlets={() => setFlowlets(true)}
            />
            <BuildBody
                draft={draft} definition={definition} card={card} catalog={catalog} editing={editing} runs={runs}
                onAdd={setPicking} onOpen={openStep} onRunDetails={() => setRunSheet(true)}
                assistant={{ open: () => assistant.setOpen(true), busy: assistant.ai.streaming }}
                overlay={<IssuesPill summary={pillSummary(findings, t)} onPress={() => setFindingsOpen(true)} />}
                banner={
                    <PublishBanner flowKey={draft.key} store={draft.store} live={live} canPublish={canActivate} busy={busy} onFindings={() => setFindingsOpen(true)} />
                }
            />
            <FlowSheets
                draft={draft} definition={definition} card={card} catalog={catalog} editing={editing} runs={runs}
                picking={picking} setPicking={setPicking} runSheet={runSheet} setRunSheet={setRunSheet} onOpen={openStep}
            />
            <IssuesSheet
                visible={findingsOpen}
                rows={findings}
                onClose={() => setFindingsOpen(false)}
                onOpen={(row) => {
                    setFindingsOpen(false);
                    if (row.stepId) router.push(stepEditorPath(flowId, row.stepId, row.section, row.flowlet));
                }}
            />
            <AiBuilderSheet
                assistant={assistant}
                draft={draft}
                appLabel={catalogAppLabel(catalog)}
                onFindings={() => {
                    assistant.setOpen(false);
                    setFindingsOpen(true);
                }}
            />
            <FlowletsSheet visible={flowlets} store={draft.store} onClose={() => setFlowlets(false)} onOpen={openFlowlet} />
            {renaming ? <RenameSheet flowKey={draft.key} title={draft.automation?.title ?? ''} onClose={() => setRenaming(false)} /> : null}
            {templates ? <TemplateSheet visible onClose={() => setTemplates(false)} onCreated={(id) => router.replace(buildPath(id))} /> : null}
        </Screen>
    );
}

export interface BuildScreenProps {
    /** The routine's id, or NEW_FLOW_ID. */
    id: string;
    /** A new routine's kind: a plain one, or a form. */
    kind?: NewFlowKind;
    /** Open the template gallery first (a new routine "from a template"). */
    fromTemplate?: boolean;
}

export function BuildScreen({ id, kind = 'manual', fromTemplate = false }: BuildScreenProps) {
    const isNew = id === NEW_FLOW_ID;
    const [hold, setHold] = useState(false);
    const onCreated = useHandover(isNew, hold);
    const [seed] = useState(() => (isNew ? newFlowSeed(kind) : undefined));
    const draft = useFlowDraft(id, { seed, onCreated });
    const definition = useDraftState(draft.store, (s) => s.definition);
    if (!definition) {
        return <Screen>{draft.error ? <ErrorState error={draft.error} onRetry={draft.refetch} /> : <LoadingState />}</Screen>;
    }
    return <BuildEditor draft={draft} definition={definition} fromTemplate={isNew && fromTemplate} onHold={setHold} />;
}
