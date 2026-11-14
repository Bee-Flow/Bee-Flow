/**
 * What POST /api/datatables/ai/draft accepts (the handler is
 * routes/datatablesAi.js draft, which explains each field). Its own light
 * module so routes/datatables/index.js can put the schema on the route itself,
 * where the API reference reads it, without requiring the handler (and with it
 * the LLM client) eagerly.
 *
 *   { mode?, brief?, note?, current?, allowDestructive? }
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../utils/zod.js') as typeof import('../utils/zod.js');
const { bodyOf, choice } = nodeRequire('../core/http/schemaParts.js') as typeof import('../core/http/schemaParts.js');
const { MAX_BRIEF_CHARS, MAX_NOTE_CHARS } = nodeRequire('../core/dataEngine/dataModel/datatableDraft.js') as { MAX_BRIEF_CHARS: number, MAX_NOTE_CHARS: number };

const NOTE_TEXT = `A change request is at most ${MAX_NOTE_CHARS} characters — shorten it, or split it into two.`;
const BRIEF_TEXT = `A table description is at most ${MAX_BRIEF_CHARS} characters — shorten it, or leave out what the columns do not need.`;

export const DraftBody = bodyOf({
    mode: choice(['create', 'revise'], 'mode is "create" or "revise".').prefault('create'),
    // Capped, not cut: the model is only ever sent this much of either.
    brief: z.string({ error: typeError({ invalid: 'brief must be text.' }) }).trim().max(MAX_BRIEF_CHARS, BRIEF_TEXT).nullish(),
    note: z.string({ error: typeError({ invalid: 'note must be text.' }) }).trim().max(MAX_NOTE_CHARS, NOTE_TEXT).nullish(),
    current: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'current is the table as the designer holds it.' }) }).nullish(),
    allowDestructive: z.boolean({ error: typeError({ invalid: 'allowDestructive is true or false.' }) }).optional(),
}, 'Drafting a table');
