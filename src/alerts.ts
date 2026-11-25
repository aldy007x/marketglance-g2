// Watchlist + price-move alerts for MarketGlance.
// Pure logic, no DOM / SDK dependencies — unit-testable in plain Node, and
// shared verbatim by two runtimes:
//   - the glasses app (src/main.ts) checks on every price refresh, and
//   - the backend proxy (server/proxy.mjs) polls on its own schedule so
//     Telegram alerts fire even when the glasses app is closed.
// An alert fires when a watched asset moves >= thresholdPct from its
// baseline. The baseline then resets to the firing price, so one move
// produces exactly one alert (no spam while the price keeps drifting).

import type { MarketInfo } from './data.ts';
import { fmtPrice } from './portfolio.ts';

export interface AlertEvent {
  id: string; // asset id
  symbol: string;
  name: string;
  from: number; // baseline price
  to: number; // price that triggered the alert
  pct: number; // signed percent move, e.g. +3.42 / -5.1
  at: string; // 'HH:MM'
}

export interface AlertState {
  watchlist: string[]; // asset ids being watched
  thresholdPct: number; // move size that fires an alert, e.g. 3
  baselines: Record<string, number>; // last baseline price per asset id
  history: AlertEvent[]; // fired alerts, newest first
}

export const THRESHOLD_OPTIONS = [1, 3, 5, 10];
export const HISTORY_CAP = 20;

export function emptyAlertState(watchlist: string[] = []): AlertState {
  return { watchlist: [...watchlist], thresholdPct: 3, baselines: {}, history: [] };
}

/** Tolerate alert state saved by older versions / partial objects. */
export function withAlertDefaults(a: Partial<AlertState> | undefined | null): AlertState {
  const base = emptyAlertState();
  if (!a) return base;
  return {
    watchlist: Array.isArray(a.watchlist) ? a.watchlist : base.watchlist,
    thresholdPct: typeof a.thresholdPct === 'number' ? a.thresholdPct : base.thresholdPct,
    baselines: a.baselines && typeof a.baselines === 'object' ? a.baselines : {},
    history: Array.isArray(a.history) ? a.history : [],
  };
}

export function isWatched(a: AlertState, id: string): boolean {
  return a.watchlist.includes(id);
}

/** Toggle an asset on the watchlist. Returns true if it is now watched. */
export function toggleWatch(a: AlertState, id: string): boolean {
  const i = a.watchlist.indexOf(id);
  if (i >= 0) {
    a.watchlist.splice(i, 1);
    delete a.baselines[id];
    return false;
  }
  a.watchlist.push(id);
  return true;
}

/** Cycle the alert threshold through THRESHOLD_OPTIONS. Returns the new value. */
export function cycleThreshold(a: AlertState): number {
  const i = THRESHOLD_OPTIONS.indexOf(a.thresholdPct);
  a.thresholdPct = THRESHOLD_OPTIONS[(i + 1) % THRESHOLD_OPTIONS.length];
  a.baselines = {}; // re-baseline at the new sensitivity on the next check
  return a.thresholdPct;
}

/**
 * Compare the latest prices against baselines and fire alerts.
 * Mutates state (baselines + history); returns the events fired this check.
 * First sight of a watched asset only sets its baseline — never fires.
 */
export function checkAlerts(a: AlertState, markets: MarketInfo[], atHHMM: string): AlertEvent[] {
  const fired: AlertEvent[] = [];
  for (const m of markets) {
    if (!a.watchlist.includes(m.id) || !(m.price > 0)) continue;
    const base = a.baselines[m.id];
    if (base === undefined || !(base > 0)) {
      a.baselines[m.id] = m.price;
      continue;
    }
    const pct = ((m.price - base) / base) * 100;
    if (Math.abs(pct) >= a.thresholdPct) {
      const ev: AlertEvent = { id: m.id, symbol: m.symbol, name: m.name, from: base, to: m.price, pct, at: atHHMM };
      fired.push(ev);
      a.history.unshift(ev);
      a.baselines[m.id] = m.price; // reset baseline -> one alert per move
    }
  }
  if (a.history.length > HISTORY_CAP) a.history.length = HISTORY_CAP;
  return fired;
}

/** One-line alert for the G2 list (must stay <= 64 chars). */
export function fmtAlert(e: AlertEvent): string {
  const sign = e.pct >= 0 ? '+' : '';
  return `${e.symbol} ${sign}${e.pct.toFixed(1)}% $${fmtPrice(e.from)}->$${fmtPrice(e.to)} ${e.at}`;
}

/** Fuller alert text for Telegram / notices. */
export function fmtAlertLong(e: AlertEvent): string {
  const sign = e.pct >= 0 ? '+' : '';
  const arrow = e.pct >= 0 ? 'is up' : 'is down';
  return `${e.name} (${e.symbol}) ${arrow} ${sign}${e.pct.toFixed(1)}%: $${fmtPrice(e.from)} -> $${fmtPrice(e.to)} (paper alert, ${e.at})`;
}
