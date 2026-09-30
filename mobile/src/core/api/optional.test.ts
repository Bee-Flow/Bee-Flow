import { ApiError, OfflineError } from './client';
import { optional } from './optional';

describe('optional', () => {
    it('passes an answer through', async () => {
        await expect(optional(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
        await expect(optional(async () => null)).resolves.toBeNull();
    });

    it.each([402, 403, 404])('folds a %i refusal into null', async (status) => {
        await expect(
            optional(async () => {
                throw new ApiError('refused', { status });
            }),
        ).resolves.toBeNull();
    });

    it('rethrows a server failure, which a retry might fix', async () => {
        const failure = new ApiError('boom', { status: 500 });
        await expect(
            optional(async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });

    it('rethrows anything that is not an API refusal', async () => {
        await expect(
            optional(async () => {
                throw new OfflineError();
            }),
        ).rejects.toBeInstanceOf(OfflineError);
    });
});
