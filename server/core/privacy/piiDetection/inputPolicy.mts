/**
 * The decisions of the input gate (validateInputForPii in ./validate.js) that
 * need no I/O: whether the gate is on, which action and failure policy apply,
 * which text of the batch is the user's, and whether a degradation touches
 * the categories this caller asked for.
 */

export type GateConfig = {
    piiDetectionEnabled?: boolean;
    piiDetectionAction?: string;
    piiFailureMode?: string;
};

export type ShieldConfig = {
    enabled?: boolean;
    piiDetectionAction?: string;
    piiFailureMode?: string;
};

export type InputPolicy = {
    enabled: boolean;
    action: string;
    failureMode: string;
    guardRequired: boolean;
};

export type GateMessage = {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }> | null;
};

/**
 * The gate's policy for one call.
 *
 * On when any of: the global AI config flag (admin, /ai/config), the agent's
 * own flag, or the org Privacy Shield's `enabled` switch (the one a
 * non-developer uses).
 *
 * The action: a per-call override first (a trusted internal flow; the support
 * auto-responder passes 'allow', since a reply is first-party processing of
 * the customer's OWN e-mail), then the shield, then the AI config, then block.
 *
 * The failure policy when detection cannot fully run: the shield, then the AI
 * config, then fail_closed, so unmasked text never goes to the LLM silently.
 *
 * `guardRequired`: whether a guard that is not installed at all is a refusal.
 * With the shield on the org asked for every message to be scanned, and under
 * fail_closed "no detector" is as degraded as an unreachable one (the DLP
 * runner treats it that way too). The global flag alone, with the mode left
 * unset, means the feature is simply off while no guard is installed.
 */
export function inputPolicy(aiConfig: GateConfig, agentPiiEnabled: boolean, shield: ShieldConfig | null, overrideAction: string | null): InputPolicy {
    const enabled = !!(aiConfig.piiDetectionEnabled || agentPiiEnabled || !!shield?.enabled);
    const action = overrideAction || shield?.piiDetectionAction || aiConfig.piiDetectionAction || 'block';
    const failureMode = shield?.piiFailureMode || aiConfig.piiFailureMode || 'fail_closed';
    const guardRequired = (!!shield?.enabled && failureMode === 'fail_closed') || aiConfig.piiFailureMode === 'fail_closed';
    return { enabled, action, failureMode, guardRequired };
}

/**
 * The text a person typed in the last user message of the batch, or
 * `found: false` when the batch has no user message.
 *
 * A user message is one text block plus attachments: the attachment pipeline
 * appends extracted text to that first block (agentRuntime/attachmentKinds.js
 * appendTextPart, after its own scan) and only pushes a new block when there
 * is none, so the first text block IS the user-authored text. Later blocks
 * are images and the hydrator's "[previously attached]" placeholders.
 */
export function lastUserText(messages: GateMessage[]): { found: boolean; text: string | null | undefined } {
    const last = messages.slice().reverse().find((m) => m.role === 'user');
    if (!last) return { found: false, text: undefined };
    const raw = last.content;
    if (Array.isArray(raw)) {
        const textBlock = raw.find((b) => b.type === 'text');
        return { found: true, text: textBlock ? textBlock.text : '' };
    }
    return { found: true, text: raw };
}

/**
 * True when a degraded scan lost only categories this caller did not ask
 * for, so its answer can still be used.
 *
 * The guard names the categories that lost coverage when it can (a label
 * group whose every inference call raised). Without this an org scoped to
 * {Email, PhoneNumber} would be blocked because the government-id group
 * failed, for a category it never asked about. An absent list (the guard
 * client turns an empty one into null) means "unknown, assume all" (an older guard, or an oversize partial scan whose
 * unscanned tail can hide anything), and an all-categories scope is never
 * exempted.
 */
export function degradedOutsideScope(affected: string[] | null | undefined, enabledCategories: string[] | null | undefined): boolean {
    const requested = Array.isArray(enabledCategories) && enabledCategories.length ? enabledCategories : null;
    return !!(affected && requested && !affected.some((c) => requested.includes(c)));
}
