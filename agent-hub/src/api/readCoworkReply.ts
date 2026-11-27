import { readEventStream } from './readEventStream';

export async function readCoworkReply<Reply extends {action: string}>(response: Response, signal: AbortSignal, partial: (answer: string) => void): Promise<Reply> {
    if (!response.headers?.get('content-type')?.includes('text/event-stream')) return await response.json() as Reply;
    for await (const {event, data} of readEventStream<string | Reply>(response, {signal})) {
        if (event === 'answer' && typeof data === 'string') partial(data);
        if (event === 'reply' && typeof data === 'object' && data?.action) return data;
        if (event === 'error' && typeof data === 'string') throw new Error(data);
    }
    throw new Error('The reply was interrupted.');
}
