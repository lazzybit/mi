// Deterministic payload hashing for command idempotency (ADR-0003). The same
// normalized payload must always produce the same hash so a reused command id
// with a changed payload is detected.

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Stable stringify: object keys sorted, arrays preserved. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): JsonValue {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value as JsonValue;
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new TypeError("cannot canonicalize non-finite number");
    return n;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (t === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      out[key] = normalize(v);
    }
    return out;
  }
  throw new TypeError(`cannot canonicalize value of type ${t}`);
}

/** FNV-1a 64-bit hash rendered as hex. Deterministic across runtimes. */
export function hashPayload(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
