// @typecheck
/**
 * The browser's credential JSON (what @simplewebauthn/browser returns from a
 * ceremony), as every route that accepts one validates it. Its inner fields
 * are checked by the verifier, which is the only thing qualified to; this
 * schema refuses a body that is plainly not a credential, and caps its size.
 */

const { z } = require('zod');

const credentialJson = z.object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.unknown()),
}).passthrough();

module.exports = { credentialJson };
