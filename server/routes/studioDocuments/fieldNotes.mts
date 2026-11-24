/**
 * Notes people leave each other while they fill in a document together
 * (core/documents/fieldNotes.mts): at a field, or on the document as a whole.
 * Mounted by routes/studioDocuments.js.
 *
 *   POST   /:id/field-notes            { key?, text }   key '' or left out: a note on the whole document
 *   DELETE /:id/field-notes/:noteId    only its writer
 *
 * Both answer as the form's other routes do (templateValues.mts `fillAnswer`).
 *
 * ACCESS. A document the caller may edit (a viewer gets 403, a stranger the
 * 404), and only a plain document, never a template itself. A note is read by
 * everyone who reads the document: it is part of the document's settings.
 *
 * A FACTORY: `makeFieldNotesRouter(deps)`; `fieldNotesRouter` is over the real
 * document store.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response, Router } from 'express';
import { addNote, removeNote, MAX_NOTE } from '../../core/documents/fieldNotes.mts';
import { contractModule, saveSettings, type ContractModule, type Settings, type TemplateDoc, type ValuesStore } from '../../core/documents/templateValues.mts';
import { fillAnswer, storeRefusal, writableDocument } from './templateValues.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { notFound } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');

const NOTE_TEXT = `text is the note, 1 to ${MAX_NOTE} characters.`;
const NoteBody = bodyOf({
    key: z.string({ error: 'key is the key of a field, or empty for a note on the whole document.' }).max(200).optional(),
    text: z.string({ error: NOTE_TEXT }).trim().min(1, NOTE_TEXT).max(MAX_NOTE, NOTE_TEXT),
}, 'Leaving a note');

type Deps = { store?: () => ValuesStore, requireAuth?: RequestHandler, contract?: () => ContractModule };

const userIdOf = (req: Request): string => String((req.session as unknown as { user: { id: string } }).user.id);

/** Save the changed settings; the client's error when the store or a rule refuses. */
async function saveNotes(store: ValuesStore, doc: TemplateDoc, change: () => Settings, userId: string): Promise<TemplateDoc> {
    let saved: TemplateDoc | null;
    try { saved = await saveSettings(store, doc, change(), userId, 'user'); } catch (e) { throw storeRefusal(e); }
    if (!saved) throw notFound('document_not_found', 'Document not found or read-only');
    return saved;
}

export function makeFieldNotesRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): ValuesStore => nodeRequire('../../stores/documentStore.js') as ValuesStore);
    const contract = deps.contract || contractModule;
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.post('/:id/field-notes', requireAuth, validate({ body: NoteBody }), async (req: Request<{ id: string }>, res: Response) => {
        const userId = userIdOf(req);
        const { key, text } = req.body as { key?: string, text: string };
        const doc = await writableDocument(store(), req.params.id, userId);
        const knownKeys = contract().getContract(doc).parameters.map((field) => field.key);
        const saved = await saveNotes(store(), doc, () => addNote({ ...(doc.settings || {}) }, {
            id: randomUUID(), key, userId, text, now: new Date().toISOString(), knownKeys,
        }), userId);
        res.status(201).json(fillAnswer(saved, contract()));
    });

    router.delete('/:id/field-notes/:noteId', requireAuth, async (req: Request<{ id: string, noteId: string }>, res: Response) => {
        const userId = userIdOf(req);
        const doc = await writableDocument(store(), req.params.id, userId);
        const saved = await saveNotes(store(), doc, () => {
            const out = removeNote({ ...(doc.settings || {}) }, req.params.noteId, userId);
            if (!out.removed) throw notFound('field_note_not_found', 'This note does not exist any more.');
            return out.settings;
        }, userId);
        res.json(fillAnswer(saved, contract()));
    });

    return router;
}

export const fieldNotesRouter: Router = makeFieldNotesRouter();
