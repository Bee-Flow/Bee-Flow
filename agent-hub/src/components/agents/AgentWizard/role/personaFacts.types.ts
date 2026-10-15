/** Typen van de rol-feiten (personaFacts). Alleen types, geen runtime-code. */

export type UnknownMode = 'honest' | 'web' | 'handoff';
export type PersonaMode = 'fields' | 'free';

/** De volle vorm van de opgeslagen persona. */
export interface Persona {
    who: string;
    tone: { chips: string[]; text: string };
    does: string[];
    doesNot: string[];
    unknown: { mode: UnknownMode; automationId: string | null };
    language: string | null;
    mode: PersonaMode;
    freeText: string;
}

/** Een toonchip zoals de kaart hem tekent. */
export interface ToneChipRow {
    value: string;
    on: boolean;
    offered: boolean;
}

/** Waarom een bullet-mutatie niets veranderde, als code. */
export type BulletRejection = 'empty' | 'duplicate' | 'full' | 'missing';

export interface BulletResult {
    list: string[];
    rejected: BulletRejection | null;
}

/** Eén automatisering-keuze voor de hand-off. */
export interface HandoffRow {
    id: string;
    title: string | null;
    active: boolean;
}

/** Spiegel van personaPrompt.LIMITS. Boven deze grenzen knipt de server. */
