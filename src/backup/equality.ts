/** Compares records structurally, ignoring key order and omitted optional properties. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof ArrayBuffer && right instanceof ArrayBuffer) {
    if (left.byteLength !== right.byteLength) return false;
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    return a.every((value, index) => value === b[index]);
  }
  // Legacy Blob rows are immutable. The repository assigns a new ID to every photo replacement.
  if (left instanceof Blob || right instanceof Blob) {
    return left instanceof Blob && right instanceof Blob && left.type === right.type && left.size === right.size;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
      || Array.isArray(left) || Array.isArray(right) || left instanceof ArrayBuffer || right instanceof ArrayBuffer) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => sameValue(a[key], b[key]));
}
