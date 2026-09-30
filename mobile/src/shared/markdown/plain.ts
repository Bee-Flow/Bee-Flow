/**
 * Markdown to its plain words, for a line with room for no formatting at all
 * — a step card's one-line summary, a canvas node — where `**Trigger:**`
 * should read "Trigger:", not show its asterisks. Lists and blocks join with
 * spaces; a link keeps its words, a picture its description.
 *
 * Only the first `max` characters are read: the line shows a few dozen, and a
 * long prompt should not be lexed in full on every canvas frame.
 */

import type { Token, Tokens } from 'marked';

import { decodeEntities } from './parse/entities';
import { lexBlock } from './parse/lexer';
import { plainText } from './render/inline';

function wordsOf(tokens: readonly Token[]): string[] {
    return tokens.flatMap((token): string[] => {
        switch (token.type) {
            case 'space':
            case 'hr':
                return [];
            case 'list':
                return (token as Tokens.List).items.flatMap((item) => wordsOf(item.tokens));
            case 'blockquote':
                return wordsOf((token as Tokens.Blockquote).tokens);
            case 'code':
                return [(token as Tokens.Code).text];
            case 'table': {
                const table = token as Tokens.Table;
                return [table.header, ...table.rows].map((row) => row.map((cell) => plainText(cell.tokens)).join(' · '));
            }
            default: {
                const inner = (token as { tokens?: Token[] }).tokens;
                return [inner ? plainText(inner) : decodeEntities((token as { text?: string }).text ?? token.raw)];
            }
        }
    });
}

export function plainMarkdown(value: string, max = 400): string {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- one character class with no quantifier: a single linear scan
    if (!/[*_`#[\]<>|~\\!&]/.test(value)) return value;
    return wordsOf(lexBlock(value.slice(0, max)))
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ');
}
