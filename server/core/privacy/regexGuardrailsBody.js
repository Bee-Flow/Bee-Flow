// @typecheck strict
'use strict';
/**
 * The guardrail rule set (`regexGuardrails: { rules: [{ id, name, pattern }],
 * collections }`) as a request body part. Its shape is checked where it is
 * saved (aiAgent.saveAIConfig), but every rule's pattern must run the way the
 * guardrails run it (core/text/userPattern.js: RE2, or the guarded native
 * fallback), so a pattern the engine refuses is refused here, by rule name,
 * before anything is written.
 */

const { z } = require('../../utils/zod');
const { firstUnusableRule } = require('./guardrails');

const RegexGuardrailsBody = z.unknown().superRefine((value, ctx) => {
    const bad = firstUnusableRule(value);
    if (bad) ctx.addIssue({ code: 'custom', message: `Guardrail rule "${bad.name}": ${bad.message}` });
}).optional();

module.exports = { RegexGuardrailsBody };
