/**
 * Customer Support Routes — AI-first inbox for Bee Flow B.V. customers.
 *
 * Endpoints:
 *   POST   /threads                 — create thread (anon from marketing, or logged-in tenant)
 *   GET    /threads                 — staff inbox (gated by admin_support)
 *   GET    /threads/mine            — logged-in user's own threads
 *   GET    /threads/:id             — view thread (own thread, staff, or anon w/ token)
 *   POST   /threads/:id/messages    — append a reply
 *   PATCH  /threads/:id             — staff status/priority/assignee update
 *   GET    /threads/:id/stream      — SSE live updates for staff inbox
 *   GET    /config                  — staff: read AI agent + KB config
 *   PUT    /config                  — super-admin: update AI agent + KB config
 *   GET    /mailbox                 — staff: is a mailbox feeding this inbox?
 *   POST   /mailbox/disconnect      — super-admin: unlink it + purge its tickets
 *
 * The AI auto-responder runs in the background after thread creation (and
 * after requester replies while AI is still in the loop).
 *
 * The handlers live in routes/support/ per resource; this file is the router
 * that mounts them. The mounting order below IS the matching order — keep it.
 */

const express = require('express');

const { supportEvents, renderCannedBody, notifyStaff } = require('./support/shared');
const threads = require('./support/threads');
const mailbox = require('./support/mailbox');
const aiConfig = require('./support/aiConfig');
const tags = require('./support/tags');
const slaPolicies = require('./support/slaPolicies');
const cannedResponses = require('./support/cannedResponses');
const satisfaction = require('./support/satisfaction');
const issueLinks = require('./support/issueLinks');

const router = express.Router();

threads.registerThreadRoutes(router);
mailbox.register(router);
aiConfig.register(router);
tags.register(router);
threads.registerBulkRoute(router);
slaPolicies.register(router);
cannedResponses.register(router);
satisfaction.register(router);
issueLinks.register(router);

// Exported so server/index.js can trigger SLA checks.
module.exports = router;
module.exports.supportEvents = supportEvents;
module.exports.renderCannedBody = renderCannedBody;
module.exports.notifyStaff = notifyStaff;
