// Deterministic JSON canonicalization and hashing for command idempotency.
// The same normalized payload must always produce the same hash.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Stable stringify: object keys sorted, arrays preserved. */
export function canonicalJson(value: unknown): string {
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

/** Short, collision-resistant digest for content addressing. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize a skill resource path; rejects traversal. */
export function normalizeResourcePath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error(`resource path traversal rejected: ${path}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("resource path must not be empty");
  return parts.join("/");
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove `undefined` properties so a payload survives the JSON transport used
 * by server functions. Solid rejects arguments that JSON cannot represent, and
 * optional form fields are commonly `undefined` rather than absent.
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = stripUndefined(item);
    }
    return out as T;
  }
  return value;
}
