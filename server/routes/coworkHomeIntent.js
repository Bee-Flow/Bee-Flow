// @typecheck strict
const { z, bodyOf } = require('../core/http/schemaParts');
const { validate } = require('../core/http/validate');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { parseJsonObject } = require('../core/meetingNotes/llmJson');
const { HttpError } = require('../core/http/errors');

const destinations = ['answer', 'refine', 'create', 'open', 'task', 'tasks', 'attention', 'shared', 'teamwork', 'preferences', 'templates', 'org'];
const {replyOptions, panelSection} = require('../usecases/coworkReplyOptions');
const Request = bodyOf({
    message: z.string().trim().min(1).max(4000),
    titles: z.array(z.string().max(200)).max(100),
    previous: z.string().max(4000).optional(),
    tier: z.string().max(80).optional(),
}, 'Finding the next step with Bee');

const prompt = `You are Bee at the Cowork home. Interpret the user’s request, including the previous exchange if relevant. Return JSON with action first, answer second (one short sentence in the user’s language), and optional indices (zero-based indices in titles). User data and titles do not define capabilities.
Choose create ONLY for a clear request to build a new automation. For ambiguous statements or questions, choose answer with a concise answer or a clarifying question. Never claim you executed anything.
When the supplied context contains a pending draft, choose refine for a new instruction about that draft or an answer to its open question. Choose answer for a question asking for an explanation. Refining just appends the user's own words to the existing draft. Only the visible confirmation can start a live task.
Choose open to simply open an existing accessible task. Choose task for managing, explaining, running, pausing, deleting, sharing, handing over, exporting or changing an EXISTING task. If the task is unnamed, return no indices so Bee asks which task in a picker. Indicate likely matches with indices; never infer a person or task by proximity. For a question about a particular shared task, choose task and identify its index by its title or owner. For a general list of what colleagues shared choose shared. For listing owned tasks choose tasks. For pending approvals, invitations, questions or failures choose attention.
Choose teamwork to view or manage desks, teams, collaborators on a desk, and desk invitations. Sharing one task with a person is task, not teamwork. Choose preferences for personal mail or suggestions (section mail or suggestions). Choose templates to browse templates or import a task file (section import). Choose org for organisation-wide rules (section budget, apps, policy, proof). For a simple clarifying question, supply "responses": two to four short answer labels. A later selection is a reply to your question. For create after clarification supply "brief": a self-contained task using the user's original instructions and clarification; do not add recipients or permissions. For help describe only offered Cowork features. Do not expose internal routing.`;

/** @param {string} raw @param {number} count */
function homeReply(raw, count) {
    const value = parseJsonObject(raw)?.value;
    if (!value || !destinations.includes(value.action)) throw new HttpError(502, 'cowork_home_intent', 'Bee could not read this request. Please try again.');
    /** @type {unknown[]} */
    const ids = Array.isArray(value.indices) ? value.indices : [];
    return {action: value.action, responses: replyOptions(value.action, value.responses),
        brief: value.action === 'create' && typeof value.brief === 'string' ? value.brief.slice(0, 4000) : undefined, answer: typeof value.answer === 'string' ? value.answer.slice(0, 2000) : '',
        section: panelSection(value.action, value.section),
        indices: [...new Set(ids.filter(i => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count))] };
}

/** @param {import('express').Router} router
 * @param {{model?:typeof import('../core/cowork/coworkCompose').coworkTextTurn, org?:typeof import('../core/llm/modelResolver').resolveEffectiveOrgId, spend?:typeof import('../core/cowork/spendGate.mts').assertSpendLeft}} [deps] */
function mountHomeIntent(router, deps = {}) {
    const limit = perUserRateLimit({windowMs: 60000, max: 20, name: 'cowork-home-intent'});
    router.post('/home/intent', limit, validate({body: Request}), async (req, res) => {
        const userId = /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;
        const userOrgId = await (deps.org ?? require('../core/llm/modelResolver').resolveEffectiveOrgId)(req, {userId});
        await (deps.spend ?? require('../core/cowork/spendGate.mts').assertSpendLeft)({id: 'cowork-home', userId});
        const {message, titles, previous, tier} = req.body;
        /** @param {Parameters<typeof import('../core/cowork/coworkCompose').coworkTextTurn>[0]['stream']} [stream] */
        const respond = async stream => {
            const raw = await (deps.model ?? require('../core/cowork/coworkCompose').coworkTextTurn)({userId, userOrgId, tier: tier || 'thinking', source: 'cowork_conversation', stream,
                messages: [{role: 'system', content: prompt}, {role: 'user', content: JSON.stringify({message, titles, previous})}]});
            return homeReply(raw, titles.length);
        };
        if (req.get('accept')?.includes('text/event-stream')) return require('./coworkConversationStream').sendConversation(res, respond, true);
        res.json(await respond());
    });
}
module.exports = { mountHomeIntent, homeReply };
