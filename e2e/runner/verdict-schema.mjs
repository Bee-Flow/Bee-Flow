/**
 * The report_verdict tool contract shared by the agentic runner and the
 * orchestrator. The verdict arrives as validated tool input (structured
 * JSON), never scraped from prose.
 */

export const VERDICT_TOOL = {
  name: 'report_verdict',
  description:
    'REQUIRED terminal call — report the final verdict for the scenario. ' +
    'Call exactly once, as your last action, after cleanup. verdict must be ' +
    '"pass" only when every Expected outcome was actually observed.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      summary: { type: 'string', description: 'One-paragraph outcome summary.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            instruction: { type: 'string' },
            status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
            detail: { type: 'string' },
          },
          required: ['index', 'instruction', 'status', 'detail'],
          additionalProperties: false,
        },
      },
      failed_step: {
        type: ['integer', 'null'],
        description: 'Index of the first failed step, or null when verdict is pass.',
      },
      reasoning: { type: 'string' },
    },
    required: ['verdict', 'summary', 'steps', 'failed_step', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * Local validation — deliberately not relying on API-side strict mode so the
 * harness works with any @anthropic-ai/sdk version.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateVerdict(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['verdict input must be an object'] };
  }
  if (!['pass', 'fail'].includes(input.verdict)) errors.push("verdict must be 'pass' or 'fail'");
  if (typeof input.summary !== 'string' || !input.summary.trim()) errors.push('summary must be a non-empty string');
  if (typeof input.reasoning !== 'string') errors.push('reasoning must be a string');
  if (!(input.failed_step === null || Number.isInteger(input.failed_step))) {
    errors.push('failed_step must be an integer or null');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    input.steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') return errors.push(`steps[${i}] must be an object`);
      if (!Number.isInteger(s.index)) errors.push(`steps[${i}].index must be an integer`);
      if (typeof s.instruction !== 'string') errors.push(`steps[${i}].instruction must be a string`);
      if (!['passed', 'failed', 'skipped'].includes(s.status)) {
        errors.push(`steps[${i}].status must be passed|failed|skipped`);
      }
      if (typeof s.detail !== 'string') errors.push(`steps[${i}].detail must be a string`);
    });
  }
  if (input.verdict === 'pass' && Array.isArray(input.steps) && input.steps.some((s) => s?.status === 'failed')) {
    errors.push("verdict is 'pass' but a step is marked failed");
  }
  return { ok: errors.length === 0, errors };
}

/** Verdict synthesized when the loop ends without a report_verdict call. */
export function synthesizedFailure(reason) {
  return {
    verdict: 'fail',
    summary: `The agent never reported a verdict: ${reason}`,
    steps: [{ index: 0, instruction: '(run aborted)', status: 'failed', detail: reason }],
    failed_step: 0,
    reasoning: reason,
    synthesized: true,
  };
}
