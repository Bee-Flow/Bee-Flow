import { Code, Loader2, PenLine } from 'lucide-react';
import React from 'react';
import BulletsCard from './BulletsCard';
import {
    READ, addBullet, editBullet, patchPersona, personaShape, removeBullet, toggleToneChip,
} from './personaFacts';
import RoleCard, { RoleNote } from './RoleCard';
import ToneCard from './ToneCard';
import UnknownCard from './UnknownCard';
import WhoCard from './WhoCard';

/**
 * De vijf kaarten van de tab "Rol" (Agents-artboard 1c, A3 deel A) — de eerste
 * schrijver van `agents.persona` aan de clientkant.
 *
 * GESTUURD, GEEN EIGEN STAAT: er gaat een persona in, er komt een VOLLEDIGE
 * nieuwe persona uit `onChange`. De ouder hangt hem in `stateRef.current.persona`
 * en laat de autosave hem meesturen. Halve objecten zijn hier onmogelijk, en dat
 * is met opzet: `PUT /agents/:id` leest een ONTBREKEND veld als "laat de kolom
 * staan", dus een patch met alleen `who` erin zou een bullet die iemand net
 * weghaalde stilzwijgend terugzetten.
 *
 * ── DRIE TOESTANDEN, DRIE SCHERMEN ──────────────────────────────────
 *   nog niet gelezen   één regel, geen kaarten. Vijf lege vakken tekenen
 *                      terwijl de lezing loopt is een bewering.
 *   niet te lezen      een waarschuwing. `GET /agents/:id` geeft de persona
 *                      alléén mee met `?draft=1` én bewerkrecht — anders
 *                      strippen `parseConfig`/`_stripPersona` de kolom er
 *                      juist uit. "Afwezig" betekent hier dus ONBEKEND, en
 *                      onbekend is geen lege rol.
 *   `mode: 'free'`     de vijf kaarten staan er wél, maar alleen-lezen. De
 *                      vrije tekst IS het prompt; deze velden beschrijven hem.
 *                      De weg terug is een expliciete AI-parse
 *                      (`POST /agents/:id/persona/parse`), nooit een stille
 *                      terugvertaling — vandaar dat de knop alleen verschijnt
 *                      als de ouder er een handler voor meegeeft.
 */

/** De strook onder de kaarten: overstappen naar één vrije instructie. */
function FreeFooter({ t, onOpenFree }) {
    return (
        <div
            data-testid="agent-role-free-footer"
            className="sm:col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]"
        >
            <Code size={13} aria-hidden="true" className="flex-shrink-0" />
            <span>{t('agent_studio.role.free_footer', 'Rather write it all as one text?')}</span>
            <button
                type="button"
                data-testid="agent-role-free-open"
                onClick={onOpenFree}
                className="font-medium text-[var(--text-primary)] underline hover:opacity-80"
            >
                {t('agent_studio.role.free_footer_action', 'Open as free instruction')}
            </button>
            {/* Het artboard schrijft hier "de vakken blijven synchroon". Dat is
                niet waar: de richting is één kant op (velden → prompt) en terug
                gaat alleen via een expliciete parse. Zie personaPrompt.js. */}
            <span className="text-[var(--text-tertiary)]">
                {t('agent_studio.role.free_footer_note', 'That text becomes what the agent runs; these fields stay behind as a description of it, and reading them back is a separate step.')}
            </span>
        </div>
    );
}

/**
 * De banner boven de kaarten wanneer de agent in vrije modus staat.
 *
 * TWEE ZINNEN, EN HET VERSCHIL IS HET MEERDERHEIDSGEVAL. "De velden beschrijven
 * hem" klopt voor een agent die ooit in velden geschreven is en daarna naar
 * vrije tekst ging. Voor élke agent van vóór A1c klopt het niet: `personaOf`
 * geeft daar `{mode:'free', freeText: system_prompt}` met álle velden leeg, en
 * dan stond er een banner die zegt dat de vakken hem beschrijven boven vijf
 * kaarten die "Nothing written down yet." zeggen — over een agent die
 * aantoonbaar een rol, een toon en regels heeft. Die velden zijn niet LEEG maar
 * NOG NIET AFGELEID, en de afleiding is de expliciete parse waar de knop
 * hiernaast voor is.
 */
function FreeBanner({ t, onBackToFields, describes }) {
    return (
        <div
            data-testid="agent-role-free-banner"
            data-describes={describes ? 'yes' : 'no'}
            className="sm:col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]"
        >
            <PenLine size={13} aria-hidden="true" className="flex-shrink-0" />
            <span>{describes
                ? t('agent_studio.role.free_banner', 'This agent is written as one free instruction, and that text is what it runs. The fields below describe it — changing them here does nothing until it goes back to fields.')
                : t('agent_studio.role.free_banner_underived', 'This agent is written as one free instruction, and that text is what it runs. Nothing has been read back out of it yet, so the empty fields below say nothing about the agent.')}</span>
            {onBackToFields && (
                <button
                    type="button"
                    data-testid="agent-role-back-to-fields"
                    onClick={onBackToFields}
                    className="font-medium text-[var(--text-primary)] underline hover:opacity-80"
                >
                    {t('agent_studio.role.free_back_action', 'Read the instruction back into fields')}
                </button>
            )}
        </div>
    );
}

/** Nog niet gelezen / niet te lezen — nooit vijf lege kaarten. */
function RoleUnknown({ t, state }) {
    if (state === READ.LOADING) {
        return (
            <div aria-live="polite" data-testid="agent-role-loading" className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                <span>{t('agent_studio.role.persona_loading', 'Reading the role of this agent…')}</span>
            </div>
        );
    }
    return (
        <RoleCard testId="agent-role-unreadable" title={t('agent_studio.role.persona_title', 'Role')}>
            <RoleNote tone="warn" testId="agent-role-unreadable-note">
                {t('agent_studio.role.persona_unreadable', 'The role of this agent could not be read here, so these fields are not shown. That is not the same as the agent having no role.')}
            </RoleNote>
        </RoleCard>
    );
}

/**
 * Welke van de drie schermen dit wordt.
 *
 * DE PERSONA WINT VAN DE TOESTAND. Stond er `personaState === READ.ERROR` vóór
 * de leesbaarheidstest, dan verdween een rol die we WEL hadden zodra de tweede
 * lezing (`GET /agents/:id?draft=1`) mislukte — terwijl de aanroeper juist
 * `persona={agent?.persona ?? conceptFacts.persona}` samenstelt en die eerste
 * helft prima leesbaar kan zijn. Een gelezen rol tonen is nooit fout.
 *
 * En andersom: is er NIETS leesbaars, dan is dat "onbekend", niet "leeg" —
 * `READ.OK` met een gestripte kolom hoort dezelfde waarschuwing te geven als
 * `READ.ERROR`, want in allebei de gevallen weten we het niet. Alleen LOADING
 * krijgt zijn eigen scherm, omdat daar nog een antwoord onderweg is.
 */
function roleScreen({ readable, personaState }) {
    if (readable) return 'cards';
    return personaState === READ.LOADING ? 'loading' : 'unreadable';
}

export default function RoleCards({
    t,
    persona,
    personaState = READ.OK,
    onChange,
    readOnly = false,
    automations = null,
    automationsState = READ.OK,
    agentOwnerId = null,
    userId = null,
    onOpenFree = null,
    onBackToFields = null,
}) {
    const { persona: p, readable } = personaShape(persona);
    const screen = roleScreen({ readable, personaState });
    if (screen === 'loading') return <RoleUnknown t={t} state={READ.LOADING} />;
    if (screen === 'unreadable') return <RoleUnknown t={t} state={READ.ERROR} />;

    const free = p.mode === 'free';
    const ro = readOnly || free;
    const write = (next) => onChange?.(next);
    const addTo = (field) => (text) => {
        const { list, rejected } = addBullet(p[field], text);
        if (!rejected) write(patchPersona(p, { [field]: list }));
        return rejected;
    };
    // Geeft de afwijzingscode door aan de kaart. Een bewerking die stilletjes
    // niets doet is erger dan een bewerking die zegt waarom.
    const editIn = (field) => (i, text) => {
        const { list, rejected } = editBullet(p[field], i, text);
        if (!rejected) write(patchPersona(p, { [field]: list }));
        return rejected;
    };
    const removeFrom = (field) => (i) => write(patchPersona(p, { [field]: removeBullet(p[field], i) }));
    // Zegt de banner de waarheid? Alleen als er ook echt iets in de velden staat.
    const describes = !!(p.who || p.tone.chips.length || p.tone.text || p.does.length || p.doesNot.length);

    return (
        <div data-testid="agent-role-cards" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {free && <FreeBanner t={t} onBackToFields={onBackToFields} describes={describes} />}

            <WhoCard t={t} value={p.who} readOnly={ro} onChange={(v) => write(patchPersona(p, { who: v }))} />

            <ToneCard
                t={t}
                persona={p}
                readOnly={ro}
                onToggleChip={(chip) => write(toggleToneChip(p, chip))}
                onChangeText={(v) => write(patchPersona(p, { tone: { ...p.tone, text: v } }))}
            />

            <BulletsCard
                t={t} variant="does" items={p.does} readOnly={ro}
                onAdd={addTo('does')} onEdit={editIn('does')} onRemove={removeFrom('does')}
            />
            <BulletsCard
                t={t} variant="doesNot" items={p.doesNot} readOnly={ro}
                onAdd={addTo('doesNot')} onEdit={editIn('doesNot')} onRemove={removeFrom('doesNot')}
            />

            <UnknownCard
                t={t}
                persona={p}
                readOnly={ro}
                automations={automations}
                automationsState={automationsState}
                agentOwnerId={agentOwnerId}
                userId={userId}
                onChangeMode={(mode) => write(patchPersona(p, {
                    unknown: { mode, automationId: mode === 'handoff' ? p.unknown.automationId : null },
                }))}
                onChangeHandoff={(id) => write(patchPersona(p, {
                    unknown: { mode: 'handoff', automationId: id || null },
                }))}
            />

            {!ro && onOpenFree && <FreeFooter t={t} onOpenFree={onOpenFree} />}
        </div>
    );
}
