// MarketGlance — Even Hub (G2) entry point.
//
// Two run modes, same state machine (src/app.ts):
//  1. On the glasses / in the Even Hub simulator: the Even Hub SDK bridge is
//     present; we render native text + list containers on the 576x288 canvas.
//  2. In a plain browser (no bridge): a pixel-faithful preview fallback renders
//     the same screens into the DOM so anyone can try the app without tooling.
//     The preview also hosts the voice-command bar (Web Speech API + a typed
//     command box) — see src/voice.ts for how voice maps onto the same
//     state machine, and the README for the on-device STT path.
//
// When served by server/proxy.mjs (port 8787) the app additionally syncs its
// watchlist to the backend alert poller, pushes fired alerts and portfolio
// snapshots to the Telegram companion, and fetches pairing codes for the
// Settings screen (src/telegram.ts). Off-proxy, all of that no-ops.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk';
import {
  marketsHeader,
  marketsItems,
  detailHeader,
  detailItems,
  positionsHeader,
  positionsItems,
  historyHeader,
  historyItems,
  alertsHeader,
  alertsItems,
  settingsHeader,
  settingsItems,
  select,
  back,
  executeCommand,
  applyAlertCheck,
  alertsOf,
  refreshSecOf,
  marketById,
} from './app.ts';
import type { AppState } from './app.ts';
import { fetchMarkets } from './data.ts';
import { emptyPortfolio, withTrades, totalValue, unrealizedPnl } from './portfolio.ts';
import type { Portfolio } from './portfolio.ts';
import { withAlertDefaults } from './alerts.ts';
import type { AlertState } from './alerts.ts';
import { parseCommand } from './voice.ts';
import { tgStatus, tgPairCode, tgNotify, tgSyncAlertsConfig, tgPushPortfolio } from './telegram.ts';

const PORTFOLIO_KEY = 'marketglance.portfolio.v1';
const ALERTS_KEY = 'marketglance.alerts.v1';
const PREFS_KEY = 'marketglance.prefs.v1';

function loadPortfolio(): Portfolio {
  try {
    const raw = localStorage.getItem(PORTFOLIO_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Portfolio;
      if (typeof p.cash === 'number' && p.positions) return withTrades(p);
    }
  } catch {
    /* storage unavailable -> fresh paper account */
  }
  return emptyPortfolio();
}

function loadAlerts(): AlertState {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    if (raw) return withAlertDefaults(JSON.parse(raw) as Partial<AlertState>);
  } catch {
    /* fall through to defaults */
  }
  return withAlertDefaults(undefined);
}

function loadRefreshSec(): number {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const sec = (JSON.parse(raw) as { refreshSec?: number }).refreshSec;
      if (sec === 30 || sec === 60 || sec === 300) return sec;
    }
  } catch {
    /* defaults below */
  }
  return 60;
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* non-fatal */
  }
}

const state: AppState = {
  markets: [],
  portfolio: loadPortfolio(),
  screen: { kind: 'markets' },
  notice: '',
  updatedAt: '',
  offline: false,
  save: (p) => store(PORTFOLIO_KEY, p),
  alerts: loadAlerts(),
  refreshSec: loadRefreshSec(),
  telegram: { viaProxy: typeof location !== 'undefined' && location.port === '8787' },
  saveAlerts: (a) => store(ALERTS_KEY, a),
  savePrefs: () => store(PREFS_KEY, { refreshSec: state.refreshSec }),
  syncAlerts: () => {
    const a = alertsOf(state);
    void tgSyncAlertsConfig(fetch, {
      watchlist: a.watchlist.map((id) => {
        const m = marketById(state, id);
        return { id, symbol: m?.symbol ?? id.toUpperCase(), name: m?.name ?? id };
      }),
      thresholdPct: a.thresholdPct,
    });
  },
};

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pushPortfolioSnapshot(): void {
  const prices: Record<string, number> = {};
  for (const m of state.markets) prices[m.id] = m.price;
  void tgPushPortfolio(fetch, {
    cash: state.portfolio.cash,
    totalValue: totalValue(state.portfolio, prices),
    realized: state.portfolio.realized,
    positions: Object.values(state.portfolio.positions).map((pos) => {
      const m = marketById(state, pos.id);
      const price = m?.price ?? pos.avgPrice;
      return {
        symbol: m?.symbol ?? pos.id.toUpperCase(),
        qty: pos.qty,
        avgPrice: pos.avgPrice,
        value: pos.qty * price,
        pnl: unrealizedPnl(pos, price),
      };
    }),
  });
}

async function refresh(renderFn: () => void): Promise<void> {
  const r = await fetchMarkets();
  state.markets = r.markets;
  state.offline = r.offline;
  state.updatedAt = nowHHMM();
  if (state.notice === 'Refreshing...') state.notice = 'Updated';
  // Price-move alerts: check the fresh prices against watchlist baselines.
  const fired = applyAlertCheck(state, state.updatedAt);
  for (const ev of fired) void tgNotify(fetch, ev);
  state.syncAlerts?.();
  pushPortfolioSnapshot();
  renderFn();
}

/** Self-rescheduling auto-refresh; the interval follows the Settings value. */
function scheduleAutoRefresh(renderFn: () => void): void {
  setTimeout(() => {
    void refresh(renderFn).finally(() => scheduleAutoRefresh(renderFn));
  }, refreshSecOf(state) * 1000);
}

// ---------- Telegram pairing data for the Settings screen ----------

let tgLoadInFlight = false;
let tgLoadedForVisit = false;

function maybeLoadTelegram(renderFn: () => void): void {
  if (state.screen.kind !== 'settings') {
    tgLoadedForVisit = false;
    return;
  }
  if (!state.telegram?.viaProxy || tgLoadedForVisit || tgLoadInFlight) return;
  tgLoadInFlight = true;
  void (async () => {
    const status = await tgStatus();
    if (status) {
      state.telegram = { viaProxy: true, linked: status.linked, mock: status.mock };
      if (!status.linked) {
        const code = await tgPairCode();
        if (code) state.telegram.pairCode = code;
      }
    }
    tgLoadInFlight = false;
    tgLoadedForVisit = true;
    renderFn();
  })();
}

// ---------- view -> container model ----------

interface View {
  header: string;
  headerHeight: number;
  items: string[];
}

function currentView(): View {
  switch (state.screen.kind) {
    case 'detail':
      return { header: detailHeader(state, state.screen.id), headerHeight: 176, items: detailItems(state, state.screen.id) };
    case 'positions':
      return { header: positionsHeader(state), headerHeight: 118, items: positionsItems(state) };
    case 'history':
      return { header: historyHeader(state), headerHeight: 70, items: historyItems(state) };
    case 'alerts':
      return { header: alertsHeader(state), headerHeight: 118, items: alertsItems(state) };
    case 'settings':
      return { header: settingsHeader(state), headerHeight: 118, items: settingsItems(state) };
    default:
      return { header: marketsHeader(state), headerHeight: 70, items: marketsItems(state) };
  }
}

// ---------- mode 1: real Even Hub bridge ----------

async function runWithBridge(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>): Promise<void> {
  const HEADER_ID = 1;
  const LIST_ID = 2;

  function containers() {
    const v = currentView();
    const header = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: v.headerHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: HEADER_ID,
      containerName: 'header',
      content: v.header,
      isEventCapture: 0,
    });
    const list = new ListContainerProperty({
      xPosition: 0,
      yPosition: v.headerHeight,
      width: 576,
      height: 288 - v.headerHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: LIST_ID,
      containerName: 'menu',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: v.items.length,
        itemWidth: 0,
        isItemSelectBorderEn: 1,
        itemName: v.items,
      }),
    });
    return { header, list };
  }

  let started = false;
  async function render(): Promise<void> {
    maybeLoadTelegram(() => void render());
    const { header, list } = containers();
    if (!started) {
      const res = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [header], listObject: [list] }),
      );
      if (res !== StartUpPageCreateResult.success) {
        console.error('createStartUpPageContainer failed:', res); // 1=invalid, 2=oversize, 3=out of memory
      }
      started = true;
    } else {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: 2, textObject: [header], listObject: [list] }),
      );
    }
  }

  bridge.onEvenHubEvent((event) => {
    const listEvent = event.listEvent;
    if (!listEvent || listEvent.containerID !== LIST_ID) return;
    if (listEvent.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (!back(state)) {
        // Root page: mode 1 shows the system exit-confirmation dialog (required).
        void bridge.shutDownPageContainer(1);
      } else {
        void render();
      }
      return;
    }
    // CLICK_EVENT (the SDK sometimes normalizes click to undefined).
    if (listEvent.eventType === OsEventTypeList.CLICK_EVENT || listEvent.eventType === undefined) {
      const idx = listEvent.currentSelectItemIndex ?? 0;
      select(state, idx);
      if (state.notice === 'Refreshing...') {
        void refresh(() => void render());
      }
      void render();
    }
  });

  await refresh(() => void render());
  scheduleAutoRefresh(() => void render());
}

// ---------- mode 2: plain-browser preview ----------

function runPreview(): void {
  const root = document.getElementById('preview');
  const headerEl = document.getElementById('g2header');
  const itemsEl = document.getElementById('g2items');
  const canvas = document.getElementById('g2canvas');
  if (!root || !headerEl || !itemsEl || !canvas) return;
  root.style.display = 'block';

  function render(): void {
    maybeLoadTelegram(render);
    const v = currentView();
    headerEl!.textContent = v.header;
    itemsEl!.innerHTML = '';
    v.items.forEach((label, i) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.textContent = `› ${label}`;
      div.addEventListener('click', () => {
        select(state, i);
        if (state.notice === 'Refreshing...') void refresh(render);
        render();
      });
      itemsEl!.appendChild(div);
    });
  }

  canvas.addEventListener('dblclick', () => {
    if (!back(state)) state.notice = 'Exit requested (glasses show a confirm dialog)';
    render();
  });

  wireVoiceBar(render);

  void refresh(render);
  scheduleAutoRefresh(render);
}

// ---------- voice bar (preview only) ----------

/**
 * Voice commands in the preview: the Web Speech API supplies transcripts in
 * the browser; a typed command box covers browsers without it (and makes the
 * demo deterministic). Both feed parseCommand -> executeCommand, the same
 * path a server-side STT transcript takes on real hardware.
 */
function wireVoiceBar(render: () => void): void {
  const line = document.getElementById('voiceline');
  const input = document.getElementById('cmdinput') as HTMLInputElement | null;
  const goBtn = document.getElementById('cmdgo');
  const micBtn = document.getElementById('micbtn') as HTMLButtonElement | null;
  if (!line || !input || !goBtn) return;

  function runText(text: string): void {
    const cmd = parseCommand(text);
    const response = executeCommand(state, cmd);
    line!.textContent = `"${text}" -> ${response}`;
    if (state.notice === 'Refreshing...') void refresh(render);
    render();
  }

  goBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (text) runText(text);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') goBtn.click();
  });

  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor || !micBtn) {
    if (micBtn) {
      micBtn.disabled = true;
      micBtn.textContent = 'Speak (not supported in this browser — type instead)';
    }
    return;
  }
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.addEventListener('result', (e: SpeechRecognitionEventLike) => {
    const text = e.results?.[0]?.[0]?.transcript ?? '';
    if (text) runText(text);
  });
  rec.addEventListener('error', () => {
    line.textContent = 'Voice input failed — type a command instead.';
  });
  micBtn.addEventListener('click', () => {
    line.textContent = 'Listening… try "buy 100 of Bitcoin"';
    rec.start();
  });
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  start: () => void;
  addEventListener: (type: string, cb: (e: SpeechRecognitionEventLike) => void) => void;
}

interface SpeechRecognitionEventLike {
  results?: Array<Array<{ transcript: string }>>;
}

// ---------- boot ----------

async function boot(): Promise<void> {
  let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>> | undefined;
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ]);
  } catch {
    bridge = undefined;
  }
  if (bridge) {
    await runWithBridge(bridge);
  } else {
    runPreview();
  }
}

void boot();
