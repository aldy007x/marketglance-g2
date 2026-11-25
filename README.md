# MarketGlance — markets in your field of view, action in one tap

**Heads Up: Even Realities Hackathon — Track 02 · Crypto & DeFi**
Apps used (both listed in Track 02): **CoinGecko** and **Polymarket**.
Plus a **Telegram companion bot** (special-prize category: Best Telegram integration).

## The problem

Checking prices means pulling out your phone — in a meeting, on a walk, mid-conversation.
Prediction-market odds are even worse: three apps deep before you see a single number.
And when you do want to act, it's another unlock, another app, another login. Meanwhile
the move you cared about already happened — nobody watches a chart all day.

## Who it is for

Crypto holders and prediction-market watchers who want a *glance*, not a dashboard:
what's BTC doing, what does the market think happens next, a heads-up when something
moves — and, if they want, a small paper position opened or closed before the
moment passes.

## How it works

MarketGlance is an Even Hub app for the Even G2 glasses (576 × 288 monochrome display):

- **Read (glance):** a native list shows live CoinGecko prices + 24h change for
  BTC, ETH, SOL, LINK, AVAX and DOGE. Opening an asset shows its detail card,
  including the top matching **Polymarket** market and its live YES price
  (e.g. *"Will Bitcoin dip to $55,000 by Dec 31?" — YES 63¢*).
- **Write (one tap):** from the detail card, buy $100 / $500 of **paper** crypto or
  sell your whole paper position with a single tap (temple tap or R1 ring click).
  A dedicated **Portfolio** screen tracks every holding (quantity, average price,
  current value, unrealized PnL), cash, total value and realized PnL; a **Trade
  history** screen lists every paper trade. The portfolio persists between sessions.
- **Alerts (watchlist):** tap **Watch** on any asset and MarketGlance watches it
  for you. When a watched asset moves ≥ your threshold (1 / 3 / 5 / 10%, set in
  **Settings**), an alert fires on the glasses — and is **pushed to Telegram** by
  the backend, which keeps polling even while the glasses app is closed. One
  alert per move (the baseline resets), so no spam.
- **Telegram companion:** pair once from the glasses Settings screen (send
  `/start <code>` to the bot) and then ask your bot from anywhere:
  `/price BTC`, `/portfolio`, `/alerts`. Alerts arrive as Telegram messages —
  your phone buzzes even with the glasses in their case.
- **Voice:** in the browser preview, speak or type commands — *"show Bitcoin"*,
  *"buy one hundred of Bitcoin"*, *"watch Solana"*, *"portfolio"* — parsed by a
  unit-tested command parser and executed through the **same state machine** as
  taps (with smart defaults: "buy Bitcoin" means the $100 quick-buy). See
  "Voice on real hardware" below for the on-device path.
- **Controls:** scroll with the ring / touch, tap to select, double-tap to go back
  (double-tap on the home screen opens the system exit confirmation, per Even Hub QA rules).

Everything is designed for the glance: one list, short lines (≤64 chars, the G2 list
limit), one action per screen, no dashboards.

## Architecture

```
G2 glasses  <—BLE—>  Even App WebView (this app)  ——>  CoinGecko public API (prices)
                                                  ——>  Polymarket Gamma API (odds)
                             |
                             └— your backend (server/proxy.mjs) serves the app
                                and /api/* routes, and hosts:
                                  · Telegram bot service (pairing, commands,
                                    alert push) — token only in its env
                                  · server-side alert poller (60s): fires
                                    Telegram alerts while the app is closed
                                  · /api/stt plug point for mic transcription
```

- `src/main.ts` — Even Hub SDK wiring: native text + list containers, event routing,
  auto-refresh, alert firing + Telegram sync. Falls back to a faithful **browser
  preview** (green 576 × 288 canvas, click = tap, voice bar) when no SDK bridge
  is present, so anyone can try it without tooling.
- `src/app.ts` — screen state machine + view models (markets, detail, portfolio,
  history, alerts, settings) shared by glasses and preview; voice commands execute
  here too, through the same transitions as taps.
- `src/data.ts` — CoinGecko + Polymarket fetchers; whole-word keyword matching for
  odds; labelled offline sample snapshot if the network is unreachable.
- `src/portfolio.ts` — paper-trading portfolio incl. full trade history (pure logic, unit-tested).
- `src/alerts.ts` — watchlist + price-move alert engine (pure logic, unit-tested);
  the **same module** runs in the app and in the backend poller.
- `src/voice.ts` — voice command parser (pure logic, unit-tested).
- `src/telegram.ts` — app-side client for the backend's Telegram endpoints.
- `server/proxy.mjs` — zero-dependency Node server: static hosting + API proxy +
  Telegram service + alert poller + STT stub.
- `server/telegram.mjs` — the Telegram companion service (pairing, commands, mock mode).
- `app.json` — Even Hub manifest; both API domains are whitelisted under the
  `network` permission. **No API keys exist anywhere in the app** (both market
  APIs are keyless and read-only; the Telegram bot token lives only in the
  backend's environment).

## Setup

Prerequisites: Node.js 20 LTS or 22+, npm. For the simulator: the Even Hub tools
(they are also in `devDependencies`, so `npx` works after install).

```bash
npm install

# Option A — browser preview (no tooling needed; includes the voice bar)
npm run dev            # open http://localhost:5173, click lines to "tap"

# Option B — Even Hub simulator (recommended for the real G2 UI)
npm run dev            # terminal 1
npm run sim            # terminal 2: evenhub-simulator http://localhost:5173

# Option C — full stack through the backend proxy (Telegram + server alerts)
npm run build
npm run proxy          # http://localhost:8787 (app auto-uses /api/* routes)

# Tests (portfolio math, trade history, alert engine, voice parser, screens,
# Telegram companion in mock mode — no network, no bot needed)
npm test

# Package an .ehpk (optional submission extra)
npm run pack
```

On real G2 hardware: run `npm run dev`, then `npx evenhub qr --url "http://<LAN-IP>:5173"`
and scan the QR code from the Even Realities App (Developer Mode enabled).

## Telegram companion

The bot is how alerts reach you when the glasses are off. Two modes:

**Mock mode (no bot, for demos and tests)** — just run `npm run proxy`. Pairing
codes, commands and alerts all work; "sent" messages collect in an in-memory
outbox you can inspect at `http://localhost:8787/api/telegram/outbox`, and you
can inject fake Telegram messages at `POST /api/telegram/webhook`
(e.g. `{"message":{"chat":{"id":1},"text":"/start 123456"}}`).

**Real mode** — create a bot with @BotFather (2 minutes, see the submission
pack), then:

```bash
TELEGRAM_BOT_TOKEN=<your-token> npm run proxy
```

Pairing: in the glasses app open **Settings → Telegram pairing**, then send
`/start <code>` to your bot in Telegram. Codes expire after 10 minutes and pair
exactly one chat. Commands: `/price BTC` (live CoinGecko price), `/portfolio`
(last snapshot the app synced), `/alerts` (recent fired alerts), `/stop`
(unlink). The backend poller checks watched assets every 60 s against the
watchlist + threshold synced from the app, and pushes alerts to paired chats.

## Voice on real hardware

The G2 microphone gives the app **raw PCM audio only — speech-to-text is
bring-your-own** on this platform. MarketGlance's split:

- The **command parser is real and shared** (`src/voice.ts`): whatever produces
  the transcript, the same parser + executor drive the app.
- In the **browser preview / simulator demo**, the Web Speech API
  (`webkitSpeechRecognition`) produces the transcript (the simulator cannot
  record audio, so voice is demoed in the preview).
- On **hardware**, audio is streamed to the backend's `POST /api/stt`
  endpoint, which is the documented plug point for an STT provider
  (e.g. Whisper): forward the audio, return `{ "text": "…" }`, and the app
  executes it identically. Until a provider is configured the endpoint
  answers `501` with setup guidance — it never pretends to transcribe.

## Safety & rules compliance

- **Paper trading only.** No real orders, no wallets, no custody, no user funds —
  exactly what the hackathon's money-safety rule requires. Alerts never suggest
  trades; they report price moves, nothing more (no financial advice).
- Read-only public APIs; no keys in the app or the repo (the Telegram token is
  env-only on the backend); prices and odds are displayed as-is from
  CoinGecko / Polymarket.

## What existed before Nov 23

Per the hackathon rules, an honest disclosure:

- The Even Hub SDK, CLI, simulator, official docs and the CoinGecko / Polymarket
  public APIs are pre-existing public artifacts by their respective authors.
- **This project's initial prototype** — project scaffold, screen state machine,
  data fetchers, paper portfolio and this README — was drafted on **Nov 21–22, 2026**
  as pre-hackathon preparation (Step-0 research + a working first version), i.e.
  before the Nov 23 build-week start.
- **A first upgrade pass was also drafted Nov 21–22 as preparation:** the
  watchlist + alert engine, the Telegram companion (bot service, pairing,
  server-side poller), the trade-history and settings screens, and the voice
  command parser with its browser-preview wiring.
- Everything above is the starting point committed here; **all final
  development, testing and polish happens inside the build week (Nov 23–29)**,
  including running the full stack on real infrastructure, the demo video,
  and any fixes from those runs.

## Roadmap

- Hyperliquid **testnet** orders as an alternative write path.
- More Polymarket categories per asset + a "biggest movers" glance screen.
- Kalshi odds alongside Polymarket (also Track 02).
