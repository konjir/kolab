import { describe, expect, jest, test } from '@jest/globals';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

// expo-sqlite's kv-store, as a Map.
const mockKept = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => mockKept.get(k) ?? null,
    setItem: async (k: string, v: string) => { mockKept.set(k, v); },
    removeItem: async (k: string) => { mockKept.delete(k); },
  },
}));

jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), AndroidImportance: {} }));

// eslint-disable-next-line import/first
import { persisterFor } from '../src/kolab/live';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snapshot = (what: string): PersistedClient => ({ timestamp: Date.now(), buster: 'v1', clientState: { mutations: [], queries: [{ queryKey: ['hub', what], queryHash: what, state: { data: what } }] } } as unknown as PersistedClient);

describe('the cache kept on the phone', () => {
  test('a write still waiting on the throttle when the person signs out never brings their cache back', async () => {
    mockKept.clear();
    const ann = persisterFor('ann', 20);
    await ann.persister.persistClient(snapshot('first'));
    await wait(5);
    expect(mockKept.has('konnect.query-cache.ann')).toBe(true);
    // A change inside the throttle window waits, then the person signs out.
    await ann.persister.persistClient(snapshot('second'));
    await ann.retire();
    expect(mockKept.has('konnect.query-cache.ann')).toBe(false);
    await wait(60);
    expect(mockKept.has('konnect.query-cache.ann')).toBe(false);
  });

  test('retiring one person\'s persister leaves the next person\'s cache alone', async () => {
    mockKept.clear();
    const ann = persisterFor('ann', 5);
    const bo = persisterFor('bo', 5);
    await ann.persister.persistClient(snapshot('a'));
    await wait(1);
    await ann.retire();
    await bo.persister.persistClient(snapshot('b'));
    await wait(20);
    expect([...mockKept.keys()]).toEqual(['konnect.query-cache.bo']);
  });
});
