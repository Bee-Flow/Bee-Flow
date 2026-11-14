/**
 * What POST /api/automation/forms/ai/draft accepts (the handler is
 * routes/automation/formsAi.js draft). Its own light module so
 * routes/automation/forms.js can put the schema on the route itself, where the
 * API reference reads it, without requiring the handler (and with it the LLM
 * client) eagerly.
 *
 *   { mode?, brief?, note?, current? }
 *
 * `mode` was read as `=== 'revise' ? 'revise' : 'create'`, so any other
 * spelling drew a new form over the one on screen; it is one of the two now.
 * `current` stays OPEN on purpose: it is the form as the editor holds it, and
 * formsAi's readCurrent() is the allow-list of the parts the prompt quotes. The
 * schema asks only that it be a document, never a list.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as typeof import('../../core/http/schemaParts.js');

const MODE_TEXT = 'mode is "create" or "revise".';

export const DraftBody = bodyOf({
    mode: z.enum(['create', 'revise'], { error: () => MODE_TEXT }).default('create'),
    brief: z.string({ error: typeError({ invalid: 'brief must be text.' }) }).optional(),
    note: z.string({ error: typeError({ invalid: 'note must be text.' }) }).optional(),
    current: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'current is the form as an object, or null.' }) }).nullish(),
}, 'Drafting a form');
