/**
 * Re-transcribe from the saved audio. A refusal is a dialog rather than a toast:
 * each code means something different to the person holding the phone
 * (model/reprocess.ts), and they need to be able to read it.
 */

import { Alert } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useToast } from '@/shared/ui';

import { useReprocessTranscription } from './mutations';
import { reprocessErrorCode, reprocessFailureMessage } from '../model/reprocess';

export function useMeetingRetry(id: string) {
    const { toast } = useToast();
    return useReprocessTranscription(id, {
        onSuccess: () => toast('Transcribing again', 'success'),
        onError: (err) => {
            const message = reprocessFailureMessage(reprocessErrorCode(err), describeError(err).message);
            Alert.alert('Cannot re-transcribe', message);
        },
    });
}
