// App-side client for the MarketGlance backend's Telegram companion.
//
// All Telegram traffic goes through our own backend proxy (server/proxy.mjs),
// never from the WebView to Telegram directly: the bot token lives only in
// the proxy's environment, exactly as Even's guidance requires (no keys in
// the app). When the app is NOT served by the proxy (Vite dev, simulator,
// static hosting) every function here quietly no-ops and the Settings screen
// shows "Telegram: run via proxy".

import type { AlertEvent } from './alerts.ts';
import { fmtAlertLong } from './alerts.ts';

export interface TelegramStatus {
  configured: boolean; // a bot token (or mock mode) exists server-side
  mock: boolean; // server runs without a real token: messages go to an outbox
  linked: boolean; // a Telegram chat has paired with this app
  botName?: string;
}

const viaProxy = (): boolean => typeof location !== 'undefined' && location.port === '8787';

async function call(
  fetchFn: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<unknown | null> {
  if (!viaProxy()) return null;
  try {
    const res = await fetchFn(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function tgStatus(fetchFn: typeof fetch = fetch): Promise<TelegramStatus | null> {
  const r = (await call(fetchFn, '/api/telegram/status')) as TelegramStatus | null;
  return r && typeof r.linked === 'boolean' ? r : null;
}

/** Ask the backend for a fresh pairing code (shown on the Settings screen). */
export async function tgPairCode(fetchFn: typeof fetch = fetch): Promise<string | null> {
  const r = (await call(fetchFn, '/api/telegram/pair', { method: 'POST', body: '{}' })) as
    | { code?: string }
    | null;
  return r?.code ?? null;
}

/** Push a fired alert to the paired Telegram chat (fire-and-forget). */
export async function tgNotify(fetchFn: typeof fetch, ev: AlertEvent): Promise<void> {
  await call(fetchFn, '/api/telegram/notify', {
    method: 'POST',
    body: JSON.stringify({ text: fmtAlertLong(ev) }),
  });
}

/** Sync watchlist + threshold so the backend poller watches the same assets. */
export async function tgSyncAlertsConfig(
  fetchFn: typeof fetch,
  cfg: { watchlist: Array<{ id: string; symbol: string; name: string }>; thresholdPct: number },
): Promise<void> {
  await call(fetchFn, '/api/alerts/config', { method: 'POST', body: JSON.stringify(cfg) });
}

/** Push a portfolio snapshot so the bot's /portfolio command can answer. */
export async function tgPushPortfolio(
  fetchFn: typeof fetch,
  snapshot: {
    cash: number;
    totalValue: number;
    realized: number;
    positions: Array<{ symbol: string; qty: number; avgPrice: number; value: number; pnl: number }>;
  },
): Promise<void> {
  await call(fetchFn, '/api/telegram/portfolio', { method: 'POST', body: JSON.stringify(snapshot) });
}
