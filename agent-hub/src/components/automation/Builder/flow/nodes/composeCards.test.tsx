import { render, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { STEP_SITES } from '@shared/mapping/index.mjs';
import { NODE_TYPES } from '../nodeTypes';

/**
 * Regression: a text with a value in it is a compose OBJECT (the editor
 * writes one as soon as a value goes into a message, a URL, a title...), and
 * a card that read it as a string crashed the canvas ("Objects are not valid
 * as a React child", Stop with error) or said "[object Object]" (HTTP
 * request, document file names) or "no message yet" (notification,
 * approval).
 *
 * The sweep puts a compose in every text the sites table says takes one, for
 * every step type that has a card, and renders the card: no crash, no
 * "[object Object]" anywhere (text or tooltip). The cards that show the text
 * show it with the value by its name.
 */

const COMPOSE = {
    kind: 'compose', v: 1,
    parts: ['Hallo ', { from: { root: 'trigger', path: ['customer', 'name'] }, take: 'one', as: 'text', label: 'Naam' }],
};
const SHOWN = 'Hallo ‹Naam›';

// What a card needs beyond its texts before it says anything about them.
type Step = Record<string, unknown> & { id: string; type: string };
type Site = { field: string; compose: boolean; each: boolean };
type Card = React.ComponentType<{ id: string; data: Record<string, unknown> }>;

const SITES = STEP_SITES as unknown as Record<string, { text?: readonly Site[] }>;
const CARDS = NODE_TYPES as unknown as Record<string, Card | undefined>;

const BASE: Record<string, Record<string, unknown>> = {
    fill_document: { documentId: 'doc_1' },
    knowledge_write: { knowledgeBaseId: 'kb_1' },
    presentation: { slides: '{{steps.ai.output.text}}' },
};

// The cards whose line shows the composed text (the others show their config).
const SHOWS: Record<string, string> = {
    stop_error: 'message', notification: 'body', http_request: 'url', approval: 'prompt',
    generate_document: 'fileName', presentation: 'fileName', slide: 'title', fill_document: 'fileName',
};

function setAt(target: Record<string, unknown>, field: string, value: unknown) {
    const keys = field.split('.');
    let cur = target;
    for (const key of keys.slice(0, -1)) {
        const next = cur[key];
        cur = (cur[key] = next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
    }
    cur[keys[keys.length - 1]] = value;
}

function stepWithComposes(type: string): Step {
    const step: Step = { id: `${type}_1`, type, label: 'Kaart', ...structuredClone(BASE[type] || {}) };
    for (const site of SITES[type].text || []) {
        if (!site.compose) continue;
        setAt(step, site.each ? `${site.field}.veld` : site.field, structuredClone(COMPOSE));
    }
    return step;
}

const TYPES = Object.keys(SITES).filter(type => CARDS[type] && (SITES[type].text || []).some(s => s.compose));

afterEach(cleanup);

describe('every card with a composed text', () => {
    it('covers the step types the sites table gives a composed text', () => {
        expect(TYPES).toEqual(expect.arrayContaining(Object.keys(SHOWS)));
    });

    it.each(TYPES)('%s renders it as text, never as an object', (type) => {
        const Card = CARDS[type]!;
        const step = stepWithComposes(type);
        const { container } = render(
            <ReactFlowProvider>
                <Card id={step.id} data={{ step, runStep: null, issues: { errors: [], warnings: [] }, stepLabelById: new Map(), kbNameById: {} }} />
            </ReactFlowProvider>,
        );
        expect(container.innerHTML).not.toContain('[object Object]');
        if (SHOWS[type]) expect(container.textContent).toContain(SHOWN);
    });
});
