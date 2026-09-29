/**
 * Reports API Routes
 * Generates JSON-structured reports for the frontend PageRenderer
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * GET /:type takes the Time Period filter each report type declares below —
 * `startDate` and `endDate` — and nothing else (`.strict()`). Writing that
 * down showed three ways the period went wrong without a word:
 *
 *   - `GET /agent-performance?startDate=…&endDate=…` IGNORED the period: the
 *     report type advertises a date-range filter, but its generator took no
 *     filters and returned all-time numbers under the same heading. It now
 *     counts within the period (agentStore.getAgentStats takes the range) and
 *     says so in its title.
 *   - `?startdate=…` (any misspelled filter) was dropped: all time, again.
 *   - `?startDate=…` without an endDate crashed the system-overview title on
 *     `endDate.split` — a 500 — and `?startDate=yesterday` reached Postgres as
 *     a timestamp, another 500.
 *
 * And system-overview could not have answered at all: memoryStore.
 * getMemoryStats is async and was not awaited, so every request read
 * `.importanceDistribution.high` off a Promise — a TypeError, a 500. It is
 * awaited now.
 */

const express = require('express');
const agentStore = require('../stores/agentStore');
const memoryStore = require('../stores/memoryStore');
const { requireAuth, requirePermission } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const router = express.Router();

const DATE_TEXT = (name) => `${name} is a date (2026-09-22) or a date and time with its zone (2026-09-22T09:00:00.000Z).`;
// Each branch carries the sentence: a union answers with the first branch that
// got as far as a check, so its errorMap alone would leak "Invalid datetime".
const when = (name) => z.union(
    [z.string().datetime({ offset: true, message: DATE_TEXT(name) }), z.string().date(DATE_TEXT(name))],
    { errorMap: () => ({ message: DATE_TEXT(name) }) },
).optional();

const ReportQuery = z.object({ startDate: when('startDate'), endDate: when('endDate') }).strict();

/** " (2026-01-01 - 2026-01-31)", " (from …)", " (until …)" or "" — the period a title covers. */
function periodLabel({ startDate, endDate }) {
    const day = (v) => String(v).split('T')[0];
    if (startDate && endDate) return ` (${day(startDate)} - ${day(endDate)})`;
    if (startDate) return ` (from ${day(startDate)})`;
    if (endDate) return ` (until ${day(endDate)})`;
    return '';
}

const REPORT_TYPES = [
    {
        id: 'system-overview',
        name: 'System Overview',
        description: 'Global statistics about agents, conversations, and memory usage',
        filters: [
            { id: 'dateRange', type: 'date-range', label: 'Time Period' }
        ]
    },
    {
        id: 'agent-performance',
        name: 'Agent Performance',
        description: 'Detailed activity metrics for each agent',
        filters: [
            { id: 'dateRange', type: 'date-range', label: 'Time Period' }
        ]
    }
];

// Get available report types
router.get('/types', requireAuth, async (req, res) => {
    res.json(REPORT_TYPES);
});

// Generate a specific report
router.get('/:type', requireAuth, requirePermission('admin_monitoring'), validate({ query: ReportQuery }), async (req, res) => {
    const { type } = req.params;
    const userId = req.session.user.id;

    let reportData;
    const { startDate, endDate } = req.query;
    const filters = { startDate: startDate || null, endDate: endDate || null };

    switch (type) {
        case 'system-overview':
            reportData = await generateSystemOverview(userId, filters);
            break;
        case 'agent-performance':
            reportData = await generateAgentPerformance(filters);
            break;
        default:
            return res.status(404).json({ error: 'Report type not found' });
    }

    res.json(reportData);
});

// Report Generators

async function generateSystemOverview(userId, filters = {}) {
    const { startDate, endDate } = filters;
    const agentStats = await agentStore.getSystemStats(startDate, endDate);
    const memoryStats = await memoryStore.getMemoryStats(userId);

    const title = `System Overview${periodLabel(filters)}`;

    // Prepare chart data for messages per agent
    const messageChartData = {
        labels: [],
        datasets: [{
            label: 'Messages',
            data: [],
            backgroundColor: 'rgba(99, 102, 241, 0.5)',
            borderColor: 'rgba(99, 102, 241, 1)',
            borderWidth: 1
        }]
    };

    // Get top 5 agents by message count
    const topAgents = Object.entries(agentStats.agentMessageCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    // Fetch names for top agents
    for (const [agentId, count] of topAgents) {
        const agent = await agentStore.getAgent(agentId);
        messageChartData.labels.push(agent ? agent.name : 'Unknown Agent');
        messageChartData.datasets[0].data.push(count);
    }

    return {
        title,
        layout: [
            {
                type: "heading",
                content: "Global Statistics",
                level: 2
            },
            {
                type: "row",
                cols: [
                    { type: "stat", label: "Total Agents", value: agentStats.totalAgents, icon: "users" },
                    { type: "stat", label: "Total Conversations", value: agentStats.totalConversations, icon: "chat" },
                    { type: "stat", label: "Active (7d)", value: agentStats.activeConversations, icon: "activity" }
                ]
            },
            { type: "divider" },
            {
                type: "heading",
                content: "Memory Usage",
                level: 2
            },
            {
                type: "row",
                cols: [
                    { type: "stat", label: "Total Memories", value: memoryStats.total, icon: "brain" },
                    { type: "stat", label: "High Importance", value: memoryStats.importanceDistribution.high, icon: "star" },
                    {
                        type: "chart",
                        title: "Memory Types",
                        chartType: "pie", // Assuming PageRenderer supports this, relying on provided components
                        data: {
                            labels: memoryStats.typeDistribution.labels,
                            datasets: [{
                                label: 'Memories',
                                data: memoryStats.typeDistribution.data,
                                backgroundColor: [
                                    'rgba(16, 185, 129, 0.6)',
                                    'rgba(59, 130, 246, 0.6)',
                                    'rgba(245, 158, 11, 0.6)',
                                    'rgba(239, 68, 68, 0.6)'
                                ]
                            }]
                        }
                    }
                ]
            },
            { type: "divider" },
            {
                type: "heading",
                content: "Most Active Agents",
                level: 2
            },
            {
                type: "chart",
                title: "Messages per Agent",
                chartType: "bar",
                data: messageChartData
            }
        ]
    };
}

async function generateAgentPerformance(filters = {}) {
    const { startDate = null, endDate = null } = filters;
    const allAgents = await agentStore.getAllAgents();

    const rows = [];

    for (const agent of allAgents) {
        // The period the report type declares — counted, no longer ignored.
        const stats = await agentStore.getAgentStats(agent.id, startDate, endDate);
        const tools = await agentStore.getAgentTools(agent.id);

        rows.push({
            id: agent.id,
            name: agent.name,
            model: agent.model,
            conversations: stats.conversationCount,
            messages: stats.messageCount,
            tools: tools.length,
            last_active: stats.lastUpdated
        });
    }

    // Sort by messages desc
    rows.sort((a, b) => b.messages - a.messages);

    return {
        title: `Agent Performance${periodLabel(filters)}`,
        layout: [
            {
                type: "heading",
                content: "Agent Activity Metrics",
                level: 2
            },
            {
                type: "table",
                title: "Detailed Agent Stats",
                columns: [
                    { key: "name", label: "Agent Name" },
                    { key: "model", label: "Model" },
                    { key: "conversations", label: "Conversations" },
                    { key: "messages", label: "Messages" },
                    { key: "tools", label: "Tools" },
                    { key: "last_active", label: "Last Updated" }
                ],
                data: rows
            }
        ]
    };
}

module.exports = router;
