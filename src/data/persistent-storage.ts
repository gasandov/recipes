let requested = false;

/** An optional browser grant. A denial leaves normal IndexedDB writes available. */
export function requestPersistentStorage(): void {
  if (requested || !globalThis.navigator?.storage?.persist) return;

  requested = true;
  void navigator.storage.persist().catch((error: unknown) => {
    console.warn("Persistent storage could not be requested.", error);
  });
}
