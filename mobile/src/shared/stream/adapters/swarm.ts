/**
 * The swarm events, for direct chat.
 *
 * A `swarm` tier turn short-circuits into an entirely different server runtime
 * that emits NONE of the ordinary chat events — no `content` at all. Without
 * these entries the whole answer renders as an empty bubble.
 */

import { IGNORE, type FrameAdapter, type FrameHandler } from '../chatFrameReducer';
import { str } from '../handlers';
import type { SwarmProgress, TurnBlock } from '../types';

interface SwarmTurn {
    text: string;
    swarm: SwarmProgress | null;
    blocked: TurnBlock | null;
}

const EMPTY_SWARM: SwarmProgress = { phase: null, workers: [], completed: false };

const started: FrameHandler<SwarmTurn> = (turn) => {
    turn.swarm = { ...EMPTY_SWARM, workers: [] };
};

const phaseChanged: FrameHandler<SwarmTurn> = (turn, d) => {
    turn.swarm = {
        ...(turn.swarm ?? { workers: [], completed: false }),
        phase: str(d.phase) || str(d.name) || null,
    };
};

const workerStarted: FrameHandler<SwarmTurn> = (turn, d) => {
    const swarm = turn.swarm ?? { ...EMPTY_SWARM, workers: [] };
    const id = str(d.workerId) || str(d.id) || `worker-${swarm.workers.length}`;
    turn.swarm = {
        ...swarm,
        workers: [...swarm.workers, { id, name: str(d.name) || str(d.role) || id, status: 'running', text: '' }],
    };
};

const workerContent: FrameHandler<SwarmTurn> = (turn, d) => {
    const swarm = turn.swarm;
    if (!swarm) return false;
    const id = str(d.workerId) || str(d.id);
    turn.swarm = {
        ...swarm,
        workers: swarm.workers.map((w) => (w.id === id ? { ...w, text: w.text + str(d.text) } : w)),
    };
};

const workerCompleted: FrameHandler<SwarmTurn> = (turn, d) => {
    const swarm = turn.swarm;
    if (!swarm) return false;
    const id = str(d.workerId) || str(d.id);
    turn.swarm = {
        ...swarm,
        workers: swarm.workers.map((w) => (w.id === id ? { ...w, status: 'done' } : w)),
    };
};

/**
 * The synthesis is the answer. Everything the workers produced was
 * working-out, and stays behind the swarm panel.
 */
const completed: FrameHandler<SwarmTurn> = (turn, d) => {
    if (turn.swarm) turn.swarm = { ...turn.swarm, completed: true };
    if (!turn.text) turn.text = str(d.result) || str(d.content) || turn.text;
};

const clarificationRequired: FrameHandler<SwarmTurn> = (turn, d) => {
    turn.blocked = {
        reason: 'The swarm needs more detail before it can continue.',
        detail: str(d.question) || str(d.message) || undefined,
    };
};

export const SWARM_FRAMES: FrameAdapter<SwarmTurn> = {
    swarm_started: started,
    swarm_phase_started: phaseChanged,
    swarm_phase_completed: phaseChanged,
    swarm_worker_started: workerStarted,
    swarm_worker_content: workerContent,
    swarm_worker_completed: workerCompleted,
    swarm_completed: completed,
    swarm_clarification_required: clarificationRequired,
    swarm_worker_tool: IGNORE,
};
