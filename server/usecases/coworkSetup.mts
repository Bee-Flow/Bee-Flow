/**
 * A task's set-up, from the routes' side (routes/cowork.js, routes/coworkSetupRoutes.js, routes/coworkPlannerRoutes.js,
 * which checked the task is the caller's). The columns are stores/coworkSetup.mts (read and written through
 * stores/coworkSetupStore.mts), the rules core/cowork/taskSetup.mts.
 *
 *   START    A new task brings what its owner chose on the confirmation: fixed steps or not, who it sends to, and
 *            whether they see each message first. A task that is to get steps waits for them (it does not start by
 *            itself) when its owner can have steps at all; "see each message first" becomes its level of independence
 *            at once (asks_before_sending) where the owner's licence lets a task ask.
 *   MAKING   The planner says when a set-up starts and how it ended. One that failed, or that its owner left, leaves
 *            the task waiting with the class of what went wrong: Cowork never switches it to "the AI does it" itself.
 *            A task that ran with the AI already (nobody set it up as a steps task) stays as it ran.
 *   CHOOSE   "Let the AI work it out every run" takes the plan off and remembers what it took, so Undo ("steps") puts
 *            back exactly that: the plan it named, the approval it had, and where its set-up stood.
 */

import { createRequire } from 'node:module';
import { mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { causeOf, recipientsOf } from '../core/cowork/taskSetup.mts';
import { setupViewOf, type SetupRecord, type SetupState, type TaskSetup } from '../stores/coworkSetup.mts';
import type { CoworkSetupStore } from '../stores/coworkSetupStore.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; planAutomationId?: string | null; planId?: string | null }
interface Owner { userId: string; organizationId: string | null }

/** What the confirmation sends with a new task (routes/coworkSchemas.js `setup`). */
export interface ChosenSetup { steps?: boolean; sendsTo?: string[]; askFirst?: boolean }

export interface SetupDeps {
    store: Pick<CoworkSetupStore, 'readSetup' | 'writeSetup' | 'detachForAi' | 'restoreFromAi'>;
    setIndependence: (scheduleId: string, level: string | null) => Promise<void>;
    mayAsk: MayAsk;
    /** Fixed steps run on the automation engine: is it there for this owner? */
    stepsAvailable: (owner: Owner) => Promise<boolean>;
    now: () => Date;
}

export function setupDeps(): SetupDeps {
    return {
        store: (nodeRequire('../stores/coworkSetupStore.mts') as typeof import('../stores/coworkSetupStore.mts')).coworkSetup(),
        setIndependence: (id, level) => (nodeRequire('../stores/coworkStore.js') as { setIndependence: SetupDeps['setIndependence'] }).setIndependence(id, level),
        mayAsk: mayAskByLicence,
        stepsAvailable: async (owner) => {
            const { isModuleActive } = nodeRequire('../modules') as { isModuleActive: (id: string) => Promise<boolean> };
            const { ownerRefusal } = nodeRequire('../core/automationRunner/ownerGate.mts') as typeof import('../core/automationRunner/ownerGate.mts');
            return await isModuleActive('automation') && await ownerRefusal(owner) === null;
        },
        now: () => new Date(),
    };
}

const view = (state: SetupState | null, record: SetupRecord): TaskSetup | null => setupViewOf(state, Object.keys(record).length > 0 ? JSON.stringify(record) : null);

/** A new task: keep what its owner chose. Answers the set-up as stored; null when nothing was chosen. */
export async function startSetup({ item, chosen, organizationId = null }: { item: Item; chosen: ChosenSetup | null | undefined; organizationId?: string | null }, deps: SetupDeps = setupDeps()): Promise<TaskSetup | null> {
    if (!chosen) return null;
    const owner = { userId: item.userId, organizationId };
    const record: SetupRecord = {};
    if (Array.isArray(chosen.sendsTo)) record.sendsTo = recipientsOf(chosen.sendsTo);
    if (typeof chosen.askFirst === 'boolean') record.askFirst = chosen.askFirst;
    const wanted = chosen.steps === true && await deps.stepsAvailable(owner).catch(() => false);
    if (wanted) record.since = deps.now().toISOString();
    await deps.store.writeSetup(item.id, wanted ? 'wanted' : null, record);
    // The wish is the task's level from its first run on; where a task cannot ask at all there is no level to set.
    if (chosen.askFirst === true && await deps.mayAsk(owner).catch(() => false)) await deps.setIndependence(item.id, 'asks_before_sending');
    return view(wanted ? 'wanted' : null, record);
}

/** A set-up starts (again) for a task that waits for its steps. Any other task is left as it runs. */
export async function setupStarted(item: Item, deps: SetupDeps = setupDeps()): Promise<void> {
    const at = await deps.store.readSetup(item.id);
    if (!at || (at.state !== 'wanted' && at.state !== 'failed')) return;
    const { cause: _cause, was: _was, ...kept } = at.record;
    await deps.store.writeSetup(item.id, 'wanted', { ...kept, since: deps.now().toISOString() });
}

/**
 * A set-up ended without steps (`err`), or its caller left (`left`): a task that waits for its steps says why, as a
 * class. One that got a plan meanwhile, and one nobody set up as a steps task, are left alone.
 */
export async function setupFailed({ item, err, left = false }: { item: Item; err: unknown; left?: boolean }, deps: SetupDeps = setupDeps()): Promise<void> {
    if (item.planAutomationId) return;
    const at = await deps.store.readSetup(item.id);
    if (!at || (at.state !== 'wanted' && at.state !== 'failed')) return;
    await deps.store.writeSetup(item.id, 'failed', { ...at.record, cause: causeOf(err, left) });
}

const refused = (message: string) => new HttpError(409, 'cowork_setup_refused', message);

/** "Let the AI work it out every run", remembering what comes off. */
async function chooseAi(item: Item, deps: SetupDeps): Promise<TaskSetup | null> {
    const at = await deps.store.readSetup(item.id);
    if (!at) throw new HttpError(404, 'cowork_refused', 'Not found');
    if (at.state === 'ai' && !item.planAutomationId) return view('ai', at.record);
    const { cause, was: _was, ...kept } = at.record;
    const record: SetupRecord = { ...kept, was: { state: at.state, cause: cause ?? null, planAutomationId: item.planAutomationId ?? null, planId: item.planId ?? null } };
    await deps.store.detachForAi(item.id, record);
    return view('ai', record);
}

/** Undo of it: back to the steps the task had, and to waiting for them where it waited. */
async function backToSteps(item: Item, deps: SetupDeps): Promise<TaskSetup | null> {
    const at = await deps.store.readSetup(item.id);
    if (!at) throw new HttpError(404, 'cowork_refused', 'Not found');
    const was = at.record.was;
    if (at.state !== 'ai' || !was) throw refused('There is nothing to undo: this task was not switched to the AI from its steps.');
    if (item.planAutomationId) throw refused('This task has steps again already.');
    const { was: _was, ...kept } = at.record;
    const record: SetupRecord = { ...kept, ...(was.cause ? { cause: was.cause } : {}) };
    await deps.store.restoreFromAi(item.id, was, record);
    return view(was.state, record);
}

/** The owner's choice between the AI working it out every run ('ai') and the steps it had ('steps', its Undo). */
export function chooseMode({ item, mode }: { item: Item; mode: 'ai' | 'steps' }, deps: SetupDeps = setupDeps()): Promise<TaskSetup | null> {
    return mode === 'ai' ? chooseAi(item, deps) : backToSteps(item, deps);
}
