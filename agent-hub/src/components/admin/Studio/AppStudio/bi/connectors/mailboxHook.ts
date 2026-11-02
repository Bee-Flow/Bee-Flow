/**
 * The "when new mail arrives" setting of a mailbox connector: which app action runs for each
 * new conversation or incoming message (server/appStudio/mailboxNewRecordHook.mts).
 *
 * The server holds the full rule (mailboxHookPolicy.mts: only steps that run without a person)
 * and checks it when the app is published and before every run. The editor mirrors the one
 * refusal an author is most likely to hit, send_email, so the action can be left out of the
 * list before it fails later.
 */

/** The action as far as the picker reads it. */
export interface HookAction {
    kind?: string;
    steps?: unknown[];
    then?: unknown[];
    else?: unknown[];
    cases?: Array<{ steps?: unknown[] } | null>;
    default?: unknown[];
    [key: string]: unknown;
}

export interface HookActionOption {
    id: string;
    /** The step kinds, in order, so `act_x1y2` says what it does. */
    summary: string;
    /** The action holds a send_email step (anywhere), which no hook may run. */
    blocked: boolean;
}

const stepsOf = (action: HookAction | null | undefined): HookAction[] => {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? (action.steps as HookAction[]) : [];
    return [action];
};

function* walk(list: unknown): Generator<HookAction> {
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const step = raw as HookAction;
        yield step;
        yield* walk(step.then);
        yield* walk(step.else);
        yield* walk(step.steps);
        for (const c of Array.isArray(step.cases) ? step.cases : []) yield* walk(c?.steps);
        yield* walk(step.default);
    }
}

/** The actions of the app as picker options, in id order. */
export function hookActionOptions(actions: Record<string, HookAction> | null | undefined): HookActionOption[] {
    return Object.entries(actions || {})
        .map(([id, action]) => {
            const all = [...walk(stepsOf(action))];
            return {
                id,
                summary: stepsOf(action).map((s) => String(s.kind || '?')).join(', '),
                blocked: all.some((s) => s.kind === 'send_email'),
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}
