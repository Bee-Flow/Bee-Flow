/** Typen van de testset-kaart (TestSetCard). Alleen types. */

import type { ReadState } from '../canUse/canUseFacts';
import type { refusalFor, summariseRun } from './testSetFacts';
import type { RunProgress, TestItem, TestRun } from './testSetFacts.types';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/** Eén test uit de lijst, zoals de kaart hem gebruikt. */
export interface TestDef {
    id: string;
    name?: string | null;
    question: string;
    writtenBy?: Record<string, unknown> | null;
}

/** Eén historische run: de run zelf plus het id dat de lijst gebruikt. */
export type RunRowData = TestRun & { id?: string };

/** Een weigering zoals `refusalFor` hem teruggeeft (zonder de null-tak). */
export type Refusal = NonNullable<ReturnType<typeof refusalFor>>;

/** De uitslag van één run, zoals `summariseRun` hem teruggeeft. */
export type RunSummary = ReturnType<typeof summariseRun>;

/**
 * De testset-kaart van de Test-tab (Agents-artboard 1c, A4 deel D).
 *
 * Vier dingen, en drie ervan zijn er om te voorkomen dat de kaart iets beweert
 * wat ze niet weet:
 *
 *   DE TELLING   "11 / 12 goed" is een uitslag van één RUN. Nooit gedraaid is
 *                geen "0 / 12" (er is niets gevraagd), een lezing die mislukte
 *                is dat ook niet, en een run die halverwege omviel is geen
 *                uitslag. `testSetFacts.summariseRun` beslist welke van de
 *                vier het is; deze kaart schrijft er alleen de zin bij.
 *   DE FAALREGEL het ene niet-groene resultaat, met WAAROM. `fail`, `blocked`
 *                en `error` zijn drie verschillende dingen en krijgen drie
 *                verschillende zinnen: alleen de eerste zegt iets over de
 *                agent.
 *   BEKIJK       de vragen met hun laatste oordeel, plus de run-historie —
 *                want één getal zonder geschiedenis maakt van een toevallige
 *                groene run een feit.
 *   + DIT GESPREK ALS TEST
 *                de knop die van de laatste beurt een test maakt. Hij staat er
 *                alleen als er een beurt IS; een knop die nergens heen kan is
 *                erger dan geen knop.
 *
 * ── EEN WEIGERING IS GEEN MISLUKTE TEST ─────────────────────────────
 * "Er is geen model ingericht om deze antwoorden te beoordelen" komt terug
 * vóór er één beurt gedraaid heeft (`POST /:id/tests/run` weigert met 503).
 * Die weigering wordt hier als weigering getekend en laat de telling met rust.
 * Als hij als rode tests zou landen, gaat iemand zijn agent repareren terwijl
 * er niets mis is met zijn agent — en dat is precies het soort vals-rood dat
 * mensen leert de testset te negeren.
 *
 * ── ALLEEN-LEZEN HAALT DE ACTIES WEG, EN DE SERVER DE FEITEN ────────
 * `ro` verbergt Run en "+ Dit gesprek als test" (BFSF-271: alleen-lezen haalt
 * de BEWERKENDE affordances weg). De telling, de faalregel en Bekijk blijven —
 * ZOLANG de lezing lukt.
 *
 * En die lukt vandaag niet voor iemand die alleen mag bekijken: elke route in
 * `routes/agents/tests.js` loopt door `requireEditableAgent` en geeft 403
 * `agent_not_editable`. Dat is een bewuste, smalle keuze (een testvraag is
 * bouwmateriaal), en de kaart mag hem dus niet als storing tekenen. Hij komt
 * binnen als `readRefusal` en krijgt de weigeringsbanner, zonder Opnieuw-knop.
 * De kaart belooft daarmee niets wat de server niet geeft.
 */

export interface TestSetCardProps {
    t: TranslateFn;
    ro?: boolean;
    rel?: ((value: unknown) => string) | null;
    tests?: TestDef[];
    testsState?: ReadState;
    onRetryTests?: (() => void) | null;
    readRefusal?: Refusal | null;
    lastRun?: TestRun | null;
    lastRunUnknown?: boolean;
    runs?: RunRowData[];
    runsState?: ReadState;
    runsUnknown?: boolean;
    runsKeep?: number;
    onOpenDetail?: (() => void) | null;
    progress?: RunProgress | null;
    refusal?: Refusal | null;
    onRetryRun?: (() => void) | null;
    onRun?: (() => void) | null;
    running?: boolean;
    onAddFromChat?: (() => void) | null;
    canAddFromChat?: boolean;
}
