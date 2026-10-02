export class ScopeError extends Error {
  constructor(need: string) {
    super(`This tool requires the ${need} scope, which this connection was not granted.`);
    this.name = 'ScopeError';
  }
}

/** Assert the granted scopes include the one this tool needs, else throw. */
export function requireScope(have: string[], need: string): void {
  if (!have.includes(need)) throw new ScopeError(need);
}
