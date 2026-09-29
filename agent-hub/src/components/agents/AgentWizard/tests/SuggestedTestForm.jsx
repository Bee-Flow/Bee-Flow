import { Loader2, Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { REFUSAL } from './testSetFacts';

/**
 * "+ Dit gesprek als test" — het formulier waarin een VOORSTEL een test wordt
 * (A4 deel D).
 *
 * De server heeft de snelle tier laten opschrijven wat een goed antwoord op
 * deze vraag hoe dan ook moet overbrengen (`POST /:id/tests/suggest`). Dat is
 * een voorstel, en dit scherm is de plek waar het er ook zo uitziet:
 *
 *   • ELK veld is te bewerken vóór opslag. Een test die iets anders bewaakt
 *     dan iemand dacht wordt groen, en dan gelooft niemand de hele set meer;
 *   • er staat bij DAT EEN AI HET SCHREEF, en per veld welke. Zodra je een
 *     veld aanraakt is het van jou en verdwijnt dat merkje — het zou anders
 *     over jouw eigen zin blijven staan;
 *   • `toolsExpected` draagt een ander merkje, want dat is geen mening maar
 *     wat er in die beurt daadwerkelijk is aangeroepen;
 *   • `mustNotMention` komt LEEG binnen en blijft leeg tot iemand hem typt.
 *     Een verbod is een regel van de organisatie, geen observatie over één
 *     antwoord — en het is de enige verwachting die letterlijk gematcht wordt
 *     en die de beoordelaar niet kan redden. Een verzonnen verbod is dus de
 *     duurste van de vijf velden (server: core/agentRuntime/testSuggest).
 *
 * ── EEN MISLUKT VOORSTEL IS EEN LEEG FORMULIER, GEEN AI-TEKST ───────
 * Kon de server geen voorstel schrijven, dan opent dit formulier gewoon leeg
 * en zegt het dat er niets is voorgesteld. Wat er NIET gebeurt is een lege
 * suggestie tonen met "een AI schreef dit" erboven: dan zou het merkje over
 * niemands werk gaan.
 *
 * ── DE VRAAG IS VAN DE BOUWER ───────────────────────────────────────
 * `question` komt uit wat hij zelf typte in de testchat, niet uit het model,
 * en staat daarom zonder merkje bovenaan — bewerkbaar, want de vraag in een
 * test mag scherper zijn dan wat je toevallig intikte.
 */

/** Elke lijst is één item per regel. Simpel te bewerken, simpel te lezen. */
export function linesToList(text) {
    return String(text || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

export function listToLines(list) {
    return (Array.isArray(list) ? list : []).join('\n');
}

/** Het merkje dat zegt wie dit veld schreef. Verdwijnt zodra je het aanraakt. */
function SourceChip({ t, source, touched, field }) {
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

function ListField({ t, field, label, help, value, onChange, source, touched, rows = 3 }) {
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
                onChange={(e) => onChange(e.target.value)}
                className={FIELD_CLASS}
            />
            {help && <span className="block mt-1 text-[11px] text-[var(--text-tertiary)]">{help}</span>}
        </label>
    );
}

const EMPTY_EXPECT = { mustMention: [], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' };

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
}) {
    const expect = (suggestion && suggestion.expect) || EMPTY_EXPECT;
    const wrote = (suggestion && suggestion.wrote) || {};
    // Welk model het voorstel schreef. Reist mee naar de opslag, zodat de rij
    // later nog kan zeggen wie hem opstelde.
    const suggestedBy = (suggestion && typeof suggestion.suggestedBy === 'string')
        ? suggestion.suggestedBy : null;

    const [name, setName] = useState('');
    const [question, setQuestion] = useState((turn && turn.question) || '');
    const [mustMention, setMustMention] = useState(listToLines(expect.mustMention));
    const [mustNotMention, setMustNotMention] = useState(listToLines(expect.mustNotMention));
    const [toolsExpected, setToolsExpected] = useState(listToLines(expect.toolsExpected));
    const [notes, setNotes] = useState(expect.notes || '');
    const [touched, setTouched] = useState({});

    const touch = (field, setter) => (value) => {
        setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }));
        setter(value);
    };

    /**
     * Heeft een MODEL hier iets geschreven? Alleen dan mag de regel erboven
     * dat zeggen. Een leeg voorstel ("ik zie hier niets dat vastgelegd moet
     * worden") is een geldig antwoord van de server, maar het is geen tekst
     * van een AI, en er hoort dus geen AI-vlag boven.
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
        // De herkomst reist MEE naar de opslag. Zonder dat bestond het merkje
        // "AI wrote this" alleen zolang dit formulier openstond: zodra er
        // opgeslagen was, was de regel niet meer te onderscheiden van een die
        // een mens tikte — terwijl juist die regel bepaalt of een run groen of
        // rood wordt. Een veld dat de mens aanraakte is vanaf dat moment van
        // de mens, wat er ook in stond.
        const writtenBy = {};
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
                    className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
                    style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
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
                    onChange={(e) => setQuestion(e.target.value)}
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
                    onChange={(e) => setName(e.target.value)}
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
                // "from this chat", niet "what this answer actually used": de
                // server krijgt deze namen uit de request-body en kan ze niet
                // nagaan — de testchat is efemeer en laat geen rij achter.
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
                <div role="status" data-testid="agent-tests-suggest-error" className="text-[12px]" style={{ color: 'var(--warning)' }}>
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
