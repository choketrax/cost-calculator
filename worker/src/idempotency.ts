/**
 * Deterministic ID generation for the Spend Control Pack idempotency contract.
 *
 * Stable ID hierarchy:
 *   request_id          (client-supplied or generated at proxy entry)
 *     └── reservation_id  = deterministicId(request_id, "reserve")
 *     └── ledger_event_id = deterministicId(request_id, "ledger")
 *     └── queue_event_id  = request_id + ":" + event_type
 *
 * Using deterministic IDs means any retry with the same request_id
 * produces the same downstream IDs — so duplicate operations are
 * detected and safely skipped at each layer.
 */

export async function deterministicId(input: string, namespace: string): Promise<string> {
  const data = new TextEncoder().encode(`${input}:${namespace}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
