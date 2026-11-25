/**
 * The reads and writes of a task's set-up (./coworkSetup.mts says what the two columns hold): for the use case
 * usecases/coworkSetup.mts. Each write is one statement on the item's own row.
 */

import { createRequire } from 'node:module';
import type { CoworkDb as Db } from './lib/coworkDb.mts';
import { isSetupState, recordOf, type SetupRecord, type SetupState, type SetupWas } from './coworkSetup.mts';

const nodeRequire = createRequire(import.meta.url);

export function makeCoworkSetup({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** The two columns of one item; null when the item is gone. */
    async function readSetup(scheduleId: string): Promise<{ state: SetupState | null; record: SetupRecord } | null> {
        await ready();
        const row = await db.getOne('SELECT setup_state, setup_json FROM cowork_schedules WHERE id = $1', [scheduleId]);
        return row ? { state: isSetupState(row.setup_state) ? row.setup_state : null, record: recordOf(row.setup_json) } : null;
    }

    async function writeSetup(scheduleId: string, state: SetupState | null, record: SetupRecord): Promise<void> {
        await ready();
        const json = Object.keys(record).length > 0 ? JSON.stringify(record) : null;
        await db.run('UPDATE cowork_schedules SET setup_state = $2, setup_json = $3 WHERE id = $1', [scheduleId, state, json]);
    }

    /** "Let the AI work it out every run": the plan comes off and the task says so, in one statement. */
    async function detachForAi(scheduleId: string, record: SetupRecord): Promise<void> {
        await ready();
        await db.run(
            `UPDATE cowork_schedules SET plan_automation_id = NULL, plan_id = NULL, setup_state = 'ai', setup_json = $2 WHERE id = $1`,
            [scheduleId, JSON.stringify(record)],
        );
    }

    /**
     * Undo of it: the plan the task named and the approval it had come back. The approved plan only when it is still
     * a plan of this very task (cowork_plans keeps every approval).
     */
    async function restoreFromAi(scheduleId: string, was: SetupWas, record: SetupRecord): Promise<void> {
        await ready();
        await db.run(
            `UPDATE cowork_schedules
                SET plan_automation_id = $2,
                    plan_id = (SELECT p.id FROM cowork_plans p WHERE p.id = $3 AND p.schedule_id = $1),
                    setup_state = $4, setup_json = $5
              WHERE id = $1`,
            [scheduleId, was.planAutomationId, was.planId, was.state, Object.keys(record).length > 0 ? JSON.stringify(record) : null],
        );
    }

    return { readSetup, writeSetup, detachForAi, restoreFromAi };
}

export type CoworkSetupStore = ReturnType<typeof makeCoworkSetup>;

let defaultStore: CoworkSetupStore | null = null;

/** The store on the server's pool, after the Cowork schema. */
export function coworkSetup(): CoworkSetupStore {
    if (!defaultStore) {
        defaultStore = makeCoworkSetup({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    }
    return defaultStore;
}
