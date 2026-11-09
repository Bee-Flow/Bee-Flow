import { useEffect } from 'react';
import type { StatusMessage } from '../chatModelTiers/tierTypes';
import toast from '@/components/shared/Toast';

/** Say a hook's status message as a toast, once per message. Clearing it says nothing. */
export function useToastOnMessage(message: StatusMessage | null | undefined) {
    useEffect(() => {
        if (!message) return;
        if (message.type === 'success') toast.success(message.text);
        else if (message.type === 'error') toast.error(message.text);
        else toast.info(message.text);
    }, [message]);
}
