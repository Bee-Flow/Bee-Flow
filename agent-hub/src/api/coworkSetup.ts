// A task's set-up over PUT /api/cowork/:id/setup (server/usecases/coworkSetup.mts): let the AI work it out every run
// ('ai': its steps come off and it stops waiting for them), or its Undo ('steps': the steps it had, their approval and
// where its set-up stood all come back). A refusal throws with the server's sentence.

import { apiJson } from './typedRequest';
import type { CoworkSetup } from './cowork.types';

export async function chooseCoworkSetup(id: string, mode: 'ai' | 'steps'): Promise<CoworkSetup | null> {
    const body = await apiJson<'PUT /api/cowork/{id}/setup', { setup?: CoworkSetup | null }>('PUT /api/cowork/{id}/setup', { params: { id }, body: { mode } });
    return body.setup ?? null;
}
