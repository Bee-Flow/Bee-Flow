import { useSyncExternalStore } from 'react';
import { readPresenter, subscribePresenter } from '@/components/shared/builder/presenterFlag';

/** The shared presenter flag (Shift+P on either builder canvas), live. */
export default function usePresenterFlag(): boolean {
    return useSyncExternalStore(subscribePresenter, readPresenter, () => false);
}
