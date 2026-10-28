import { Loader2, Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { REFUSAL } from './testSetFacts';
import type { TranslateFn } from '@/hooks/useTranslation';

interface SuggestionExpect {
    mustMention?: string[];
    mustNotMention?: string[];
    toolsExpected?: string[];
    rulesExpected?: string[];
    notes?: string;
}

/** What `POST /agents/:id/tests/suggest` proposes. */
interface TestSuggestion {
    expect?: SuggestionExpect;
    /** Per field who wrote it: 'ai', 'observed', … */
    wrote?: Record<string, string>;
    suggestedBy?: string;
}

/** The test the form hands to `onSave`. */
interface SuggestedTestDraft {
    name: string;
    question: string;
    expect: {
        mustMention: string[];
        mustNotMention: string[];
        toolsExpected: string[];
        rulesExpected: string[];
        notes: string;
    };
    writtenBy: Record<string, string>;
    suggestedBy?: string;
}

/**
 * "+ Dit gesprek als test": the form in which a PROPOSAL becomes a test (A4 part D).
 *
 * The server had the fast tier write down what a good answer to this question must
 * convey in any case (`POST /:id/tests/suggest`). That is a proposal, and this screen is
 * the place where it also looks like one:
 *
 *   • EVERY field is editable before saving. A test that guards something other than
 *     someone thought turns green, and then nobody believes the whole set anymore;
 *   • it says THAT AN AI WROTE IT, and per field which one. As soon as you touch a field
 *     it is yours and that marker disappears, otherwise it would stay on your own sentence;
 *   • `toolsExpected` carries a different marker, because that is not an opinion but what
 *     was actually called in that turn;
 *   • `mustNotMention` comes IN EMPTY and stays empty until someone types it. A prohibition
 *     is a rule of the organisation, not an observation about one answer, and it is the only
 *     expectation that is matched literally and that the judge cannot rescue. An invented
 *     prohibition is therefore the most expensive of the five fields (server:
 *     core/agentRuntime/testSuggest).
 *
 * ── A FAILED PROPOSAL IS AN EMPTY FORM, NOT AI TEXT ─────────────────
 * If the server could not write a proposal, this form opens simply empty and says that
 * nothing was proposed. What does NOT happen is showing an empty suggestion with "an AI
 * wrote this" above it: then the marker would be about nobody's work.
 *
 * ── THE QUESTION IS THE BUILDER'S ───────────────────────────────────
 * `question` comes from what he himself typed in the test chat, not from the model. It is
 * therefore shown at the top without a marker, and editable, because the question in a
 * test may be sharper than what you happened to type.
 */

/** Elke lijst is één item per regel. Simpel te bewerken, simpel te lezen. */
function linesToList(text: unknown): string[] {
    return String(text || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

function listToLines(list: unknown): string {
    return (Array.isArray(list) ? list : []).join('\n');
}

/** The marker that says who wrote this field. Disappears as soon as you touch it. */
function SourceChip({ t, source, touched, field }: { t: TranslateFn; source?: string; touched: boolean; field: string }) {
    if (touched) return null;
    if (source === 'ai') {
        return (
            <span data-testid={`agent-tests-field-source-${field}`} data-source="ai"
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border border-[var(--border-default)] text-[var(--text-tertiary)]">
                <Sparkles size={10} aria-hidden="true" />
                {t('agent_studio.test.written_by_ai', 'AI wrote this')}
            </span>
        );
    }
    if (source === 'observed') {
        return (
            <span data-testid={`agent-tests-field-source-${field}`} data-source="observed"
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border border-[var(--border-default)] text-[var(--text-tertiary)]">
                {t('agent_studio.test.from_this_turn', 'from this chat')}
            </span>
        );
    }
    return null;
}

const FIELD_CLASS = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)]';

function ListField({ t, field, label, help, value, onChange, source, touched, rows = 3 }: {
    t: TranslateFn;
    field: string;
    label: string;
    help?: string;
    value: string;
    onChange: (value: string) => void;
    source?: string;
    touched: boolean;
    rows?: number;
}) {
    return (
        <label className="block">
            <span className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
                <SourceChip t={t} source={source} touched={touched} field={field} />
            </span>
            <textarea
                data-testid={`agent-tests-field-${field}`}
                rows={rows}
                value={value}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
                className={FIELD_CLASS}
            />
            {help && <span className="block mt-1 text-[11px] text-[var(--text-tertiary)]">{help}</span>}
        </label>
    );
}

const EMPTY_EXPECT: SuggestionExpect = { mustMention: [], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' };

export default function SuggestedTestForm({
    t,
    turn = null,
    suggestion = null,
    state = 'ready',
    refusal = null,
    saving = false,
    saveError = null,
    onSave = null,
    onCancel = null,
}: {
    t: TranslateFn;
    turn?: { question?: string } | null;
    suggestion?: TestSuggestion | null;
    state?: string;
    refusal?: { kind: string } | null;
    saving?: boolean;
    saveError?: string | null;
    onSave?: ((test: SuggestedTestDraft) => void) | null;
    onCancel?: (() => void) | null;
}) {
    const expect = (suggestion && suggestion.expect) || EMPTY_EXPECT;
    const wrote: Record<string, string> = useMemo(() => (suggestion && suggestion.wrote) || {}, [suggestion]);
    // Which model wrote the proposal. It travels along to the storage, so the row can
    // later still say who drafted it.
    const suggestedBy = (suggestion && typeof suggestion.suggestedBy === 'string')
        ? suggestion.suggestedBy : null;

    const [name, setName] = useState('');
    const [question, setQuestion] = useState((turn && turn.question) || '');
    const [mustMention, setMustMention] = useState(listToLines(expect.mustMention));
    const [mustNotMention, setMustNotMention] = useState(listToLines(expect.mustNotMention));
    const [toolsExpected, setToolsExpected] = useState(listToLines(expect.toolsExpected));
    const [notes, setNotes] = useState(expect.notes || '');
    const [touched, setTouched] = useState<Record<string, boolean>>({});

    const touch = (field: string, setter: (value: string) => void) => (value: string) => {
        setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }));
        setter(value);
    };

    /**
     * Did a MODEL write anything here? Only then may the line above say so. An empty
     * proposal ("I see nothing here that needs to be recorded") is a valid answer from the
     * server, but it is not text from an AI, and therefore no AI marker belongs above it.
     */
    const aiWroteSomething = useMemo(
        () => Object.values(wrote).some(v => v === 'ai'),
        [wrote],
    );

    if (state === 'loading') {
        return (
            <div data-testid="agent-tests-suggest-form" data-state="loading" className="rounded-xl border border-[var(--border-default)] p-4 flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {t('agent_studio.test.suggest_loading', 'Reading that answer…')}
            </div>
        );
    }

    const canSave = question.trim().length > 0 && !saving;

    const submit = () => {
        if (!canSave) return;
        // The provenance travels ALONG to the storage. Without that, the marker "AI wrote this"
        // existed only as long as this form stayed open: once something was saved, the line was
        // no longer distinguishable from one a human typed, while precisely that line decides
        // whether a run turns green or red. A field that the human touched is from that moment
        // on the human's, whatever was in it.
        const writtenBy: Record<string, string> = {};
        for (const field of ['mustMention', 'mustNotMention', 'toolsExpected', 'rulesExpected', 'notes']) {
            writtenBy[field] = touched[field] ? 'human' : (wrote[field] || 'empty');
        }
        onSave?.({
            name: name.trim(),
            question: question.trim(),
            expect: {
                mustMention: linesToList(mustMention),
                mustNotMention: linesToList(mustNotMention),
                toolsExpected: linesToList(toolsExpected),
                rulesExpected: [],
                notes: notes.trim(),
            },
            writtenBy,
            ...(suggestedBy ? { suggestedBy } : {}),
        });
    };

    return (
        <div data-testid="agent-tests-suggest-form" data-state={state} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] p-4 flex flex-col gap-3">
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">
                {t('agent_studio.test.suggest_title', 'Turn this answer into a test')}
            </div>

            {aiWroteSomething ? (
                <div data-testid="agent-tests-suggest-source" data-source="ai"
                    className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2 [background:color-mix(in_srgb,var(--accent)_8%,transparent)]">
                    <Sparkles size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
                    <span className="text-[var(--text-secondary)]">
                        {t('agent_studio.test.suggest_by_ai', 'An AI read that answer and proposed what this test should expect. Read it before you save — it becomes what the test guards.')}
                    </span>
                </div>
            ) : (
                <div data-testid="agent-tests-suggest-source" data-source="none" className="text-[12px] text-[var(--text-tertiary)]">
                    {refusal
                        ? (refusal.kind === REFUSAL.NO_SUGGESTER
                            ? t('agent_studio.test.suggest_no_model', 'No AI model is set up to propose expectations, so write them yourself.')
                            : t('agent_studio.test.suggest_failed', 'Nothing could be proposed for this answer, so write the expectations yourself.'))
                        : t('agent_studio.test.suggest_empty', 'Nothing was proposed for this answer — write what a good answer has to get across.')}
                </div>
            )}

            <label className="block">
                <span className="block mb-1 text-[12px] font-medium text-[var(--text-secondary)]">
                    {t('agent_studio.test.field_question', 'Question')}
                </span>
                <input
                    data-testid="agent-tests-field-question"
                    value={question}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuestion(e.target.value)}
                    className={FIELD_CLASS}
                />
            </label>

            <label className="block">
                <span className="block mb-1 text-[12px] font-medium text-[var(--text-secondary)]">
                    {t('agent_studio.test.field_name', 'Name (optional)')}
                </span>
                <input
                    data-testid="agent-tests-field-name"
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    className={FIELD_CLASS}
                />
            </label>

            <ListField
                t={t} field="mustMention"
                label={t('agent_studio.test.field_must_mention', 'Must get across')}
                help={t('agent_studio.test.field_must_mention_help', 'One per line. A paraphrase counts — this one is judged by an AI, not matched word for word.')}
                value={mustMention} onChange={touch('mustMention', setMustMention)}
                source={wrote.mustMention} touched={!!touched.mustMention}
            />

            <ListField
                t={t} field="mustNotMention"
                label={t('agent_studio.test.field_must_not_mention', 'Must never say')}
                help={t('agent_studio.test.field_must_not_mention_help', 'One per line, matched word for word. Nothing is proposed here — a prohibition is a rule you write.')}
                value={mustNotMention} onChange={touch('mustNotMention', setMustNotMention)}
                source={wrote.mustNotMention} touched={!!touched.mustNotMention}
                rows={2}
            />

            <ListField
                t={t} field="toolsExpected"
                label={t('agent_studio.test.field_tools', 'Should use these tools')}
                // "from this chat", not "what this answer actually used": the server gets these names
                // from the request body and cannot check them. The test chat is ephemeral and leaves
                // no row behind.
                help={t('agent_studio.test.field_tools_help', 'Taken from the tools this chat showed running. Remove any you do not want to require.')}
                value={toolsExpected} onChange={touch('toolsExpected', setToolsExpected)}
                source={wrote.toolsExpected} touched={!!touched.toolsExpected}
                rows={2}
            />

            <ListField
                t={t} field="notes"
                label={t('agent_studio.test.field_notes', 'Anything else')}
                value={notes} onChange={touch('notes', setNotes)}
                source={wrote.notes} touched={!!touched.notes}
                rows={2}
            />

            {saveError && (
                <div role="status" data-testid="agent-tests-suggest-error" className="text-[12px] text-[var(--warning)]">
                    {saveError}
                </div>
            )}

            <div className="flex items-center gap-2">
                <button
                    type="button"
                    data-testid="agent-tests-suggest-save"
                    onClick={submit}
                    disabled={!canSave}
                    className="h-8 px-3 rounded-lg text-[13px] font-medium text-white bg-[var(--accent)] disabled:opacity-50 transition"
                >
                    {saving ? t('agent_studio.test.saving', 'Saving…') : t('agent_studio.test.save_test', 'Save as test')}
                </button>
                {onCancel && (
                    <button
                        type="button"
                        data-testid="agent-tests-suggest-cancel"
                        onClick={onCancel}
                        className="h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
