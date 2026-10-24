/**
 * Links the web draws as cards rather than as words: a webpage or a Studio
 * document the model just built (it is told to end its reply with
 * `[<name>](<url>)`). The patterns are the web's own, from MarkdownRenderer's
 * `a` component, run from the generated copy of markdownRules.ts.
 */

import { DOCUMENT_CARD, WEBPAGE_CARD } from '@/shared/markdown/mirror/markdownRules';

export { DOCUMENT_CARD, WEBPAGE_CARD };

export type LinkCardKind = 'webpage' | 'document';

export function linkCardKind(href: string): LinkCardKind | null {
    if (WEBPAGE_CARD.test(href)) return 'webpage';
    if (DOCUMENT_CARD.test(href)) return 'document';
    return null;
}
