import { sameIds, toggleIn } from './lists';

describe('id lists', () => {
    it('switches an id in and out, keeping the given order', () => {
        const order = ['files', 'calendar', 'deck'];
        expect(toggleIn(['deck'], 'files', order)).toEqual(['files', 'deck']);
        expect(toggleIn(['files', 'deck'], 'files', order)).toEqual(['deck']);
        expect(toggleIn(['b'], 'a')).toEqual(['a', 'b']);
    });

    it('compares as sets', () => {
        expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    });
});
