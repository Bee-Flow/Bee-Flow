/**
 * The definition a new automation starts from — the web's createAutomationDraft
 * and createFormAutomation (agent-hub/src/components/admin/Studio/
 * studioApps.jsx), pinned by seed.lockstep.test.ts: a graph shaped like the
 * server's emptyDefinition with a manual trigger, or a form trigger carrying
 * the default form. A form IS an automation with a form trigger; its pages after
 * the first are form_page steps in the same automation.
 */

import { defaultFormDeclaration } from '../model/formDefaults';
import type { FlowDefinition, FlowTrigger } from '../model/types';

export type NewFlowKind = 'manual' | 'form';

export interface NewFlowOptions {
    /** A form's title (the automation takes the same name). */
    title?: string | null;
    /** Collect the answers in a table, made by the server on the first save. */
    collect?: boolean;
}

function formTrigger({ title, collect }: NewFlowOptions): FlowTrigger {
    const form = defaultFormDeclaration();
    return {
        id: 'trg',
        type: 'trigger',
        kind: 'form',
        form: { ...form, title: title || form.title, ...(collect ? { collect: true } : {}) },
        output: {},
    };
}

export function newFlowSeed(kind: NewFlowKind = 'manual', options: NewFlowOptions = {}): FlowDefinition {
    const trigger: FlowTrigger = kind === 'form' ? formTrigger(options) : { id: 'trg', type: 'trigger', kind: 'manual', output: {} };
    return { schemaVersion: 1, trigger, steps: [], edges: [], vars: {} };
}
