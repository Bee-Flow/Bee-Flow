import { readCoworkReply } from './readCoworkReply';
import { apiRequest } from './typedRequest';

export type HomeAction = 'answer' | 'create' | 'open' | 'task' | 'tasks' | 'attention' | 'shared' | 'teamwork' | 'preferences' | 'templates' | 'org';
interface HomeReply {action: HomeAction; answer: string; indices: number[]; section?: string; responses?: string[]; brief?: string}

interface HomeQuestion {message: string; titles: string[]; tier: string; previous: string}

export async function locateCoworkRequest({message, titles, tier, previous}: HomeQuestion, signal: AbortSignal, partial: (answer: string) => void) {
    const response = await apiRequest('POST /api/cowork/home/intent', {
        body: {message, titles: titles.slice(0, 100).map(title => title.slice(0, 200)), tier, previous: previous.slice(-4000)}, init: {signal, headers: {Accept: 'text/event-stream'}},
    });
    return readCoworkReply<HomeReply>(response, signal, partial);
}
