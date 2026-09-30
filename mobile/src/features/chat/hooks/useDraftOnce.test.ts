/**
 * The home composer's hand-over: its words and its files reach the new chat
 * once, and only a new chat.
 */

import { renderHook } from '@testing-library/react-native';

import { useDraftOnce } from './useDraftOnce';
import { stageNewChatFiles, takeNewChatFiles } from '../model/newChat';

const photo = { name: 'photo.jpg', mimeType: 'image/jpeg', uri: 'file:///cache/photo.jpg' };

type Props = { draft?: string; isNew: boolean };

async function mount(initial: Props) {
    const send = jest.fn();
    const hook = await renderHook((props: Props) => useDraftOnce(props.draft, props.isNew, send), { initialProps: initial });
    return { send, hook };
}

beforeEach(() => {
    takeNewChatFiles();
});

it('sends the words with the files that came with them, once', async () => {
    stageNewChatFiles([photo]);
    const { send, hook } = await mount({ draft: 'What is in this photo?', isNew: true });
    await hook.rerender({ draft: 'What is in this photo?', isNew: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('What is in this photo?', [photo]);
});

it('sends a photo that came without words', async () => {
    stageNewChatFiles([photo]);
    const { send } = await mount({ isNew: true });
    expect(send).toHaveBeenCalledWith('', [photo]);
});

it('leaves the files for nobody else once taken: a second new chat sends nothing', async () => {
    stageNewChatFiles([photo]);
    await mount({ isNew: true });
    const again = await mount({ isNew: true });
    expect(again.send).not.toHaveBeenCalled();
});

it('never takes them into a saved chat, and sends nothing there', async () => {
    stageNewChatFiles([photo]);
    const { send } = await mount({ draft: 'Hello', isNew: false });
    expect(send).not.toHaveBeenCalled();
    expect(takeNewChatFiles()).toEqual([photo]);
});

it('sends plain words as before', async () => {
    const { send } = await mount({ draft: 'Hello', isNew: true });
    expect(send).toHaveBeenCalledWith('Hello', []);
});
