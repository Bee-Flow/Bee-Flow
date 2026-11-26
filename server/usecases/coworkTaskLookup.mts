interface Task { id: string; title?: string | null; prompt?: string | null; ownerName?: string }
type Reader = (userId: string) => Promise<readonly (Task | null)[]>;

const words = (text: string): string[] => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export async function findOtherTasks(ownerId: string, currentId: string, query: string, switchRequested: boolean, read: Reader) {
    const phrase = words(query).join(' ');
    const terms = phrase.split(' ').filter(Boolean);
    const ranked = (await read(ownerId)).flatMap(task => {
        if (!task?.title || task.id === currentId) return [];
        const title = words(task.title).join(' ');
        const detail = task.ownerName || task.prompt?.trim().slice(0, 100) || '';
        const exact = phrase !== '' && (phrase === title || query === task.id);
        const detailWords = words(detail);
        const score = terms.filter(term => title.includes(term)).length * 3
            + terms.filter(term => detailWords.includes(term)).length;
        return !phrase || exact || score ? [{ exact, score, named: title.includes(phrase), task: { id: task.id, title: task.title, detail, shared: !!task.ownerName } }] : [];
    }).sort((a,b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
    const exact = ranked.filter(entry => entry.exact);
    const matches = switchRequested && exact.length ? exact : ranked;
    return {
        tasks: matches.slice(0, 5).map(entry => entry.task),
        switchTo: switchRequested && phrase && matches.length === 1 && (matches[0].exact || matches[0].named) ? matches[0].task.id : undefined,
    };
}
