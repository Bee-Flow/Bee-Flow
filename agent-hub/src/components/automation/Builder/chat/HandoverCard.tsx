import { Check, CircleCheck, FlaskConical, Link2, Plug, Power } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { formShareTabPath, handoverActions, INTEGRATIONS_SETTINGS_PATH } from './handoverActions';
import type { HandoverAction } from './handoverActions';
import useAutomationApi from '@/hooks/useAutomationApi';
import { useTranslation } from '@/hooks/useTranslation';
import type { BuilderFinalized } from '@/hooks/automationBuilder/types';
import type { FlowDefinition } from '../flow/types';

/** What the shell knows about going live: the header's own handlers and state. */
export interface HandoverLifecycle {
    isActive?: boolean;
    busy?: boolean;
    canActivate?: boolean;
    onActivate?: (() => void) | null;
    onDryRun?: ((from: string | null) => void) | null;
}

export interface HandoverCardProps extends HandoverLifecycle {
    finalized: BuilderFinalized;
    definition: FlowDefinition | null;
    /**
     * The form's address (`/f/<token>`) when "Copy the form link" is pressed,
     * or null when it has none yet. Defaults to GET /api/automation/forms/:id;
     * read on the click, not on mount, so a card nobody uses asks nothing.
     */
    readFormPath?: ((automationId: string) => Promise<string | null>) | null;
}

type ShareState = 'idle' | 'busy' | 'copied' | 'no-link' | 'failed';

const ROW = 'flex items-start gap-2 rounded-lg px-2 py-2';
const ACTION = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium disabled:opacity-50';
const PRIMARY = `${ACTION} bg-[var(--text-primary)] text-[var(--bg-primary)]`;
const SECONDARY = `${ACTION} border border-[var(--border-default)] hover:bg-[var(--bg-secondary)]`;
const LINK = 'text-[var(--type-ai)] underline-offset-2 hover:underline';

/** Same-origin absolute paths only: a row is data, and a link elsewhere is not this form. */
function samePath(url: unknown): string | null {
    return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : null;
}

/**
 * The hand-over after the assistant saved an automation (design point 5,
 * F16): "Ready — saved, not switched on yet. To use it:" and the things that
 * stand between saved and of use, each a button or a link: connect an app it
 * uses, Activate, share the form link, run a test. Each is a button here, so
 * the person does not have to find it in the header or elsewhere in the product.
 */
export default function HandoverCard({ finalized, definition, isActive = false, busy = false, canActivate = true, onActivate, onDryRun, readFormPath }: HandoverCardProps) {
    const { t } = useTranslation();
    const actions = handoverActions(definition, finalized.needs, { isActive });
    return (
        <section
            aria-label={t('handover.card.aria', 'What to do next')}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden text-xs"
            data-testid="assistant-handover"
        >
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-default)] font-semibold">
                <CircleCheck size={14} className="flex-shrink-0 text-emerald-500" aria-hidden="true" />
                <span>{isActive
                    ? t('handover.card.title_live', 'Ready and switched on. To use it:')
                    : t('handover.card.title_ready', 'Ready — saved, not switched on yet. To use it:')}</span>
            </div>
            <ul className="p-1.5 space-y-0.5">
                {actions.map((a) => (
                    <li key={a.kind === 'connect' ? `connect:${a.app}` : a.kind}>
                        <ActionRow action={a} automationId={finalized.automationId} isActive={isActive} busy={busy} canActivate={canActivate} onActivate={onActivate} onDryRun={onDryRun} readFormPath={readFormPath} />
                    </li>
                ))}
            </ul>
        </section>
    );
}

interface ActionRowProps extends HandoverLifecycle {
    action: HandoverAction;
    automationId: string;
    readFormPath?: HandoverCardProps['readFormPath'];
}

function Row({ icon, text, hint, children }: { icon: ReactNode; text: ReactNode; hint?: ReactNode; children?: ReactNode }) {
    return (
        <div className={ROW}>
            <span className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block font-medium text-[var(--text-primary)]">{text}</span>
                {hint && <span className="block text-[var(--text-tertiary)]">{hint}</span>}
            </span>
            {children && <span className="flex flex-shrink-0 flex-col items-end gap-1">{children}</span>}
        </div>
    );
}

function ActionRow({ action, automationId, isActive, busy, canActivate, onActivate, onDryRun, readFormPath }: ActionRowProps) {
    const { t } = useTranslation();
    if (action.kind === 'connect') {
        const text = action.label
            ? t('handover.card.connect', 'Connect {app}', { app: action.label })
            : t('handover.card.connect_unnamed', 'Connect the app it uses');
        return (
            <Row icon={<Plug size={13} />} text={text} hint={t('handover.card.connect_hint', 'It uses this app, and the app is not connected for you yet. Connect it under Settings → Connections.')}>
                <a href={INTEGRATIONS_SETTINGS_PATH} target="_blank" rel="noreferrer" className={SECONDARY}>{t('handover.card.connect_open', 'Open Connections')}</a>
            </Row>
        );
    }
    if (action.kind === 'activate') {
        if (action.done) {
            return <Row icon={<Check size={13} className="text-emerald-500" />} text={t('handover.card.active', 'Switched on')} hint={t('handover.card.active_hint', 'It runs by itself from now on.')} />;
        }
        return (
            <Row icon={<Power size={13} />} text={t('handover.card.activate_text', 'Switch it on')} hint={t('handover.card.activate_hint', 'Until then nothing happens by itself.')}>
                <button type="button" disabled={busy || !canActivate || !onActivate} onClick={() => onActivate?.()} className={PRIMARY}>
                    <Power size={12} aria-hidden="true" />{t('handover.card.activate', 'Activate')}
                </button>
            </Row>
        );
    }
    if (action.kind === 'share-form') return <ShareFormRow automationId={automationId} isActive={!!isActive} readFormPath={readFormPath} />;
    return (
        <Row icon={<FlaskConical size={13} />} text={t('handover.card.test_text', 'Try it first')} hint={t('handover.card.test_hint', 'Nothing is sent or written; forms and approvals wait for you.')}>
            <button type="button" disabled={busy || !onDryRun} onClick={() => onDryRun?.(null)} className={SECONDARY}>
                <FlaskConical size={12} aria-hidden="true" />{t('handover.card.test', 'Run a test')}
            </button>
        </Row>
    );
}

/**
 * "Share the form link". The address is read when the button is pressed (the
 * forms API's `url`, `/f/<token>`) and copied whole, with this origin. A form
 * that has no address yet, or a copy the browser refuses, points at the
 * form's Share tab, which makes and copies links and holds the test link.
 */
function ShareFormRow({ automationId, isActive, readFormPath }: { automationId: string; isActive: boolean; readFormPath?: HandoverCardProps['readFormPath'] }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const [state, setState] = useState<ShareState>('idle');
    const read = readFormPath || (async (id: string) => {
        const body = await api.getForm(id) as { form?: { url?: unknown } | null } | null;
        return samePath(body?.form?.url);
    });
    const copy = async () => {
        setState('busy');
        try {
            const path = samePath(await read(automationId));
            if (!path) { setState('no-link'); return; }
            await navigator.clipboard.writeText(`${window.location.origin}${path}`);
            setState('copied');
        } catch {
            setState('failed');
        }
    };
    const tabLink = (text: string) => <a href={formShareTabPath(automationId)} target="_blank" rel="noreferrer" className={LINK}>{text}</a>;
    const shareTab = tabLink(t('handover.card.share_tab', 'Open the form\'s Share tab'));
    let hint: ReactNode = isActive
        ? t('handover.card.share_hint_live', 'Colleagues open it with this link after signing in.')
        : t('handover.card.share_hint_off', 'The link opens for others once it is switched on.');
    if (state === 'no-link') hint = <>{t('handover.card.share_no_link', 'The form has no link yet.')} {shareTab}</>;
    if (state === 'failed') hint = <>{t('handover.card.share_failed', 'The link could not be copied.')} {shareTab}</>;
    return (
        <Row icon={<Link2 size={13} />} text={t('handover.card.share_text', 'Share the form link')} hint={hint}>
            <button type="button" disabled={state === 'busy'} onClick={copy} className={SECONDARY}>
                {state === 'copied' ? <Check size={12} aria-hidden="true" className="text-emerald-500" /> : <Link2 size={12} aria-hidden="true" />}
                {state === 'copied' ? t('handover.card.share_copied', 'Link copied') : t('handover.card.share', 'Copy the form link')}
            </button>
            {state !== 'no-link' && state !== 'failed' && tabLink(t('handover.card.share_settings', 'Who can open it'))}
        </Row>
    );
}
