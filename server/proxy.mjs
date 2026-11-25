// MarketGlance backend proxy (zero dependencies, plain Node http).
//
// Why this exists: Even Realities' guidance is to route third-party API calls
// through your own server instead of calling them from the WebView with keys
// embedded. CoinGecko and Polymarket are keyless, but the proxy still earns
// its keep: it sidesteps WebView CORS quirks and gives one place to add
// caching / an API key later.
//
// On top of static hosting + API proxying it now hosts the companions:
//   - Telegram bot service (server/telegram.mjs): pairing, /price,
//     /portfolio, /alerts, and a server-side alert poller that pushes price
//     alerts to Telegram even while the glasses app is closed.
//     Token (real mode):  TELEGRAM_BOT_TOKEN=<token> npm run proxy
//     No token: mock mode — the full flow works against an in-memory outbox
//     (GET /api/telegram/outbox), updates injectable at
//     POST /api/telegram/webhook. See README "Telegram companion".
//   - /api/stt: speech-to-text endpoint for the G2 microphone path. STT is
//     DIY on this platform (the SDK gives raw PCM); this is the documented
//     plug point for a provider (e.g. Whisper). Until one is configured it
//     answers 501 with setup guidance instead of pretending to transcribe.
//
//   npm run build   # produces dist/
//   npm run proxy   # serves dist/ + /api/* on http://localhost:8787
//
// The app detects port 8787 and switches to the relative /api/* routes
// (see src/data.ts). Both upstreams are public, read-only, keyless GETs.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTelegramService } from './telegram.mjs';
import { ASSETS } from '../src/data.ts';

const PORT = 8787;
const ROOT = fileURLToPath(new URL('../dist', import.meta.url));

const UPSTREAMS = {
  '/api/coingecko/': 'https://api.coingecko.com/',
  '/api/polymarket/': 'https://gamma-api.polymarket.com/',
};

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Live prices for the Telegram service + alert poller (CoinGecko, keyless). */
async function fetchPrices(ids) {
  if (!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const res = await fetch(url, { headers: { 'user-agent': 'MarketGlance/0.2 (hackathon demo)' } });
  if (!res.ok) return {};
  const body = await res.json();
  const out = {};
  for (const id of ids) if (body[id]?.usd > 0) out[id] = body[id].usd;
  return out;
}

const telegram = createTelegramService({ token: process.env.TELEGRAM_BOT_TOKEN || undefined });

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Server-side companions: poll Telegram updates + watched prices so alerts
// reach the user's phone even when the glasses app is not open.
setInterval(() => {
  void telegram.pollUpdates(fetchPrices).catch(() => {});
}, 25_000);
setInterval(() => {
  void telegram.pollAlerts(fetchPrices, nowHHMM()).catch(() => {});
}, 60_000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Telegram companion + alerts API (handled by server/telegram.mjs)
  if (url.pathname.startsWith('/api/telegram/') || url.pathname.startsWith('/api/alerts/')) {
    if (await telegram.handleRoute(req, res, url, fetchPrices)) return;
  }

  // Speech-to-text plug point for the G2 microphone path (see header note).
  if (url.pathname === '/api/stt') {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'STT provider not configured',
        hint:
          'The G2 SDK provides raw microphone PCM; speech-to-text is bring-your-own. ' +
          'POST audio here and forward it to your STT provider (e.g. Whisper), then return { text }. ' +
          'Until then, voice commands work in the browser preview via the Web Speech API.',
      }),
    );
    return;
  }

  for (const [prefix, base] of Object.entries(UPSTREAMS)) {
    if (url.pathname.startsWith(prefix)) {
      const target = base + url.pathname.slice(prefix.length) + url.search;
      try {
        const upstream = await fetch(target, { headers: { 'user-agent': 'MarketGlance/0.2 (hackathon demo)' } });
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(body);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream fetch failed', detail: String(err) }));
      }
      return;
    }
  }

  // Static files from dist/
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. Did you run `npm run build` first?');
  }
});

server.listen(PORT, () => {
  console.log(`MarketGlance proxy on http://localhost:${PORT} (serving dist/ + /api/*)`);
  console.log(
    telegram.mock
      ? 'Telegram companion: MOCK mode (no TELEGRAM_BOT_TOKEN) — outbox at /api/telegram/outbox'
      : 'Telegram companion: live bot polling enabled',
  );
  console.log(`Assets tracked: ${ASSETS.map((a) => a.symbol).join(', ')}`);
});
