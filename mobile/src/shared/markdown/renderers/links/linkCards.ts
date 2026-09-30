/**
 * Links the web draws as cards rather than as words: a webpage or a Studio
 * document the model just built (it is told to end its reply with
 * `[<name>](<url>)`). The patterns are the web's own, from MarkdownRenderer's
 * `a` component; linkCards.test.ts holds them to it.
 */

export type LinkCardKind = 'webpage' | 'document';

export const WEBPAGE_CARD = /^\/app\/(?:studio\/)?webpages\/[a-zA-Z0-9_-]+$/;
export const DOCUMENT_CARD = /^\/app\/studio\/documents\/[a-zA-Z0-9_-]+$/;

export function linkCardKind(href: string): LinkCardKind | null {
    if (WEBPAGE_CARD.test(href)) return 'webpage';
    if (DOCUMENT_CARD.test(href)) return 'document';
    return null;
}
