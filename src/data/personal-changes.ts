const changes = new EventTarget();

export function announcePersonalDataChange(): void {
  changes.dispatchEvent(new Event("change"));
}

export function onPersonalDataChange(listener: () => void): () => void {
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
}
