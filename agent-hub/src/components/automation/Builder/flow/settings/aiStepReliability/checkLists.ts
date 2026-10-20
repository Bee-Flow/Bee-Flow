// Editing the two stored lists (enumFrom and checks) as one list of cards.
import {
    MAX_CHECKS, MAX_ENUM_FROM,
    type AllowedFromCheck, type Check, type CheckKind, type EnumFrom, type FieldKind, type FieldPathOption,
} from './reliabilityModel';

/** One card on screen: an entry of enumFrom (shown to the AI) or of checks. */
export interface Card { list: 'enumFrom' | 'checks'; index: number; entry: Check }

export const CHECK_KINDS: readonly CheckKind[] = ['allowedFrom', 'numbersFrom', 'script', 'items'];
const KIND_FIELD: Record<CheckKind, FieldKind> = { allowedFrom: 'text', numbersFrom: 'text', script: 'text', items: 'list' };

/** Entries of enumFrom have no `kind`; they are allowedFrom checks that are also shown to the model. */
export const asCheck = (e: EnumFrom): AllowedFromCheck => ({ kind: 'allowedFrom', ...e });
export function asEnum(c: AllowedFromCheck): EnumFrom {
    const out: Record<string, unknown> = { ...c };
    delete out.kind;
    return out as unknown as EnumFrom;
}

export const cardsOf = (enumFrom: EnumFrom[], checks: Check[]): Card[] => [
    ...enumFrom.map((e, index): Card => ({ list: 'enumFrom', index, entry: asCheck(e) })),
    ...checks.map((entry, index): Card => ({ list: 'checks', index, entry })),
];

type Set = (key: string, value: unknown) => void;
const replace = <T,>(list: T[], index: number, next: T) => list.map((x, i) => (i === index ? next : x));
const without = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index);

export const canShowList = (enumFrom: EnumFrom[]) => enumFrom.length < MAX_ENUM_FROM;

/** Can one more check of this kind be added? */
export const kindAvailable = (kind: CheckKind, enumFrom: EnumFrom[], checks: Check[]) =>
    (kind === 'allowedFrom' && canShowList(enumFrom)) || checks.length < MAX_CHECKS;

export function removeCard(card: Card, enumFrom: EnumFrom[], checks: Check[], set: Set): void {
    if (card.list === 'enumFrom') set('enumFrom', without(enumFrom, card.index));
    else set('checks', without(checks, card.index));
}

export function updateCard(card: Card, next: Check, enumFrom: EnumFrom[], checks: Check[], set: Set): void {
    if (card.list === 'enumFrom') set('enumFrom', replace(enumFrom, card.index, asEnum(next as AllowedFromCheck)));
    else set('checks', replace(checks, card.index, next));
}

/** Showing the list to the AI moves the entry between the two stored lists. */
export function setShown(card: Card, shown: boolean, enumFrom: EnumFrom[], checks: Check[], set: Set): void {
    const entry = card.entry as AllowedFromCheck;
    if (shown && card.list === 'checks') {
        set('checks', without(checks, card.index));
        set('enumFrom', [...enumFrom, asEnum(entry)]);
    } else if (!shown && card.list === 'enumFrom') {
        set('enumFrom', without(enumFrom, card.index));
        set('checks', [...checks, entry]);
    }
}

/** A new, mostly empty card of this kind. The field is preselected only when exactly one fits. */
export function addCard(kind: CheckKind, fields: FieldPathOption[], enumFrom: EnumFrom[], checks: Check[], set: Set): void {
    const only = fields.filter(f => f.kind === KIND_FIELD[kind]);
    const field = only.length === 1 ? only[0].path : '';
    if (kind === 'allowedFrom') {
        const entry: EnumFrom = { field, ref: '' };
        if (canShowList(enumFrom)) set('enumFrom', [...enumFrom, entry]);
        else set('checks', [...checks, asCheck(entry)]);
    } else if (kind === 'numbersFrom') set('checks', [...checks, { kind, field, ref: '' }]);
    else if (kind === 'script') set('checks', [...checks, { kind, field, script: 'latin' }]);
    else set('checks', [...checks, { kind, field, minItems: 1 }]);
}
