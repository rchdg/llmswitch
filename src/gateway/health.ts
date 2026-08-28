/**
 * In-process failure breaker per provider.
 *
 * Without it, a dead primary upstream absorbs one failed attempt on every
 * request before fallback kicks in. After repeated failures the provider is put
 * on an exponentially growing cooldown (capped); during cooldown routing skips
 * it straight to the next candidate. If every candidate is cooling down the
 * gateway tries them anyway — a delayed answer beats a hard failure.
 *
 * State is owned by the running server instance: process-local by design, so a
 * restart clears it and tests never leak between servers.
 */

const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 120_000;

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
  lastError: string;
}

export interface BreakerSnapshotRow {
  provider: string;
  consecutiveFailures: number;
  /** Milliseconds left in cooldown; 0 when the provider may be tried again. */
  coolingMsRemaining: number;
  lastError: string;
}

export class ProviderBreaker {
  private readonly states = new Map<string, BreakerState>();

  allows(provider: string, now = Date.now()): boolean {
    const state = this.states.get(provider);
    if (!state) return true;
    return now >= state.openUntil;
  }

  failure(provider: string, message: string, now = Date.now()): void {
    const state =
      this.states.get(provider) ??
      ({ consecutiveFailures: 0, openUntil: 0, lastError: "" } as BreakerState);
    state.consecutiveFailures += 1;
    state.lastError = message.slice(0, 300);
    const backoff = Math.min(
      COOLDOWN_BASE_MS * 2 ** (state.consecutiveFailures - 1),
      COOLDOWN_MAX_MS,
    );
    state.openUntil = now + backoff;
    this.states.set(provider, state);
  }

  success(provider: string): void {
    this.states.delete(provider);
  }

  snapshot(now = Date.now()): BreakerSnapshotRow[] {
    return [...this.states.entries()]
      .map(([provider, state]) => ({
        provider,
        consecutiveFailures: state.consecutiveFailures,
        coolingMsRemaining: Math.max(0, state.openUntil - now),
        lastError: state.lastError,
      }))
      .sort((a, b) => b.coolingMsRemaining - a.coolingMsRemaining);
  }
}
