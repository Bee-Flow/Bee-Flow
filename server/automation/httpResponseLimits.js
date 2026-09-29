/**
 * Shared ceiling for an outbound HTTP response body (character count of the
 * decoded text — called a "1 MiB" cap throughout, though it is really a
 * character count rather than a byte count).
 *
 * Two surfaces fetch an outbound HTTP response and both must cap its size,
 * but they sit on different sides of a trust boundary and so react to
 * hitting the cap differently:
 *
 *   - core/automationRunner/execOutbound.js's execHttpRequest — the
 *     declarative `http_request` step. A response over this cap THROWS
 *     (BFSF-436): a truncated body is invalid JSON by construction, and
 *     handing that back under an ordinary `success` status — with the
 *     documented "add a Parse JSON step" workaround unable to do anything
 *     with it — is worse than a clear, actionable failure.
 *   - automation/codeSandbox.js's defaultFetchHttp — the code step's own
 *     `ctx.http()` bridge (and, transitively,
 *     integrations/webpageApiRuntime.js's fetchHttp, which forwards to it
 *     unchanged). That surface hands the response to code the user wrote
 *     themselves, a different trust boundary than a declarative step
 *     silently discarding the cut — it keeps returning
 *     `{ truncated: true }` to the caller's own code instead of throwing.
 *
 * Before this module existed, both surfaces independently defined their own
 * `1024 * 1024` and stayed in sync only by a comment saying so. One
 * constant means they cannot drift apart again.
 */
'use strict';

const HTTP_RESPONSE_CAP = 1024 * 1024;

module.exports = { HTTP_RESPONSE_CAP };
