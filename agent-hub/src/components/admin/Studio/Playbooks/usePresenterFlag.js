import { useSyncExternalStore } from 'react';
import { readPresenter, subscribePresenter } from '../../../shared/builder/presenterFlag';

/** The shared presenter flag (Shift+P on either builder canvas), live. */
export default function usePresenterFlag() {
    return useSyncExternalStore(subscribePresenter, readPresenter, () => false);
}
