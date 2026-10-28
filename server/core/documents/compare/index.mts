/**
 * Compare two Studio documents from their structured model, never from
 * pixels. Which comparison runs is decided by the document FAMILY:
 *
 *   presentation           → deck   (slide by slide, plus the look)   deckCompare.mts
 *   spreadsheet            → sheet  (tabs, rows, columns, cells)       sheetCompare.mts
 *   every other doc type   → text   (blocks with word diffs)           textCompare.mts
 *
 * A text document and a presentation compare as text (the outline is
 * Markdown), which is what "this page became a deck" needs. A spreadsheet
 * against anything else is refused: there is no honest common model.
 *
 * The loader (routes/studioAppDocuments.js) reads both sides with the access
 * checks and hands over what each family needs; this module does no I/O.
 */

import { compareDecks, type AnyDeck, type DeckCompareResult } from './deckCompare.mts';
import { compareSheets, type SheetCompareResult, type SheetSide } from './sheetCompare.mts';
import { compareText, type TextCompareResult, type TextSource } from './textCompare.mts';

export type Family = 'text' | 'deck' | 'sheet';
export type CompareResult = TextCompareResult | DeckCompareResult | SheetCompareResult;

export function familyOf(docType: unknown): Family {
    if (docType === 'presentation') return 'deck';
    if (docType === 'spreadsheet') return 'sheet';
    return 'text';
}

/** What one side of a compare needs, per family. */
export interface CompareSide {
    docType: string;
    /** text: the body (HTML); deck: the outline (Markdown). */
    bodyHtml?: string;
    /** deck: the normalised deck (deckDocument.deckFromDocument). */
    deck?: AnyDeck;
    /** deck: settings.deck through normaliseDeckOverrides. */
    look?: Record<string, unknown>;
    /** deck: settings.houseStyle !== false. */
    houseStyle?: boolean;
    /** sheet: the tabs with raw and shown values. */
    sheet?: SheetSide;
}

export class NotComparableError extends Error {
    readonly status = 422;
    readonly code = 'documents_not_comparable';
    constructor() {
        super('A spreadsheet can only be compared with another spreadsheet.');
    }
}

function textSource(side: CompareSide): TextSource {
    return familyOf(side.docType) === 'deck' ? { markdown: side.bodyHtml || '' } : { html: side.bodyHtml || '' };
}

export function compareDocuments(left: CompareSide, right: CompareSide): CompareResult {
    const fl = familyOf(left.docType);
    const fr = familyOf(right.docType);
    if (fl === 'sheet' || fr === 'sheet') {
        if (fl !== fr) throw new NotComparableError();
        return compareSheets(left.sheet || { tabs: [] }, right.sheet || { tabs: [] });
    }
    if (fl === 'deck' && fr === 'deck' && left.deck && right.deck) {
        return compareDecks(
            { deck: left.deck, look: left.look || {}, houseStyle: left.houseStyle !== false },
            { deck: right.deck, look: right.look || {}, houseStyle: right.houseStyle !== false },
        );
    }
    return compareText(textSource(left), textSource(right));
}

export { compareDecks, compareSheets, compareText };
