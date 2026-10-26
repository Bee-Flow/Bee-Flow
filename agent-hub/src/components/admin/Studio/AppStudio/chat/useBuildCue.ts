import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { describeAppToolCall } from './appToolCallDisplay';
import { countComponents } from './builderPaneModel';
import type { EditorChrome } from './builderPaneModel';
import type { DoneInfo, RevealCue } from './useBuilderTurn';
import type { BuilderEngine, BuilderMessage, BuilderTodo, BuilderTurn } from '@/hooks/builderStream';
import type { ToolDraft } from '../editor/ghostCellDraft';
import type { BuildCueValue, BuildPhaseInfo } from '../editor/BuildCueContext';
import type { AppDefinition } from '../inspector/appDefinition';

interface ToolCallRow {
    name?: string;
    ok?: boolean;
    error?: string;
    summary?: string;
}

interface BuildCueInputs {
    running: boolean;
    messages: BuilderMessage[];
    turn: BuilderTurn | null;
    engine: BuilderEngine | null;
    toolDraft: ToolDraft | null;
    todos: BuilderTodo[];
    currentPhase: BuildPhaseInfo | null;
    reveal: RevealCue | null;
    doneInfoRef: RefObject<DoneInfo | null>;
    definitionRef: RefObject<AppDefinition | null>;
    chromeRef: RefObject<EditorChrome | null>;
}

/**
 * The build cue for the canvas (banner, ghost cell, camera), and whether the
 * pane is still in the silence before the first token.
 */
export function useBuildCue({
    running, messages, turn, engine, toolDraft, todos, currentPhase, reveal, doneInfoRef, definitionRef, chromeRef,
}: BuildCueInputs): { waitingForFirstToken: boolean } {
    // ── The silence before the first token ───────────────────────────────
    // On a local model that silence is minutes: the model is reading a prompt
    // the size of a short book. The waiting card shows what HAS happened
    // (request sent, session opened, heartbeats, the real reading bar) and how
    // long this usually takes, instead of a bare "Thinking…" that read as a
    // hang. It drops as soon as anything streams in.
    const [buildStart, setBuildStart] = useState(() => ({ running: !!running, at: running ? Date.now() : null as number | null }));
    if (buildStart.running !== !!running) {
        setBuildStart({ running: !!running, at: running ? Date.now() : buildStart.at });
    }
    const tailAssistant = [...messages].reverse().find((m) => m && m.role === 'assistant' && !m.kind);
    const tailCalls = tailAssistant ? tailAssistant.toolCalls as ToolCallRow[] | undefined : undefined;
    const nothingStreamedYet = !(tailAssistant
        && ((tailAssistant.content && tailAssistant.content.length)
            || (tailAssistant.thinkingParts && tailAssistant.thinkingParts.length)
            || (tailCalls && tailCalls.length)));
    const waitingForFirstToken = !!running && !turn?.firstEventAt && nothingStreamedYet;
    // ── The build cue for the canvas (banner, ghost cell, camera) ────────
    // Built once per tool call / plan / turn milestone — keyed on the last
    // assistant message's toolCalls ARRAY, never its streaming text — so the
    // canvas does not re-render on every character. Published through the
    // shell (chrome.publishBuildCue) to BuildCueContext.
    const lastToolCalls = tailAssistant ? tailCalls : null;
    const cue = useMemo<BuildCueValue | null>(() => {
        if (!running && !doneInfoRef.current) return null;
        const calls = Array.isArray(lastToolCalls) ? lastToolCalls : [];
        const lastOk = [...calls].reverse().find((c) => c && c.ok !== false) || null;
        const lastAny = calls.length ? calls[calls.length - 1] : null;
        const described = lastOk ? describeAppToolCall(lastOk) : null;
        const def = definitionRef.current;
        const componentCount = countComponents(def);
        const doneInfo = doneInfoRef.current;
        return {
            running: !!running,
            startedAt: buildStart.at,
            phase: lastOk && lastOk.name === 'app_finalize' ? 'finishing' : (lastOk && lastOk.name === 'app_dry_run' ? 'checking' : 'building'),
            lastCall: described && lastOk ? { name: lastOk.name, title: described.title, detail: described.detail, added: described.added, ok: true } : null,
            skipped: lastAny && lastAny.ok === false && lastAny === calls[calls.length - 1] ? (lastAny.error || lastAny.summary || null) : null,
            todos,
            phaseInfo: currentPhase,
            engine,
            turn,
            toolDraft,
            reveal,
            finalized: !!(doneInfo && doneInfo.finalized),
            stopped: !!(doneInfo && doneInfo.stopped),
            componentCount,
            screenCount: ((def && def.screens) || []).length,
        };
    // Keyed on the toolCalls array identity, the todos list and the turn
    // milestones — deliberately not the streaming text.
    }, [running, lastToolCalls, todos, currentPhase, engine, turn, toolDraft, reveal, buildStart.at]);
    useEffect(() => { chromeRef.current?.publishBuildCue?.(cue); }, [cue, chromeRef]);
    return { waitingForFirstToken };
}
