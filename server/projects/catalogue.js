'use strict';
// Titles are resolved under the reader's existing project access. No plaintext index.
const TYPES = Object.freeze(['chat', 'task', 'document', 'notebook', 'meeting', 'file']);
async function allPages(list) {
    const items = [];
    for (let offset = 0; ; offset += 200) {
        const page = await list({ limit: 200, offset });
        items.push(...page);
        if (page.length < 200) return items;
    }
}
async function catalogue(project, userId) {
    const box = await require('./chatCrypto').forProject(project);
    const result = [];
    const open = (fn) => { try { return fn(); } catch { return null; } };
    const lists = {
        document: (options) => require('../stores/documentStore').listProjectDocuments(project.id, options),
        notebook: (options) => require('../stores/notebookStore').listProjectNotebooks(project.id, options),
        meeting: (options) => require('../stores/transcriptionStore').listProjectMeetings(project.id, options),
    };
    for (const [type, list] of Object.entries(lists)) {
        for (const item of await allPages(list)) result.push({ type, id: item.id, title: item.name || item.title || '', updatedAt: item.updatedAt || item.createdAt });
    }
    for (const thread of await allPages(options => require('../stores/agent/sharedConversations').listProjectThreads(project.id, options))) {
        result.push({ type: 'chat', id: thread.id, title: thread.title || '', threadType: thread.type, agentId: thread.agentId || null });
    }
    for (const archived of [false, true]) {
        for (const chat of await require('../stores/projectChatStore').listChats(project.id, { userId, archived })) {
            const title = open(() => box.openTitle(chat.id, chat.title));
            if (title !== null) result.push({ type: 'chat', id: chat.id, title, archived });
        }
    }
    for (const task of await require('../stores/projectTaskStore').listSearchTasks(project.id)) {
        const title = open(() => box.openTitle(task.id, task.title));
        const description = task.description ? open(() => box.openContent(task.id, task.id, task.description)) : '';
        if (title !== null) result.push({ type: 'task', id: task.id, title, description: description || '' });
    }
    const { files } = await require('./projectFiles').listFiles(project);
    for (const file of files) result.push({ type: 'file', id: file.id, title: file.name });
    return result;
}
function searchCatalogue(items, { q = '', type, cursor = 0, limit = 40 }) {
    const needle = q.trim().toLocaleLowerCase();
    const matches = items.filter(item => (!type || item.type === type) && `${item.title} ${item.description || ''}`.toLocaleLowerCase().includes(needle))
        .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    const page = matches.slice(cursor, cursor + limit).map(({ description, ...item }) => item);
    return { items: page, nextCursor: cursor + limit < matches.length ? String(cursor + limit) : null };
}
module.exports = { TYPES, catalogue, searchCatalogue, allPages };
