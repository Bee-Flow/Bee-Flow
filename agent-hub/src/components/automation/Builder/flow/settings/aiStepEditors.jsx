// AI-step editor (prompt, tier, tool picker, structured output), extracted
// verbatim from SettingsForm.jsx. Rendered by the SettingsForm dispatch.
import { Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import { tierLabel, configuredTierKeys } from '../../../../licensing/tierMeta';
import ComposeField from '../../valueSlot/ComposeField';
import ToolInputForm from '../../mapping/ToolInputForm';
import AccordionSection from '../AccordionSection';
import { humanizeToolName } from '../displayHelpers';
import FieldHint from '../FieldHint';
import ToolPicker from '../ToolPicker';
import { AgentStepFields } from './agentStepFields';
import { RetrySection, retryIsSet } from './collectionEditors';
import StepRepeatSection from './advanced/StepRepeatSection';
import { perItemIsSet } from './advanced/stepRepeat';
import { FormRow, inputClass, textareaClass } from './formPrimitives';
import { ProblemRing, runStepProblem } from './runProblem';
import { StructuredOutputFields } from './structuredOutputFields';

function AiStepFields({ draft, set, modelTiers, catalog = null, groups = [], onFocusField, previewSample, errorSections = new Set(), runStep = null }) {
    const hasInputs = Object.keys(draft.inputs || {}).length > 0;
    const hasOutput = (draft.outputFields || []).length > 0;
    // Only the agent block is translated here; the rest of this editor is
    // pre-retrofit English literals.
    const { t } = useTranslation();
    // The last run failed on the prompt or the model (errorInfo.settingKey):
    // that setting rings red, and a ringed model opens Advanced.
    const problem = runStepProblem(runStep, t);
    const promptProblem = problem?.settingKey === 'prompt' ? problem.text : null;
    const tierProblem = problem?.settingKey === 'modelTier' ? problem.text : null;
    return (
        <>
            {/* Who does the thinking (handoff 5, round 3). Flat, not in an
                accordion: picking an agent is the choice of what the step IS,
                and the task field sits inside it because with an agent or a
                skill the prompt is the brief for THIS step only. */}
            <AgentStepFields
                draft={draft}
                set={set}
                catalog={catalog}
                renderTask={({ withAgentOrSkill }) => (
                    <ProblemRing problem={promptProblem}>
                    <FormRow
                        label={withAgentOrSkill ? t('routines.agent_step.task_label', 'Task for this step') : 'Prompt'}
                        required
                        hint={withAgentOrSkill
                            ? t('routines.agent_step.task_hint', 'Short: the skill already knows how. Drop in fields from earlier steps with the {} button.')
                            : 'What the AI should do. Drag data from the Input panel (or use the {} button) to drop in a value from a previous step — it\'s filled in with the real value when the step runs.'}
                    >
                        <ComposeField stepType="ai_step" field="prompt"
                            value={draft.prompt || ''}
                            onChange={(next) => set('prompt', next)}
                            rows={4}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            // The model reads a list as JSON well: a list in
                            // the prompt needs no joining, and {{name}} reads
                            // this step's own input.
                            listAs="json"
                            namedInputs={draft.inputs}
                            placeholder="Summarise this email and decide if it needs an urgent reply."
                        />
                    </FormRow>
                    </ProblemRing>
                )}
            />
            {/* AccordionSection, not a bare CollapsibleSection: only the former
                honours the quick/full density, and this block (system prompt,
                model tier, tool allowlist) is the definition of "advanced".
                Cost of the switch is one reset collapse preference. */}
            {/* hasContent must test the keys the draft actually carries: the tier is
    `modelTier` (`model` kept for legacy steps), `allowTools` is a boolean,
    and the allowlist array is `tools` — testing draft.model/allowTools.length
    hid a configured section in Simple mode with no way to reach it. Same
    reasoning for `knowledgeBaseIds` (BFSF-410): a configured grounding list
    must show as configured in Simple mode too, not just Advanced. */}
            <AccordionSection stepType="ai_step" sectionKey="advanced" title="Advanced" forceOpen={errorSections.has('advanced') || !!tierProblem} hasContent={!!draft.systemPrompt || (!!draft.modelTier && draft.modelTier !== 'auto') || !!draft.model || perItemIsSet(draft) || retryIsSet(draft) || !!draft.allowTools || (draft.tools?.length > 0) || (draft.knowledgeBaseIds?.length > 0) || !!draft.useMemory}>
                <FormRow label="System prompt" hint="Optional. Overrides the default 'You are a step inside a no-code automation' framing — set a tone, role, or domain.">
                    <textarea rows={3} value={draft.systemPrompt || ''} onChange={(e) => set('systemPrompt', e.target.value)} placeholder="(default: a generic automation-step system prompt)" className={textareaClass()} />
                </FormRow>
                <ProblemRing problem={tierProblem}>
                <FormRow label="Model tier">
                    {(() => {
                        // Only list the tiers the chat actually offers — same
                        // configured-tier filter the ModelTierSelector uses, so
                        // the two pickers never drift apart.
                        const keys = configuredTierKeys(modelTiers || {});
                        const current = draft.modelTier || 'auto';
                        // Keep a previously-saved tier selectable even if it's no
                        // longer offered (e.g. beta revoked) so we don't silently
                        // change the step's model on open.
                        const options = keys.includes(current) ? keys : [current, ...keys];
                        return (
                            <select value={current} onChange={(e) => set('modelTier', e.target.value)} className={inputClass()}>
                                {options.length === 0 && (
                                    <option value={current}>{current}</option>
                                )}
                                {options.map((id) => (
                                    <option key={id} value={id}>{modelTiers?.[id]?.label || tierLabel(id, modelTiers) || id}</option>
                                ))}
                            </select>
                        );
                    })()}
                </FormRow>
                </ProblemRing>
                <FormRow label="Tools" hint="Choose which tools the AI may call during this step. Only tools you have permission for are listed. Leave empty for a pure text answer.">
                    <AiStepToolSelect draft={draft} set={set} catalog={catalog} />
                </FormRow>
                <FormRow label="Personal memory" hint="Ground this step in what you have told the assistant about yourself, your preferences and your contacts. The memories closest to this step's prompt are added before the model answers. Good for steps that write in your name or decide on your behalf.">
                    <label className="inline-flex items-center gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            checked={draft.useMemory === true}
                            onChange={(e) => set('useMemory', e.target.checked)}
                        />
                        Use my personal memory
                    </label>
                </FormRow>
                <FormRow label="Knowledge bases" hint="Ground this step in these knowledge bases — searched once before the step runs and added to the prompt as reference material. Good for steerable content like a brand style guide or a positioning doc.">
                    <AiStepKbSelect draft={draft} set={set} />
                </FormRow>
                <FormRow label="Iteration" hint="Off by default: the AI runs once and sees all mapped data at once. Turn on to run the prompt once per item of an upstream list. The prompt can then read the current item.">
                    <StepRepeatSection stepType="ai_step" draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                </FormRow>
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
            {/* The band already names the section, so the field inside it
                carries only its hint — repeating the name read as two
                headings stacked on each other. */}
            <AccordionSection
                stepType="ai_step" sectionKey="inputs" title="Inputs"
                defaultOpen={hasInputs} forceOpen={errorSections.has('inputs')}
                meta={<FieldHint title="About Inputs">Named values the AI can read alongside the prompt. Mention a name in the prompt to use it.</FieldHint>}
            >
                <ToolInputForm
                    inputs={draft.inputs || {}}
                    onChange={(next) => set('inputs', next)}
                    inputSchema={null}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            </AccordionSection>
            <AccordionSection
                stepType="ai_step" sectionKey="output" title="Structured output"
                defaultOpen={hasOutput} forceOpen={errorSections.has('output')}
                hasContent={!!(draft.outputFields?.length)}
                meta={<FieldHint title="About Structured output">Define the JSON fields the AI should return. Downstream steps can then reference them by name. Leave empty for free-form text.</FieldHint>}
            >
                <StructuredOutputFields
                    fields={draft.outputFields || []}
                    onChange={(next) => set('outputFields', next)}
                />
            </AccordionSection>
        </>
    );
}

/**
 * Tool selector for the AI step. Mirrors the agent editor's app picker but at
 * per-tool granularity: the user picks individual catalog actions, stored as
 * `tools` (function names). `allowTools` is derived from the selection.
 *
 * Legacy steps carry `allowTools: true` with no `tools` array — that means
 * "every permitted tool". We surface that as an "All available tools" state and
 * only convert it to an explicit list once the user opens the picker.
 */
function AiStepToolSelect({ draft, set, catalog }) {
    const [open, setOpen] = useState(false);

    // Apps the user can actually use (catalog is already permission-gated
    // server-side; `available === false` means hidden/not entitled).
    const apps = useMemo(
        () => (catalog?.apps || []).filter(a => a.available !== false && (a.actions || []).length > 0),
        [catalog],
    );
    // Flat lookup: function name -> { action, app } for chip labels.
    const actionIndex = useMemo(() => {
        const m = new Map();
        for (const app of apps) for (const a of (app.actions || [])) m.set(a.name, { action: a, app });
        return m;
    }, [apps]);
    const allNames = useMemo(() => apps.flatMap(a => (a.actions || []).map(x => x.name)), [apps]);

    // null/undefined `tools` + allowTools on = legacy "all tools".
    const isExplicit = Array.isArray(draft.tools);
    const legacyAll = !isExplicit && !!draft.allowTools;
    const selected = isExplicit ? draft.tools : [];

    const setSelected = (next) => set('tools', next);
    const toggleTool = (name) => {
        const base = isExplicit ? draft.tools : [];
        setSelected(base.includes(name) ? base.filter(n => n !== name) : [...base, name]);
    };
    const toggleApp = (app, on) => {
        const names = (app.actions || []).map(a => a.name);
        const base = new Set(isExplicit ? draft.tools : []);
        if (on) names.forEach(n => base.add(n)); else names.forEach(n => base.delete(n));
        setSelected([...base]);
    };
    // Converting legacy "all" → explicit: start from every available tool so the
    // current behaviour is preserved and the user can untick what they don't need.
    const chooseSpecific = () => { setSelected([...allNames]); setOpen(true); };

    const chipLabel = (name) => {
        const hit = actionIndex.get(name);
        if (!hit) return humanizeToolName(name);
        const app = hit.app.label || hit.action.integrationLabel || '';
        const act = hit.action.label || humanizeToolName(name);
        return app ? `${app}: ${act}` : act;
    };

    if (legacyAll) {
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-default)] px-2.5 py-1 text-xs">
                        <Sparkles size={12} className="text-[var(--accent)]" />
                        All available tools
                    </span>
                </div>
                <button
                    type="button"
                    onClick={chooseSpecific}
                    className="text-xs font-medium text-[var(--accent)] hover:underline"
                >
                    Choose specific tools…
                </button>
                {open && (
                    <ToolPicker
                        apps={apps}
                        selected={selected}
                        onToggleTool={toggleTool}
                        onToggleApp={toggleApp}
                        onClose={() => setOpen(false)}
                    />
                )}
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                <Plus size={14} />
                Browse tools
            </button>
            {selected.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">
                    No tools — the AI step answers from its prompt only.
                    {' '}You can also drag an app from the ribbon onto this step&apos;s
                    {' '}<span className="whitespace-nowrap">Tools</span> port on the canvas.
                </p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {selected.map((name) => (
                        <span
                            key={name}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-default)] pl-2.5 pr-1 py-0.5 text-xs text-[var(--text-primary)]"
                        >
                            <span className="truncate max-w-[180px]">{chipLabel(name)}</span>
                            <button
                                type="button"
                                onClick={() => toggleTool(name)}
                                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                aria-label={`Remove ${chipLabel(name)}`}
                            >
                                <X size={12} />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            {open && (
                <ToolPicker
                    apps={apps}
                    selected={selected}
                    onToggleTool={toggleTool}
                    onToggleApp={toggleApp}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}

/**
 * Knowledge Base grounding picker for the ai_step (BFSF-410) — a checkbox list
 * over GET /api/kb, same data source and interaction as App Studio's
 * KbMultiSelect (AiActionEditors.jsx), reimplemented locally rather than
 * imported: that one is styled with App Studio's FormField/INPUT_CLS, and the
 * routine Builder has its own FormRow/formPrimitives chrome the rest of this
 * file already uses — a straight import would mix two design systems on one
 * node. The runtime authority is server-side (execAiStep re-checks every id
 * against the running user/org before ever searching it); this list is
 * advisory — it shows every KB the /api/kb endpoint already scopes to the
 * signed-in user, same as every other KB picker in the product.
 *
 * `?context=ai_step` (K5) narrows it further, to the bases whose owner made
 * them available to ROUTINES. Without it the picker offers bases that
 * activation will refuse — and the refusal arrives days later, on the step
 * that was supposed to go live, rather than here where the choice was made.
 * A base that never expressed a context still appears: a missing value means
 * everywhere, or this would empty the picker on every install predating the
 * column.
 */
function AiStepKbSelect({ draft, set }) {
    const [kbs, setKbs] = useState(null); // null = loading
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/kb?context=ai_step`);
                const body = r.ok ? await r.json() : [];
                const list = Array.isArray(body) ? body : (body?.knowledge_bases || body?.kbs || []);
                if (alive) setKbs(list);
            } catch { if (alive) setKbs([]); }
        })();
        return () => { alive = false; };
    }, []);

    const selected = new Set(Array.isArray(draft.knowledgeBaseIds) ? draft.knowledgeBaseIds : []);
    const toggle = (id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id); else next.add(id);
        set('knowledgeBaseIds', [...next]);
    };

    if (kbs === null) return <p className="text-xs text-[var(--text-tertiary)]">Loading…</p>;
    if (kbs.length === 0) {
        return <p className="text-xs text-[var(--text-tertiary)]">No knowledge bases yet — add one under Knowledge Bases first.</p>;
    }
    return (
        <div className="flex flex-col gap-1.5 max-h-40 overflow-auto">
            {kbs.map((kb) => (
                <label key={kb.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                    <input
                        type="checkbox"
                        checked={selected.has(kb.id)}
                        onChange={() => toggle(kb.id)}
                        aria-label={`Ground in ${kb.name || kb.id}`}
                    />
                    <span className="truncate">{kb.name || kb.id}</span>
                </label>
            ))}
        </div>
    );
}

export { StructuredOutputFields };
export { AiStepFields };
