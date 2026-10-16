/**
 * The one-time notice before somebody's first run of an automation that uses
 * THEIR OWN connections (runPolicy.connections = 'caller'). The server holds the
 * first run with 409 `caller_notice_required`; this reads which apps it will act
 * in, asks the person once, remembers the answer on the server and starts the run
 * again. Declining starts nothing.
 */

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

export interface CallerNoticeApi<T = unknown> {
    run: (id: string, body?: unknown) => Promise<T>;
    getCallerNotice: (id: string) => Promise<{ applies: boolean; seen: boolean; providers: string[]; destinations: string[]; items: string[] }>;
    ackCallerNotice: (id: string, items: string[]) => Promise<unknown>;
}

export type CallerNoticeConfirm = (opts: { title: string; description: string; confirmLabel: string }) => Promise<unknown>;

/** The sentence for one owner-controlled place the run writes to. */
function destinationText(key: string, t: Translate): string {
    switch (key) {
        case 'knowledge_base': return t('automations.caller_notice.dest_knowledge_base', 'the owner\'s knowledge base');
        case 'tables': return t('automations.caller_notice.dest_tables', 'tables the owner holds');
        case 'document_library': return t('automations.caller_notice.dest_document_library', 'copies in the owner\'s document library');
        case 'generated_files': return t('automations.caller_notice.dest_generated_files', 'files kept under the owner\'s account');
        default: return key;
    }
}

/** What a failed `run` call carries: the server's refusal code. */
function isNoticeRequired(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'caller_notice_required';
}

/** Start the run; on the one-time notice, show it, remember the answer and retry once. `null` = the person declined. */
export async function runWithCallerNotice<T = unknown>(
    api: CallerNoticeApi<T>,
    automationId: string,
    body: unknown,
    confirm: CallerNoticeConfirm,
    t: Translate,
): Promise<{ declined: true; result: null } | { declined: false; result: T }> {
    try {
        return { declined: false, result: await api.run(automationId, body) };
    } catch (e) {
        if (!isNoticeRequired(e)) throw e;
    }
    const notice = await api.getCallerNotice(automationId);
    const places = notice.destinations.map((d) => destinationText(d, t)).join('; ');
    const apps = notice.providers.length ? notice.providers.join(', ') : t('automations.caller_notice.no_apps', 'your connected apps');
    const ok = await confirm({
        title: t('automations.caller_notice.title', 'This automation runs with your own connections'),
        description: t('automations.caller_notice.description', 'It will act in your own accounts ({apps}), not in the owner\'s. If an app is not connected yet, the run stops before it starts.', { apps })
            + (places ? ` ${t('automations.caller_notice.destinations', 'It also writes to places the owner controls and can read: {places}.', { places })}` : ''),
        confirmLabel: t('automations.caller_notice.confirm', 'Understood, run it'),
    });
    if (!ok) return { declined: true, result: null };
    await api.ackCallerNotice(automationId, notice.items);
    return { declined: false, result: await api.run(automationId, body) };
}
