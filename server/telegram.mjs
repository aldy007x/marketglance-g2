// MarketGlance Telegram companion service (zero dependencies).
//
// Used by server/proxy.mjs. The bot token comes ONLY from the environment
// (TELEGRAM_BOT_TOKEN) — it is never in the app, the repo, or any response.
//
// Modes:
//   - Real mode (token set): talks to api.telegram.org. The proxy polls
//     getUpdates and forwards price alerts to paired chats.
//   - Mock mode (no token): the full pairing/command/alert flow still works;
//     "sent" messages land in an in-memory outbox (GET /api/telegram/outbox)
//     and updates can be injected at POST /api/telegram/webhook. This is how
//     the whole companion is demoed and unit-tested without a real bot.
//
// Commands (after pairing): /price BTC · /portfolio · /alerts · /help · /stop
// Pairing: the glasses app shows a 6-digit code (Settings screen); the user
// sends "/start <code>" to the bot. One code pairs one chat; codes expire
// after 10 minutes. This keeps the WebView free of any Telegram login
// (Google-style sign-in does not work inside the Even WebView anyway).

import { checkAlerts, emptyAlertState, fmtAlertLong } from '../src/alerts.ts';
import { ASSETS } from '../src/data.ts';

const PAIR_TTL_MS = 10 * 60 * 1000;

const fmtUsd = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSigned = (n) => `${n >= 0 ? '+' : '-'}$${fmtUsd(Math.abs(n))}`;

export function createTelegramService({ token, fetchFn = fetch, nowFn = () => Date.now() }) {
  const mock = !token;
  const chats = new Map(); // chatId -> { linkedAt }
  const pairCodes = new Map(); // code -> expiresAt ms
  const outbox = []; // mock mode: { chatId, text }
  let portfolio = null; // last snapshot pushed by the app
  let alertState = emptyAlertState(); // server-side copy for the poller
  let alertAssets = new Map(); // id -> { symbol, name } for the poller
  let updateOffset = 0;

  async function api(method, body) {
    if (mock) {
      if (method === 'sendMessage') outbox.push({ chatId: body.chat_id, text: body.text });
      return { ok: true, result: true };
    }
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function send(chatId, text) {
    await api('sendMessage', { chat_id: chatId, text });
  }

  async function broadcast(text) {
    let n = 0;
    for (const chatId of chats.keys()) {
      await send(chatId, text);
      n += 1;
    }
    return n;
  }

  function createPairCode() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pairCodes.set(code, nowFn() + PAIR_TTL_MS);
    return code;
  }

  function tryPair(chatId, code) {
    const exp = pairCodes.get(code);
    if (exp === undefined || exp < nowFn()) {
      pairCodes.delete(code);
      return false;
    }
    pairCodes.delete(code);
    chats.set(chatId, { linkedAt: nowFn() });
    return true;
  }

  // priceFn: async (ids: string[]) => Record<id, number>
  async function handleCommand(chatId, text, priceFn) {
    const [cmd, arg] = text.trim().split(/\s+/, 2);
    if (cmd === '/start') {
      if (arg && tryPair(chatId, arg)) {
        await send(
          chatId,
          'MarketGlance linked. You will get paper price alerts here.\n' +
            'Commands: /price BTC · /portfolio · /alerts · /stop',
        );
      } else {
        await send(chatId, 'That pairing code is invalid or expired. Open MarketGlance → Settings → Telegram pairing for a fresh code.');
      }
      return;
    }
    if (!chats.has(chatId)) {
      await send(chatId, 'This chat is not linked yet. Open MarketGlance → Settings → Telegram pairing, then send /start <code>.');
      return;
    }
    if (cmd === '/stop') {
      chats.delete(chatId);
      await send(chatId, 'Unlinked. Alerts stopped. Pair again from MarketGlance Settings any time.');
      return;
    }
    if (cmd === '/price') {
      const sym = (arg ?? 'BTC').toUpperCase();
      const asset = ASSETS.find((a) => a.symbol === sym);
      if (!asset) {
        await send(chatId, `Unknown asset "${sym}". Try: ${ASSETS.map((a) => a.symbol).join(', ')}`);
        return;
      }
      const prices = priceFn ? await priceFn([asset.id]) : {};
      const p = prices[asset.id];
      await send(chatId, p ? `${asset.name} (${sym}): $${p.toLocaleString('en-US')} (CoinGecko, live)` : `${sym}: price unavailable right now.`);
      return;
    }
    if (cmd === '/portfolio') {
      if (!portfolio) {
        await send(chatId, 'No portfolio snapshot yet — open MarketGlance once so it can sync. (Paper portfolio only.)');
        return;
      }
      const lines = [
        `Paper portfolio: $${fmtUsd(portfolio.totalValue)} (realized ${fmtSigned(portfolio.realized)})`,
        `Cash: $${fmtUsd(portfolio.cash)}`,
        ...portfolio.positions.map(
          (p) => `${p.symbol}: ${p.qty} @ $${p.avgPrice} = $${fmtUsd(p.value)} (${fmtSigned(p.pnl)})`,
        ),
      ];
      await send(chatId, lines.join('\n'));
      return;
    }
    if (cmd === '/alerts') {
      const h = alertState.history.slice(0, 5);
      await send(
        chatId,
        h.length
          ? 'Recent paper alerts:\n' + h.map((e) => fmtAlertLong(e)).join('\n')
          : 'No alerts yet. Alerts fire when a watched asset moves past the threshold set in MarketGlance.',
      );
      return;
    }
    await send(chatId, 'Commands: /price BTC · /portfolio · /alerts · /stop');
  }

  async function handleUpdate(update, priceFn) {
    const msg = update?.message;
    if (!msg || typeof msg.text !== 'string' || msg.chat?.id === undefined) return;
    await handleCommand(msg.chat.id, msg.text, priceFn);
  }

  /** Long-poll one batch of updates (real mode; proxy calls this on a timer). */
  async function pollUpdates(priceFn) {
    if (mock) return 0;
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset: updateOffset, timeout: 0, allowed_updates: ['message'] }),
    });
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.result)) return 0;
    for (const u of data.result) {
      updateOffset = Math.max(updateOffset, u.update_id + 1);
      await handleUpdate(u, priceFn);
    }
    return data.result.length;
  }

  /**
   * Server-side alert check: fetch watched prices and alert paired chats.
   * Runs on the proxy's timer so alerts fire even with the glasses app shut.
   */
  async function pollAlerts(priceFn, atHHMM) {
    if (!alertState.watchlist.length || !priceFn) return [];
    const prices = await priceFn(alertState.watchlist);
    const markets = alertState.watchlist
      .filter((id) => prices[id] > 0)
      .map((id) => {
        const meta = alertAssets.get(id) ?? { symbol: id.toUpperCase(), name: id };
        return { id, symbol: meta.symbol, name: meta.name, price: prices[id], change24h: 0 };
      });
    const fired = checkAlerts(alertState, markets, atHHMM);
    for (const ev of fired) await broadcast(`ALERT: ${fmtAlertLong(ev)}`);
    return fired;
  }

  function setAlertsConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.watchlist)) return false;
    alertAssets = new Map(cfg.watchlist.map((w) => [w.id, { symbol: w.symbol, name: w.name }]));
    alertState = {
      ...alertState,
      watchlist: cfg.watchlist.map((w) => w.id),
      thresholdPct: typeof cfg.thresholdPct === 'number' ? cfg.thresholdPct : alertState.thresholdPct,
    };
    return true;
  }

  // ---------- HTTP routes used by the app (mounted by proxy.mjs) ----------

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return {};
    }
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  /** Returns true when the request was a Telegram/alerts route. */
  async function handleRoute(req, res, url, priceFn) {
    const p = url.pathname;
    if (p === '/api/telegram/status') {
      json(res, 200, { configured: true, mock, linked: chats.size > 0 });
      return true;
    }
    if (p === '/api/telegram/pair' && req.method === 'POST') {
      json(res, 200, { code: createPairCode() });
      return true;
    }
    if (p === '/api/telegram/notify' && req.method === 'POST') {
      const body = await readJson(req);
      const sent = typeof body.text === 'string' && body.text ? await broadcast(body.text) : 0;
      json(res, 200, { sent });
      return true;
    }
    if (p === '/api/telegram/portfolio' && req.method === 'POST') {
      portfolio = await readJson(req);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/telegram/outbox') {
      json(res, 200, { messages: outbox });
      return true;
    }
    if (p === '/api/telegram/webhook' && req.method === 'POST') {
      // Demo/testing hook (mock mode): inject a Telegram update without a bot.
      await handleUpdate(await readJson(req), priceFn);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/alerts/config' && req.method === 'POST') {
      json(res, 200, { ok: setAlertsConfig(await readJson(req)) });
      return true;
    }
    if (p === '/api/alerts/history') {
      json(res, 200, { history: alertState.history });
      return true;
    }
    return false;
  }

  return {
    mock,
    outbox,
    chats,
    createPairCode,
    tryPair,
    handleUpdate,
    pollUpdates,
    pollAlerts,
    setAlertsConfig,
    handleRoute,
    getPortfolio: () => portfolio,
    getAlertState: () => alertState,
    broadcast,
  };
}
