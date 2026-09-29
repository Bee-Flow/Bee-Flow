import { Copy, Loader2, Lock, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { destinationForKind, kindLabel, parkSeed } from './handoff';
import { routeDescription } from './routeApi';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon, kindTint } from '../../../shared/kindColors';
import Modal from '../../../shared/Modal';

/**
 * "Beschrijf het — AI kiest de bouwstenen" (Track H4, v1).
 *
 * Eén component, twee omhulsels: `variant='inline'` is de kaart in de kop van
 * het Startscherm (die de plaatshouder vervangt), `variant='modal'` dezelfde
 * kaart in een dialoog, geopend vanuit de AI-regel van het "Nieuw"-menu.
 * Twee ingangen, één scherm — anders staan er straks twee AI-velden die
 * verschillend antwoorden.
 *
 * Drie toestanden en niets ertussenin:
 *
 *   1. LEEG    het veld met de voorbeeldzin uit het artboard; de verzendknop
 *              is uit zolang er niets staat.
 *   2. BEZIG   het veld blijft LEESBAAR (je moet kunnen nalezen wat je vroeg),
 *              de knop is uit, en annuleren breekt het verzoek echt af
 *              (AbortController) in plaats van het antwoord weg te gooien.
 *   3. SCHEMA  "Ik maak een <soort>: <naam>" met het soort-icoon en de
 *              soortkleur, daaronder de gekozen bouwstenen.
 *
 * ── Wat dit scherm NIET doet ────────────────────────────────────────────────
 *
 * De metgezellen worden GETOOND en NIET AANGEMAAKT. Meerdere soorten in één
 * keer (de gekoppelde lege schillen) is H4b en wacht op K8; een rij die zegt
 * "en ook een kennisbank" terwijl er niets wordt aangemaakt is een leugen, dus
 * staat het er letterlijk bij.
 *
 * Er wordt ook nooit stilletjes op een soort teruggevallen. Een onbruikbaar
 * antwoord (`undecided`) is een FOUT met een vraag om het concreter te
 * beschrijven — niet "dan maar een automation".
 *
 * ── Eerlijkheid over wat er van de kaart overblijft ─────────────────────────
 *
 * De kop belooft twee dingen — "een <soort>" en "die <naam> heet" — en de
 * brief eronder belooft een derde. Geen van drieën reist vanzelf mee, en het
 * scherm zegt per belofte apart of hij aankomt (handoff.js houdt de twee
 * tabellen bij):
 *
 *   `dest.seedable === false`   → de brief staat er zichtbaar onder, met een
 *                                 kopieerknop en één zin over waar je hem
 *                                 plakt. Vandaag is dat ELKE soort.
 *   `dest.carriesName === false`→ één zin dat de naam nog niet meegaat. Dat is
 *                                 geen detail: bij form, skill en kb ONTSTAAT
 *                                 er een rij, onder "Untitled form" /
 *                                 "Untitled skill" / "New knowledge base",
 *                                 direct nadat deze kaart een andere naam
 *                                 noemde.
 *
 * Eén vlag voor allebei was de eerste versie hiervan, en die loog: automation
 * droeg de naam mee, dus stond hij op `seedable: true`, dus verdween juist
 * daar het briefblok — op de meest waarschijnlijke route van dit scherm.
 *
 * ── Wat er niet te lezen viel, staat op de kaart ────────────────────────────
 *
 * `undecided` zijn de soorten waarvan de server de poort niet KON lezen. Die
 * soorten stonden niet in de woordenlijst van het model, dus het antwoord is
 * gekozen uit een smallere lijst dan normaal — en zonder een woord daarover
 * ziet een storing eruit als een zelfverzekerd plan. De kaart zegt het dus,
 * net als AttentionList ("Not checked: …") en RecentWorkList dat doen.
 *
 * ── De tweede rem ───────────────────────────────────────────────────────────
 *
 * Is de gekozen soort voor deze lezer gelockt of afwezig in `sections`, dan
 * toont de kaart de lock-hint en is er geen actieve knop. De server hoort zo'n
 * soort al niet terug te geven; deze rem staat er omdat "hoort niet" en "kan
 * niet" twee verschillende dingen zijn.
 */

const CARD_CLASS = 'rounded-xl border border-[var(--border-default)] px-3.5 py-3';

const ERROR_TEXT = {
    no_text: ['studio.ai.err_no_text', 'Type a short description first.'],
    no_model: ['studio.ai.err_no_model', 'No AI model is set up yet, so nothing can be picked for you.'],
    ai_unusable: ['studio.ai.err_ai_unusable', 'That was not clear enough to pick a building block — describe it a little more concretely.'],
    rate_limited: ['studio.ai.err_rate_limited', 'That is a lot of requests in a row — wait a moment and try again.'],
    failed: ['studio.ai.err_failed', 'Could not read that just now. Try again.'],
    // Twee antwoorden van de server die er allebei uitzien als "geen soort" en
    // het NIET zijn (huisregel 12: leeg en onleesbaar blijven te onderscheiden).
    none_available: ['studio.ai.err_none_available', 'There is nothing here you can build yet — ask an admin what your workspace has switched on.'],
    gates_unreadable: ['studio.ai.err_gates_unreadable', 'We could not work out what you may build right now. Try again in a moment.'],
};

/**
 * Waarom er geen soort uit kwam. De server stuurt `available` (wat deze lezer
 * mag bouwen) en `undecided` (de soorten waarvan de gate niet te lezen was);
 * een lege `available` met een gevulde `undecided` is iets anders dan een lege
 * `available` zonder — en allebei iets anders dan "de AI koos niets".
 */
const noKindCode = (result) => {
    if (Array.isArray(result.available) && result.available.length === 0) {
        return result.undecided.length ? 'gates_unreadable' : 'none_available';
    }
    return 'ai_unusable';
};

function BlockRow({ kind, name, note, t }) {
    const Icon = kindIcon(kind);
    const color = kindColorVar(kind);
    return (
        <li
            data-testid={`studio-ai-block-${kind}`}
            className="flex items-start gap-2 rounded-lg px-2 py-1.5"
            style={{ background: kindTint(kind, 8) }}
        >
            {Icon ? <Icon className="w-3.5 h-3.5 mt-[2px] flex-shrink-0" style={{ color }} strokeWidth={1.75} aria-hidden="true" /> : null}
            <span className="min-w-0">
                <span className="text-[12px] font-medium text-[var(--text-primary)]">
                    {kindLabel(kind, t)}
                    {name ? <span className="text-[var(--text-secondary)] font-normal">{` · ${name}`}</span> : null}
                </span>
                {note ? <span className="block text-[11px] text-[var(--text-tertiary)]">{note}</span> : null}
            </span>
        </li>
    );
}

/**
 * De voorbehouden onder de bouwstenen: wat er van deze kaart NIET meereist, en
 * wat de server niet heeft kunnen nakijken. Apart van PlanCard omdat het drie
 * onafhankelijke zinnen zijn die elk hun eigen voorwaarde hebben — en omdat
 * een lezer die "wat belooft dit scherm te veel" komt controleren ze hier bij
 * elkaar vindt.
 */
function PlanCaveats({ plan, dest, blocked, copied, onCopy, t }) {
    const undecided = Array.isArray(plan.undecided) ? plan.undecided : [];
    return (
        <>
            {undecided.length > 0 ? (
                // Geen meervoudspaar: de zin somt namen op en verandert niet
                // met het aantal — dezelfde afweging als
                // studio.attention.unavailable_named.
                <p data-testid="studio-ai-undecided" className="mt-2 text-[11.5px] text-[var(--text-secondary)]">
                    {t(
                        'studio.ai.undecided_named',
                        'We could not check every building block just now ({kinds}), so this choice was made from a shorter list than usual.',
                        { kinds: undecided.map((k) => kindLabel(k, t)).join(', ') },
                    )}
                </p>
            ) : null}
            {!blocked && dest && !dest.carriesName && plan.name ? (
                <p data-testid="studio-ai-name" className="mt-2 text-[11.5px] text-[var(--text-secondary)]">
                    {t('studio.ai.name_manual', 'The name does not travel along yet — give it this name in the builder that opens.')}
                </p>
            ) : null}
            {!blocked && dest && !dest.seedable ? (
                <div data-testid="studio-ai-seed" className="mt-2 rounded-lg border border-[var(--border-default)] px-2.5 py-2">
                    <p className="text-[11.5px] text-[var(--text-secondary)]">
                        {t('studio.ai.seed_manual', 'Your description does not travel along yet — paste it into the assistant of the builder that opens.')}
                    </p>
                    <p data-testid="studio-ai-seed-text" className="mt-1 text-[12px] text-[var(--text-primary)] whitespace-pre-wrap break-words">{plan.seed}</p>
                    <button
                        type="button"
                        data-testid="studio-ai-copy"
                        onClick={onCopy}
                        className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Copy className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                        {copied ? t('studio.ai.copied', 'Copied') : t('studio.ai.copy', 'Copy description')}
                    </button>
                </div>
            ) : null}
        </>
    );
}

/**
 * De schema-kaart: "Ik maak een <soort>: <naam>", de gekozen bouwstenen en de
 * twee knoppen. Apart van het invoerveld omdat het een ander scherm is met een
 * andere vraag ("klopt dit?" in plaats van "wat wil je?").
 */
function PlanCard({ plan, dest, blocked, busyRun, copied, errorLine, onConfirm, onBack, onCopy, t }) {
    const Icon = kindIcon(plan.kind);
    const color = kindColorVar(plan.kind);
    const title = plan.name
        ? t('studio.ai.plan_title', 'New {kind}: {name}', { kind: dest?.label || plan.kind, name: plan.name })
        : t('studio.ai.plan_title_unnamed', 'New {kind}', { kind: dest?.label || plan.kind });
    return (
        <div data-testid="studio-ai-plan" className={CARD_CLASS} style={{ background: kindTint(plan.kind, 4) }}>
            <div className="flex items-center gap-2">
                {Icon ? <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} strokeWidth={1.75} aria-hidden="true" /> : null}
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2>
            </div>
            <p className="mt-1 text-[11px] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
                {t('studio.ai.blocks', 'Building blocks')}
            </p>
            <ul className="mt-1 flex flex-col gap-1">
                <BlockRow kind={plan.kind} name={plan.name} note={null} t={t} />
                {plan.companions.map((c) => (
                    <BlockRow
                        key={c.kind}
                        kind={c.kind}
                        name={c.name}
                        note={t('studio.ai.companion_note', 'Shown for context — this version does not create it yet.')}
                        t={t}
                    />
                ))}
            </ul>
            {blocked ? (
                <p data-testid="studio-ai-lock" className="mt-2 flex items-start gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                    <Lock className="w-3.5 h-3.5 mt-[1px] flex-shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    {dest?.lockHint || t('studio.ai.unavailable', 'This building block is not available in your workspace.')}
                </p>
            ) : null}
            <PlanCaveats plan={plan} dest={dest} blocked={blocked} copied={copied} onCopy={onCopy} t={t} />
            {errorLine ? <p data-testid="studio-ai-error" className="mt-2 text-[11.5px] text-[var(--error)]">{errorLine}</p> : null}
            <div className="mt-2.5 flex items-center gap-2">
                <button
                    type="button"
                    data-testid="studio-ai-create"
                    onClick={onConfirm}
                    disabled={blocked || busyRun}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent-primary, #2563eb)' }}
                >
                    {t('studio.ai.create', 'Make this')}
                </button>
                <button
                    type="button"
                    data-testid="studio-ai-other"
                    onClick={onBack}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)]"
                >
                    {t('studio.ai.other', 'Something else')}
                </button>
            </div>
        </div>
    );
}

function PanelBody({ sections, onNavigate, user, onClose }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [phase, setPhase] = useState('idle'); // idle | busy | plan
    const [plan, setPlan] = useState(null);
    const [errorCode, setErrorCode] = useState(null);
    const [copied, setCopied] = useState(false);
    const [busyRun, setBusyRun] = useState(false);
    const abortRef = useRef(null);

    useEffect(() => () => { try { abortRef.current?.abort(); } catch { /* al weg */ } }, []);

    const submit = useCallback(async () => {
        if (!text.trim() || phase === 'busy') return;
        const controller = new AbortController();
        abortRef.current = controller;
        setErrorCode(null);
        setPhase('busy');
        let result;
        try {
            result = await routeDescription(text, { signal: controller.signal });
        } catch (err) {
            // Afgebroken — door de annuleerknop of door de fetch-laag zelf.
            // Geen fout op het scherm (de brief blijft staan), maar wél terug
            // naar het veld: anders blijft "bezig" hangen op een verzoek dat
            // nooit meer antwoordt. Een verouderd verzoek (er loopt alweer een
            // nieuwer) laat de toestand met rust.
            if (err?.name === 'AbortError') {
                if (abortRef.current === controller) setPhase('idle');
                return;
            }
            result = { ok: false, code: 'failed' };
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
        if (controller.signal.aborted) return;
        if (!result.ok) { setPhase('idle'); setErrorCode(result.code || 'failed'); return; }
        if (!result.kind) {
            // Een antwoord zonder soort is geen soort. Nooit een gok.
            setPhase('idle');
            setErrorCode(noKindCode(result));
            return;
        }
        setPlan({ ...result, seed: result.seed || text.trim() });
        setPhase('plan');
    }, [text, phase]);

    const cancel = useCallback(() => {
        try { abortRef.current?.abort(); } catch { /* al weg */ }
        abortRef.current = null;
        setPhase('idle');
    }, []);

    // "Iets anders": terug naar het veld MET de tekst erin. De brief mag nooit
    // verdwijnen door een knop die "nee" betekent.
    const back = useCallback(() => { setPlan(null); setErrorCode(null); setPhase('idle'); }, []);

    const dest = plan ? destinationForKind(plan.kind, { sections, t }) : null;
    // De server hoort een soort die deze lezer niet mag al niet te sturen;
    // staat de soort tóch niet in zijn eigen `available`-lijst, dan telt dat
    // mee. Geen lijst = onbekend, en dan beslist alleen de sectie-rem.
    const serverExcludes = !!plan && Array.isArray(plan.available) && !plan.available.includes(plan.kind);
    const blocked = !!plan && (!dest?.available || serverExcludes);

    const confirm = useCallback(async () => {
        if (!plan || !dest || blocked || busyRun) return;
        setBusyRun(true);
        try {
            parkSeed(plan.kind, plan.seed);
            await dest.run({ onNavigate, t, user, name: plan.name, seed: plan.seed });
            onClose?.();
        } catch {
            setErrorCode('failed');
        } finally {
            setBusyRun(false);
        }
    }, [plan, dest, blocked, busyRun, onNavigate, t, user, onClose]);

    const copySeed = useCallback(async () => {
        try {
            await navigator?.clipboard?.writeText(plan?.seed || '');
            setCopied(true);
        } catch { /* geen klembord: de tekst staat er zelf, selecteerbaar */ }
    }, [plan]);

    const errorLine = errorCode ? t(ERROR_TEXT[errorCode]?.[0] || ERROR_TEXT.failed[0], ERROR_TEXT[errorCode]?.[1] || ERROR_TEXT.failed[1]) : null;

    if (phase === 'plan' && plan) {
        return (
            <PlanCard
                plan={plan}
                dest={dest}
                blocked={blocked}
                busyRun={busyRun}
                copied={copied}
                errorLine={errorLine}
                onConfirm={confirm}
                onBack={back}
                onCopy={copySeed}
                t={t}
            />
        );
    }

    const busy = phase === 'busy';
    return (
        <div className={CARD_CLASS} style={{ background: 'color-mix(in srgb, var(--type-ai) 4%, transparent)' }}>
            <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--type-ai)' }} strokeWidth={1.75} aria-hidden="true" />
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('studio.ai.describe_title', 'Describe what you want')}
                </h2>
            </div>
            <textarea
                data-testid="studio-ai-input"
                aria-label={t('studio.ai.describe_title', 'Describe what you want')}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                readOnly={busy}
                placeholder={t('studio.ai.placeholder', 'an agent that answers questions about our quotes, with the Quotes table as its knowledge')}
                className="mt-2 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-[12px] leading-[17px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--type-ai)]"
            />
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                {t('studio.ai.hint', 'The AI picks the building blocks and shows you the plan first.')}
            </p>
            {errorLine ? (
                <p data-testid="studio-ai-error" className="mt-1.5 text-[11.5px] text-[var(--error)]">
                    {errorLine}
                    {errorCode === 'no_model' ? (
                        <span className="text-[var(--text-tertiary)]">{` ${t('studio.ai.err_no_model_way_out', 'Pick a building block from New in the meantime.')}`}</span>
                    ) : null}
                </p>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
                <button
                    type="button"
                    data-testid="studio-ai-submit"
                    onClick={submit}
                    disabled={busy || !text.trim()}
                    className="h-8 px-3 rounded-lg text-[12px] font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ background: 'var(--accent-primary, #2563eb)' }}
                >
                    {t('studio.ai.submit', 'Show the plan')}
                </button>
                {busy ? (
                    <>
                        <span data-testid="studio-ai-busy" className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                            {t('studio.ai.busy', 'Reading your description…')}
                        </span>
                        <button
                            type="button"
                            data-testid="studio-ai-cancel"
                            onClick={cancel}
                            className="h-8 px-3 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] border border-[var(--border-default)]"
                        >
                            {t('studio.ai.cancel', 'Cancel')}
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}

export default function DescribeItPanel({
    sections, onNavigate, user = null, variant = 'inline', open = true, onClose = null,
}) {
    const { t } = useTranslation();
    const body = (
        <PanelBody sections={sections} onNavigate={onNavigate} user={user} onClose={onClose} />
    );
    if (variant === 'modal') {
        return (
            <Modal
                open={open}
                onClose={onClose || (() => {})}
                title={t('studio.ai.title', 'Build with AI')}
                size="md"
            >
                <div data-testid="studio-ai-panel" data-variant="modal">{body}</div>
            </Modal>
        );
    }
    if (!open) return null;
    return <div data-testid="studio-ai-panel" data-variant="inline">{body}</div>;
}
