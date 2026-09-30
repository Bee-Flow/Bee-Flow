/**
 * What "New document" sends for a choice in the gallery (the web's
 * DocumentsPage `create`): a blank page, a blank presentation, or a starter,
 * in the library view the person is in — except that a presentation is never
 * a reusable section.
 */

import type { DocKind, DocumentStarter } from './types';

export type StarterChoice = { blank: 'page' | 'deck' } | { starter: DocumentStarter };

export interface CreateRequest {
    name: string;
    kind: DocKind;
    locale: string;
    starterId?: string;
    blankDeck?: boolean;
}

export function createRequestFor(
    choice: StarterChoice,
    view: { kind: DocKind; locale: string },
    names: { page: string; deck: string },
): CreateRequest {
    const blankDeck = 'blank' in choice && choice.blank === 'deck';
    const starter = 'starter' in choice ? choice.starter : null;
    const deck = blankDeck || starter?.docType === 'presentation';
    return {
        name: blankDeck ? names.deck : (starter?.name || names.page),
        kind: deck && view.kind === 'section' ? 'document' : view.kind,
        locale: view.locale,
        ...(starter ? { starterId: starter.id } : {}),
        ...(blankDeck ? { blankDeck: true } : {}),
    };
}
