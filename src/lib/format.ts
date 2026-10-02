const CAP = 100 * 1024; // 100KB cap on body/response fields in tool output

/** Cap a large string field so tool output stays bounded. */
export function cap(s: string | null | undefined): string {
  if (!s) return '';
  return s.length > CAP ? s.slice(0, CAP) + `…[truncated ${s.length - CAP} bytes]` : s;
}

/** Standard MCP success content wrapper (JSON text). */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/** Standard MCP error content wrapper — a readable message the agent can relay. */
export function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
