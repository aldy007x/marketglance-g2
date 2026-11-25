// MarketGlance screen state machine + view models.
// Framework-free: the same view models drive the real Even Hub SDK containers
// (src/main.ts) and the plain-browser preview fallback, so what you test in a
// browser is what renders on the glasses.
//
// Screens: markets (home) · detail (one asset, trade + watch) · positions
// (portfolio) · history (paper trades) · alerts (price-move alerts) ·
// settings (threshold, refresh, Telegram pairing).
// Voice commands (src/voice.ts) execute through executeCommand() below,
// which reuses the same state transitions as select() — one state machine,
// two inputs (ring/tap and voice).

import {
  buy,
  sellAll,
  totalValue,
  unrealizedPnl,
  fmtPrice,
  fmtChange,
  fmtSignedUsd,
  START_CASH,
} from './portfolio.ts';
import type { Portfolio, TradeResult } from './portfolio.ts';
import type { MarketInfo } from './data.ts';
import {
  withAlertDefaults,
  isWatched,
  toggleWatch,
  cycleThreshold,
  checkAlerts,
  fmtAlert,
} from './alerts.ts';
import type { AlertState, AlertEvent } from './alerts.ts';
import type { VoiceCommand } from './voice.ts';

export type Screen =
  | { kind: 'markets' }
  | { kind: 'detail'; id: string }
  | { kind: 'positions' }
  | { kind: 'history' }
  | { kind: 'alerts' }
  | { kind: 'settings' };

export interface TelegramUiState {
  viaProxy?: boolean; // served by server/proxy.mjs (Telegram lives there)
  linked?: boolean; // a Telegram chat is paired
  pairCode?: string; // current pairing code, if fetched
  mock?: boolean; // backend runs in mock-token mode (demo outbox)
}

export interface AppState {
  markets: MarketInfo[];
  portfolio: Portfolio;
  screen: Screen;
  notice: string; // result of the last action, shown in the header
  updatedAt: string; // 'HH:MM'
  offline: boolean;
  save: (p: Portfolio) => void; // persistence callback (localStorage in main.ts)
  // --- upgrade state (optional so older hosts/tests can omit them) ---
  alerts?: AlertState;
  refreshSec?: number;
  telegram?: TelegramUiState;
  saveAlerts?: (a: AlertState) => void;
  savePrefs?: () => void;
  syncAlerts?: () => void; // main.ts hook: push watchlist/threshold to proxy
}

export const REFRESH_OPTIONS = [30, 60, 300];

/** Alert state accessor: lazily initialises so minimal hosts still work. */
export function alertsOf(s: AppState): AlertState {
  if (!s.alerts) s.alerts = withAlertDefaults(undefined);
  return s.alerts;
}

export function refreshSecOf(s: AppState): number {
  return s.refreshSec && REFRESH_OPTIONS.includes(s.refreshSec) ? s.refreshSec : 60;
}

export function marketById(state: AppState, id: string): MarketInfo | undefined {
  return state.markets.find((m) => m.id === id);
}

function pricesOf(state: AppState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of state.markets) out[m.id] = m.price;
  return out;
}

function trimQty(q: number): string {
  return q >= 1 ? q.toFixed(3) : q.toFixed(5);
}

// ---------------- markets (home) screen ----------------

export function marketsHeader(s: AppState): string {
  const v = totalValue(s.portfolio, pricesOf(s));
  const pnl = v - START_CASH;
  const src = s.offline ? 'OFFLINE SAMPLE' : `live ${s.updatedAt}`;
  const nAlerts = alertsOf(s).history.length;
  return [
    'MARKET GLANCE',
    `Paper $${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${fmtSignedUsd(pnl)})`,
    src + (nAlerts ? ` · ${nAlerts} alert${nAlerts > 1 ? 's' : ''}` : '') + (s.notice ? ` · ${s.notice}` : ''),
  ].join('\n');
}

export function marketsItems(s: AppState): string[] {
  const items = s.markets.map(
    (m) => `${m.symbol} $${fmtPrice(m.price)} ${fmtChange(m.change24h)}`,
  );
  const n = Object.keys(s.portfolio.positions).length;
  items.push(`My positions (${n})`);
  items.push(`Alerts (${alertsOf(s).history.length})`);
  items.push('Settings');
  items.push('Refresh prices');
  return items;
}

// ---------------- detail screen ----------------

export function detailHeader(s: AppState, id: string): string {
  const m = marketById(s, id);
  if (!m) return 'Unknown market';
  const lines = [
    `${m.name} (${m.symbol})`,
    `$${fmtPrice(m.price)}  24h ${fmtChange(m.change24h)}`,
  ];
  if (m.pmQuestion && m.pmYes !== undefined) {
    const q = m.pmQuestion.length > 62 ? m.pmQuestion.slice(0, 59) + '...' : m.pmQuestion;
    lines.push(`PM: ${q}`);
    lines.push(`YES ${Math.round(m.pmYes * 100)}c on Polymarket`);
  }
  const pos = s.portfolio.positions[id];
  if (pos) {
    lines.push(
      `You: ${trimQty(pos.qty)} ${m.symbol} @ $${fmtPrice(pos.avgPrice)} (${fmtSignedUsd(unrealizedPnl(pos, m.price))})`,
    );
  } else {
    lines.push('You: no position');
  }
  const watch = isWatched(alertsOf(s), id) ? ` · Watching >=${alertsOf(s).thresholdPct}%` : '';
  lines.push(`Cash $${s.portfolio.cash.toFixed(2)}${watch}` + (s.notice ? ` · ${s.notice}` : ''));
  return lines.join('\n');
}

export function detailItems(s: AppState, id: string): string[] {
  const m = marketById(s, id);
  const has = Boolean(s.portfolio.positions[id]);
  const sym = m?.symbol ?? id;
  return [
    'Buy $100 paper',
    'Buy $500 paper',
    has ? 'Sell all' : 'Sell all (none)',
    'Back to markets',
    isWatched(alertsOf(s), id) ? `Unwatch ${sym}` : `Watch ${sym}`,
  ];
}

// ---------------- positions (portfolio) screen ----------------

export function positionsHeader(s: AppState): string {
  const v = totalValue(s.portfolio, pricesOf(s));
  const lines = [
    'MY POSITIONS (paper)',
    `Value $${v.toFixed(2)} · realized ${fmtSignedUsd(s.portfolio.realized)}`,
    `Cash $${s.portfolio.cash.toFixed(2)}`,
  ];
  if (Object.keys(s.portfolio.positions).length === 0) lines.push('No open positions yet.');
  if (s.notice) lines.push(s.notice);
  return lines.join('\n');
}

export function positionsItems(s: AppState): string[] {
  const items: string[] = [];
  for (const pos of Object.values(s.portfolio.positions)) {
    const m = marketById(s, pos.id);
    const price = m?.price ?? pos.avgPrice;
    items.push(
      `${m?.symbol ?? pos.id} ${trimQty(pos.qty)} = $${fmtPrice(pos.qty * price)} ${fmtSignedUsd(unrealizedPnl(pos, price))}`,
    );
  }
  items.push('Trade history');
  items.push('Back to markets');
  return items;
}

// ---------------- history screen ----------------

export function historyHeader(s: AppState): string {
  const trades = s.portfolio.trades ?? [];
  const lines = [
    'TRADE HISTORY (paper)',
    `${trades.length} trade${trades.length === 1 ? '' : 's'} · realized ${fmtSignedUsd(s.portfolio.realized)}`,
  ];
  if (trades.length === 0) lines.push('No trades yet — buy from any asset.');
  if (s.notice) lines.push(s.notice);
  return lines.join('\n');
}

export function historyItems(s: AppState): string[] {
  const items: string[] = [];
  const trades = [...(s.portfolio.trades ?? [])].reverse().slice(0, 17);
  for (const t of trades) {
    const m = marketById(s, t.id);
    const sym = m?.symbol ?? t.id.toUpperCase();
    items.push(
      t.side === 'buy'
        ? `BUY ${sym} $${t.usd.toFixed(0)} @ $${fmtPrice(t.price)} ${t.at}`.trim()
        : `SELL ${sym} $${t.usd.toFixed(2)} (${fmtSignedUsd(t.pnl ?? 0)}) ${t.at}`.trim(),
    );
  }
  items.push('Back to markets');
  return items;
}

// ---------------- alerts screen ----------------

export function alertsHeader(s: AppState): string {
  const a = alertsOf(s);
  const names = a.watchlist
    .map((id) => marketById(s, id)?.symbol ?? id.toUpperCase())
    .join(' ');
  const lines = [
    'PRICE ALERTS (paper)',
    a.watchlist.length
      ? `Watching: ${names} · fires at >=${a.thresholdPct}%`
      : 'Watching: none — open an asset, tap Watch.',
  ];
  if (a.history.length === 0) lines.push('No alerts fired yet.');
  if (s.notice) lines.push(s.notice);
  return lines.join('\n');
}

export function alertsItems(s: AppState): string[] {
  const items = alertsOf(s).history.slice(0, 18).map((e) => fmtAlert(e));
  items.push('Back to markets');
  return items;
}

// ---------------- settings screen ----------------

export function settingsHeader(s: AppState): string {
  const a = alertsOf(s);
  const tg = s.telegram;
  const tgLine = !tg?.viaProxy
    ? 'Telegram: run via proxy to link'
    : tg.linked
      ? `Telegram: linked${tg.mock ? ' (mock mode)' : ''}`
      : tg.pairCode
        ? `Telegram: send /start ${tg.pairCode} to the bot`
        : 'Telegram: not linked yet';
  const lines = [
    'SETTINGS',
    `Alerts fire at >=${a.thresholdPct}% moves · refresh ${refreshSecOf(s)}s`,
    tgLine,
  ];
  if (s.notice) lines.push(s.notice);
  return lines.join('\n');
}

export function settingsItems(s: AppState): string[] {
  const tg = s.telegram;
  return [
    `Alert threshold: ${alertsOf(s).thresholdPct}%`,
    `Refresh: ${refreshSecOf(s)}s`,
    tg?.viaProxy ? 'Telegram pairing' : 'Telegram: via proxy only',
    'Back to markets',
  ];
}

// ---------------- alert checking (called by main.ts after each refresh) ----

/**
 * Run the alert engine against the current prices. On any fired alert the
 * first one becomes the header notice. Returns the fired events so the host
 * can forward them (Telegram) and persist state.
 */
export function applyAlertCheck(s: AppState, atHHMM: string): AlertEvent[] {
  const a = alertsOf(s);
  const fired = checkAlerts(a, s.markets, atHHMM);
  if (fired.length) {
    s.notice = `ALERT ${fmtAlert(fired[0])}`;
    s.saveAlerts?.(a);
  }
  return fired;
}

// ---------------- selection handling ----------------

/** Handle a list selection on the current screen. Mutates state. */
export function select(s: AppState, index: number): void {
  s.notice = '';
  if (s.screen.kind === 'markets') {
    const items = marketsItems(s);
    if (index < s.markets.length) {
      s.screen = { kind: 'detail', id: s.markets[index].id };
    } else if (items[index]?.startsWith('My positions')) {
      s.screen = { kind: 'positions' };
    } else if (items[index]?.startsWith('Alerts')) {
      s.screen = { kind: 'alerts' };
    } else if (items[index] === 'Settings') {
      s.screen = { kind: 'settings' };
    } else if (items[index] === 'Refresh prices') {
      s.notice = 'Refreshing...'; // main.ts watches for this and refetches
    }
    return;
  }
  if (s.screen.kind === 'detail') {
    const id = s.screen.id;
    const m = marketById(s, id);
    let r: TradeResult | undefined;
    if (index === 0) r = buy(s.portfolio, id, m?.price ?? 0, 100, s.updatedAt);
    else if (index === 1) r = buy(s.portfolio, id, m?.price ?? 0, 500, s.updatedAt);
    else if (index === 2) r = sellAll(s.portfolio, id, m?.price ?? 0, s.updatedAt);
    else if (index === 3) s.screen = { kind: 'markets' };
    else if (index === 4) {
      const now = toggleWatch(alertsOf(s), id);
      s.notice = now ? `Watching ${m?.symbol ?? id} for >=${alertsOf(s).thresholdPct}% moves` : `Stopped watching ${m?.symbol ?? id}`;
      s.saveAlerts?.(alertsOf(s));
      s.syncAlerts?.();
    }
    if (r) {
      s.notice = r.message;
      if (r.ok) s.save(s.portfolio);
    }
    return;
  }
  if (s.screen.kind === 'positions') {
    const ids = Object.keys(s.portfolio.positions);
    const items = positionsItems(s);
    if (index < ids.length) s.screen = { kind: 'detail', id: ids[index] };
    else if (items[index] === 'Trade history') s.screen = { kind: 'history' };
    else s.screen = { kind: 'markets' };
    return;
  }
  if (s.screen.kind === 'history') {
    const items = historyItems(s);
    const trades = [...(s.portfolio.trades ?? [])].reverse().slice(0, 17);
    if (index < trades.length) s.screen = { kind: 'detail', id: trades[index].id };
    else if (items[index] === 'Back to markets') s.screen = { kind: 'markets' };
    return;
  }
  if (s.screen.kind === 'alerts') {
    const a = alertsOf(s);
    if (index < a.history.length) s.screen = { kind: 'detail', id: a.history[index].id };
    else s.screen = { kind: 'markets' };
    return;
  }
  if (s.screen.kind === 'settings') {
    if (index === 0) {
      const t = cycleThreshold(alertsOf(s));
      s.notice = `Alert threshold now ${t}%`;
      s.saveAlerts?.(alertsOf(s));
      s.syncAlerts?.();
    } else if (index === 1) {
      const cur = refreshSecOf(s);
      s.refreshSec = REFRESH_OPTIONS[(REFRESH_OPTIONS.indexOf(cur) + 1) % REFRESH_OPTIONS.length];
      s.notice = `Refresh every ${s.refreshSec}s`;
      s.savePrefs?.();
    } else if (index === 2) {
      const tg = s.telegram;
      s.notice = !tg?.viaProxy
        ? 'Telegram links when served by the backend proxy'
        : tg.pairCode
          ? `In Telegram, send /start ${tg.pairCode} to the bot`
          : 'Open Settings again in a moment — fetching pairing code';
    } else {
      s.screen = { kind: 'markets' };
    }
  }
}

/** Double-tap = back (or exit on the home screen — handled by the caller). */
export function back(s: AppState): boolean {
  if (s.screen.kind === 'markets') return false; // already home -> caller exits
  s.screen = { kind: 'markets' };
  s.notice = '';
  return true;
}

// ---------------- voice command execution ----------------

/**
 * Execute a parsed voice command through the same transitions as select().
 * Returns a short confirmation (shown in the preview, and what a TTS/STT
 * round-trip would speak back on hardware).
 */
export function executeCommand(s: AppState, cmd: VoiceCommand): string {
  s.notice = '';
  switch (cmd.type) {
    case 'open': {
      const m = marketById(s, cmd.id);
      if (!m) return 'Asset not available';
      s.screen = { kind: 'detail', id: cmd.id };
      return `Showing ${m.name}: $${fmtPrice(m.price)} (${fmtChange(m.change24h)} 24h)`;
    }
    case 'buy': {
      const id = cmd.id ?? (s.screen.kind === 'detail' ? s.screen.id : undefined);
      if (!id) return 'Which asset? Say "buy 100 of Bitcoin"';
      const m = marketById(s, id);
      const r = buy(s.portfolio, id, m?.price ?? 0, cmd.usd, s.updatedAt);
      s.notice = r.message;
      if (r.ok) {
        s.save(s.portfolio);
        s.screen = { kind: 'detail', id };
      }
      return `${r.message} of ${m?.symbol ?? id} (paper)`;
    }
    case 'sellAll': {
      const id = cmd.id ?? (s.screen.kind === 'detail' ? s.screen.id : undefined);
      if (!id) return 'Which asset? Open it first, or name it';
      const m = marketById(s, id);
      const r = sellAll(s.portfolio, id, m?.price ?? 0, s.updatedAt);
      s.notice = r.message;
      if (r.ok) {
        s.save(s.portfolio);
        s.screen = { kind: 'detail', id };
      }
      return `${r.message} (${m?.symbol ?? id}, paper)`;
    }
    case 'screen': {
      s.screen = { kind: cmd.screen };
      return {
        markets: 'Showing markets',
        positions: 'Showing your paper portfolio',
        history: 'Showing trade history',
        alerts: 'Showing alerts',
        settings: 'Showing settings',
      }[cmd.screen];
    }
    case 'watch': {
      const a = alertsOf(s);
      const m = marketById(s, cmd.id);
      if (isWatched(a, cmd.id) !== cmd.on) toggleWatch(a, cmd.id);
      s.saveAlerts?.(a);
      s.syncAlerts?.();
      return cmd.on
        ? `Watching ${m?.symbol ?? cmd.id}: alert at >=${a.thresholdPct}% moves`
        : `Stopped watching ${m?.symbol ?? cmd.id}`;
    }
    case 'refresh': {
      s.notice = 'Refreshing...';
      return 'Refreshing prices';
    }
    case 'back': {
      return back(s) ? 'Back to markets' : 'Already on the home screen';
    }
    case 'unknown':
      return `Did not understand "${cmd.text}". Try "show Bitcoin", "buy 100", "portfolio"`;
  }
}
