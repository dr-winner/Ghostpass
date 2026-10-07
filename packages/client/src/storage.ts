import { del, get, set } from 'idb-keyval';

/** Async key-value storage. Browsers use IndexedDB; tests and scripts use memory. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export const indexedDbStore: KeyValueStore = {
  get: key => get(key),
  set: (key, value) => set(key, value),
  del: key => del(key),
};

export function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    del: async key => { values.delete(key); },
  };
}
