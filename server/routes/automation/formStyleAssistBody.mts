/**
 * What POST /api/automation/:id/forms/style-assist accepts (the handler is
 * routes/automation/formsAi.js styleAssist). Its own light module so
 * routes/automation/forms.js can put the schema on the route itself, where the
 * API reference reads it, without requiring the handler (and with it the LLM
 * client) eagerly.
 *
 *   { prompt, triggerStepId?, style?, theme?, customCss? }
 *
 * `style`, `theme` and `customCss` are the editor's UNSAVED values; left out,
 * the saved form's are used. `style` and `theme` stay open documents: the
 * prompt quotes them only after canonicalising (core/forms/formStyle.mts,
 * core/cms/themeSpec.js), which is the allow-list.
 */

import { createRequire } from 'node:module';
import { FORM_CSS_MAX_CHARS } from '../../core/forms/formStyle.mts';
import { STYLE_PROMPT_MAX_CHARS } from '../../core/forms/formStyleAssist.mts';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { bodyOf, worded } = nodeRequire('../../core/http/schemaParts.js') as typeof import('../../core/http/schemaParts.js');

const PROMPT_TEXT = `prompt describes the look in words (1 to ${STYLE_PROMPT_MAX_CHARS} characters).`;
const TRIGGER_TEXT = 'triggerStepId is the id of a form trigger on this automation.';
const CSS_TEXT = `customCss is at most ${FORM_CSS_MAX_CHARS} characters, or null.`;

export const StyleAssistBody = bodyOf({
    prompt: worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT).max(STYLE_PROMPT_MAX_CHARS, PROMPT_TEXT),
    triggerStepId: worded(TRIGGER_TEXT).trim().min(1, TRIGGER_TEXT).max(200, TRIGGER_TEXT).nullish(),
    style: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'style is an object of style settings, or null.' }) }).nullish(),
    theme: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'theme is an object of theme settings, or null.' }) }).nullish(),
    customCss: worded(CSS_TEXT).max(FORM_CSS_MAX_CHARS, CSS_TEXT).nullish(),
}, 'Asking for a form style');
