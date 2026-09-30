/**
 * What a "rewrite the summary" answered, and what the person is told about it.
 */

import type { ActionItem, Chapter, Decision, OpenQuestion, Speaker } from './types';

export interface RegenerateResult {
    summary: string;
    actionItems: ActionItem[];
    decisions: Decision[];
    questions: OpenQuestion[];
    chapters: Chapter[];
    speakers: Speaker[];
    /**
     * Heeft de artefactpass daadwerkelijk gedraaid?
     *
     * Regenerate heeft bewust GEEN samenvatting-kanaal voor slecht nieuws: de
     * samenvatting die terugkomt is altijd vers. Dit veld is dus het enige
     * kanaal waarlangs de server kan zeggen dat het uitwerken van de
     * actiepunten, besluiten en vragen is omgevallen en de OUDE lijsten zijn
     * blijven staan. Een client die het niet leest toont een groene toast bij
     * een halve mislukking, en dan drukt niemand nog eens op Opnieuw.
     *
     * Optioneel omdat een oudere server het veld niet stuurt — en `undefined`
     * beweert niets, dus alleen een expliciete `false` is nieuws.
     */
    artifactsRegenerated?: boolean;
}

/** Wat de gebruiker na een regeneratie te zien krijgt. */
export interface RegenerateOutcome {
    kind: 'success' | 'warning';
    message: string;
}

/**
 * De uitkomst van een regeneratie in één zin — de web-client zegt hetzelfde.
 *
 * Puur, en met opzet buiten het scherm: dit is de regel die zegt WANNEER een
 * regeneratie geen onverdeeld succes is, en die hoort getest te kunnen worden
 * zonder een renderer.
 *
 * Drie gevallen, en alleen het eerste is groen:
 *   - de pass draaide en leverde alles op;
 *   - de pass viel om (`artifactsRegenerated === false`) — de samenvatting is
 *     wél vernieuwd, de lijsten zijn de oude;
 *   - de pass draaide, maar vond een of meer bewaarde punten niet terug
 *     (`orphaned`): die staan er nog omdat iemand ze had afgevinkt of
 *     overgetypt, en dat moet gezegd worden voordat de kaart doet alsof de AI
 *     ze zojuist opleverde.
 */
export function describeRegenerateOutcome(res: RegenerateResult | null): RegenerateOutcome {
    if (!res) return { kind: 'warning', message: 'The server sent no answer — nothing was changed.' };
    if (res.artifactsRegenerated === false) {
        return {
            kind: 'warning',
            message: 'Summary rewritten, but working out the action items, decisions and questions failed — the existing ones were kept.',
        };
    }
    const kept = Array.isArray(res.actionItems)
        ? res.actionItems.filter((item) => item && item.orphaned).length
        : 0;
    if (kept > 0) {
        return {
            kind: 'warning',
            message: `Summary rewritten. ${kept} action item(s) were kept: the new pass no longer found them, and they had been checked off or edited.`,
        };
    }
    return { kind: 'success', message: 'Summary rewritten' };
}
