/**
 * What the hand-over card offers once the assistant has saved an automation
 * (design point 5, F16): the steps between "saved" and "of use".
 *
 * Derived on the client from the definition, plus the server's `needs` from
 * the finalize result ('activate' | 'share-form' | 'run-once' |
 * 'connect:<app id>'). The client cannot know which apps are connected for
 * this person, so a Connect action only ever comes from `needs`; whether it
 * starts from a form, and whether it is switched on, the client reads itself
 * and does not wait for the server to say so. 'run-once' (a manual trigger:
 * the person starts it) is the test run the card always offers.
 */
import { INTEGRATION_META } from '@/utils/integrationIcons';
import { humanizeToolName } from '../flow/displayHelpers';

export type HandoverAction =
    | { kind: 'connect'; app: string; label: string | null }
    | { kind: 'activate'; done: boolean }
    | { kind: 'share-form' }
    | { kind: 'test' };

interface TriggerLike { kind?: unknown }
interface DefinitionLike { trigger?: TriggerLike | null; triggers?: unknown }

/** Does any trigger of this definition start from a form? */
export function startsFromForm(def: DefinitionLike | null | undefined): boolean {
    const triggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])] as Array<TriggerLike | null | undefined>;
    return triggers.some((tr) => tr?.kind === 'form');
}

/**
 * An app id as a name: "Gmail" for `gmail`. Ids of things that have no
 * catalogue entry of their own (`mcp:<server>`, `custom:<uuid>`) get no
 * invented name: the card then says "the app it uses".
 */
export function appName(id: string): string | null {
    const meta = INTEGRATION_META[id] || INTEGRATION_META[id.replace(/-/g, '_')] || INTEGRATION_META[id.replace(/_/g, '-')];
    if (meta?.label) return meta.label;
    if (id.includes(':')) return null;
    return humanizeToolName(id.replace(/-/g, '_')) || null;
}

/**
 * The card's actions, in the order a person does them: connect what is
 * missing, switch it on, hand out the form, and a test run, which is always
 * there (nothing is sent, so it is never the wrong thing to offer).
 */
export function handoverActions(
    def: DefinitionLike | null | undefined,
    needs: readonly string[] | null | undefined,
    { isActive = false }: { isActive?: boolean } = {},
): HandoverAction[] {
    const asked = new Set(needs || []);
    const out: HandoverAction[] = [];
    const apps = [...asked].filter((n) => n.startsWith('connect:')).map((n) => n.slice('connect:'.length)).filter(Boolean);
    for (const app of apps) out.push({ kind: 'connect', app, label: appName(app) });
    // The server knows which triggers start runs by themselves (a manual one
    // and a building block do not); without its list, offer it anyway.
    if (!needs || asked.has('activate')) out.push({ kind: 'activate', done: isActive });
    if (startsFromForm(def) || asked.has('share-form')) out.push({ kind: 'share-form' });
    out.push({ kind: 'test' });
    return out;
}

/** Studio → Forms → this form's Share tab: its link, who may open it, and the test link. */
export function formShareTabPath(automationId: string): string {
    return `/app/studio/forms/${encodeURIComponent(automationId)}/share`;
}

/** Settings → Connections, where an app is connected. */
export const INTEGRATIONS_SETTINGS_PATH = '/app/settings/integrations';
