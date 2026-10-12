'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { notFound } = require('../../core/http/errors');
const { TYPES, catalogue, searchCatalogue } = require('../../projects/catalogue');
const item = z.object({ type: z.enum(TYPES), id: z.string().min(1).max(200) }).strict();
const query = z.object({ q: z.string().max(200).default(''), type: z.enum(TYPES).optional(), cursor: z.coerce.number().int().min(0).max(10000000).default(0) }).strict();
function makeDiscoveryRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const role = deps.requireProjectRole || lazyProjectRoleGate;
    const changed = async (projectId) => {
        try { await (deps.publish || require('../../core/projectEventBus').publishTransient)(projectId, { kind: 'pins.changed', payload: {} }); } catch { /* next focus refetches */ }
    };
    const pins = () => deps.pins || require('../../stores/projectPinStore');
    const load = async (req) => {
        const project = await (deps.getProject || require('../../stores/projectStore').getProject)(req.params.id);
        if (!project) throw notFound();
        return (deps.catalogue || catalogue)(project, req.session?.user?.id);
    };
    router.get('/:id/search', role('viewer'), validate({ query }), async (req, res) => {
        res.set('Cache-Control', 'no-store').json(searchCatalogue(await load(req), req.query));
    });
    router.get('/:id/pins', role('viewer'), async (req, res) => {
        const [items, saved] = await Promise.all([load(req), pins().list(req.params.id)]);
        // Removed content and lost access never leave stale titles in a pin.
        res.set('Cache-Control', 'no-store').json({ items: saved.flatMap(pin => {
            const found = items.find(item => item.type === pin.type && item.id === pin.id);
            if (!found) return [];
            const { description, ...safe } = found;
            return [safe];
        }) });
    });
    router.put('/:id/pins', role('editor'), validate({ body: item }), async (req, res) => {
        const { type, id } = req.body;
        if (!(await load(req)).some(item => item.type === type && item.id === id)) throw notFound();
        await pins().put(req.params.id, type, id);
        await changed(req.params.id);
        res.json({ ok: true });
    });
    router.delete('/:id/pins/:type/:itemId', role('editor'), validate({ params: z.object({ id: z.string(), type: z.enum(TYPES), itemId: z.string().min(1).max(200) }) }), async (req, res) => {
        await pins().remove(req.params.id, req.params.type, req.params.itemId);
        await changed(req.params.id);
        res.json({ ok: true });
    });
    return router;
}
module.exports = makeDiscoveryRouter();
module.exports.makeDiscoveryRouter = makeDiscoveryRouter;
