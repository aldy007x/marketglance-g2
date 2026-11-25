// Smoke tests for MarketGlance core logic.
// Runs the real TypeScript modules via Node's native type stripping:
//   npm test        (or: node test/smoke.mjs)
// No network needed: fetch is stubbed.

import assert from 'node:assert/strict';
import { emptyPortfolio, buy, sellAll, totalValue, START_CASH } from '../src/portfolio.ts';
import { parseYesPrice, matchPolymarket, fetchMarkets, SAMPLE_MARKETS } from '../src/data.ts';
import * as app from '../src/app.ts';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// ---------- portfolio ----------
ok('buy creates a position and spends cash', () => {
  const p = emptyPortfolio();
  const r = buy(p, 'bitcoin', 50_000, 100);
  assert.equal(r.ok, true);
  assert.equal(p.cash, START_CASH - 100);
  assert.equal(p.positions.bitcoin.qty, 0.002);
  assert.equal(p.positions.bitcoin.avgPrice, 50_000);
});

ok('second buy averages the price; sellAll realizes PnL', () => {
  const p = emptyPortfolio();
  buy(p, 'bitcoin', 50_000, 100);
  buy(p, 'bitcoin', 40_000, 100);
  assert.ok(Math.abs(p.positions.bitcoin.avgPrice - 44_444.44) < 0.01);
  const r = sellAll(p, 'bitcoin', 60_000);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(p.realized - 70) < 0.01, `realized=${p.realized}`);
  assert.ok(Math.abs(p.cash - (START_CASH - 200 + 270)) < 0.01);
  assert.equal(p.positions.bitcoin, undefined);
});

ok('buy beyond cash and sell with no position are rejected', () => {
  const p = emptyPortfolio();
  assert.equal(buy(p, 'bitcoin', 50_000, START_CASH + 1).ok, false);
  assert.equal(sellAll(p, 'bitcoin', 50_000).ok, false);
  assert.equal(totalValue(p, {}), START_CASH);
});

// ---------- data parsing ----------
ok('parseYesPrice parses Polymarket outcomePrices', () => {
  assert.equal(parseYesPrice('["0.63", "0.37"]'), 0.63);
  assert.equal(parseYesPrice('not json'), undefined);
  assert.equal(parseYesPrice('[]'), undefined);
});

ok('matchPolymarket finds the highest-volume keyword match', () => {
  const markets = [
    { question: 'Will Ethereum flip Bitcoin?', outcomePrices: '["0.05","0.95"]', volume24hr: 10 },
    { question: 'Bitcoin above $100k this year?', outcomePrices: '["0.71","0.29"]', volume24hr: 99 },
  ];
  const hit = matchPolymarket(markets, ['bitcoin', 'btc']);
  assert.equal(hit.question, 'Will Ethereum flip Bitcoin?'); // first in list = highest volume order
  assert.equal(hit.yes, 0.05);
  assert.equal(matchPolymarket(markets, ['solana', 'sol']), undefined);
});

ok('fetchMarkets parses CoinGecko rows (stubbed fetch)', async () => {
  // note: fetchMarkets is async; wrap assertions in a promise chain below
});

const cgBody = {
  bitcoin: { usd: 100_000, usd_24h_change: 2.5 },
  ethereum: { usd: 3_500, usd_24h_change: -1.0 },
  solana: { usd: 200, usd_24h_change: 0.5 },
  chainlink: { usd: 20, usd_24h_change: 0 },
  'avalanche-2': { usd: 40, usd_24h_change: 0 },
  dogecoin: { usd: 0.2, usd_24h_change: 0 },
};
const stubOk = async (url) =>
  url.includes('coingecko') || url.includes('/api/coingecko')
    ? { ok: true, status: 200, json: async () => cgBody }
    : { ok: true, status: 200, json: async () => [{ question: 'Will Bitcoin hit $150k?', outcomePrices: '["0.4","0.6"]', volume24hr: 5 }] };
const stubFail = async () => {
  throw new Error('network down');
};

const live = await fetchMarkets(stubOk);
assert.equal(live.offline, false);
assert.equal(live.markets.length, 6);
assert.equal(live.markets[0].price, 100_000);
assert.equal(live.markets[0].pmYes, 0.4);
passed += 1;
console.log('PASS fetchMarkets live-parse (stubbed)');

const off = await fetchMarkets(stubFail);
assert.equal(off.offline, true);
assert.equal(off.markets.length, SAMPLE_MARKETS.length);
passed += 1;
console.log('PASS fetchMarkets falls back to labelled sample when offline');

// ---------- state machine ----------
function freshState() {
  return {
    markets: structuredClone(SAMPLE_MARKETS),
    portfolio: emptyPortfolio(),
    screen: { kind: 'markets' },
    notice: '',
    updatedAt: '09:41',
    offline: true,
    save: () => {},
  };
}

ok('navigation: markets -> detail -> buy -> positions -> detail -> back', () => {
  const s = freshState();
  app.select(s, 0); // first market
  assert.equal(s.screen.kind, 'detail');
  assert.equal(s.screen.id, 'bitcoin');
  app.select(s, 0); // Buy $100 paper
  assert.ok(s.portfolio.positions.bitcoin, 'position created');
  assert.match(s.notice, /Bought/);
  assert.equal(app.back(s), true);
  assert.equal(s.screen.kind, 'markets');
  const posIdx = app.marketsItems(s).findIndex((i) => i.startsWith('My positions'));
  app.select(s, posIdx);
  assert.equal(s.screen.kind, 'positions');
  app.select(s, 0); // open the position
  assert.equal(s.screen.kind, 'detail');
  app.select(s, 3); // Back to markets
  assert.equal(s.screen.kind, 'markets');
  assert.equal(app.back(s), false); // at root -> caller exits
});

ok('every list item fits the 64-char G2 list limit on all screens', () => {
  const s = freshState();
  const check = (items) => items.forEach((i) => assert.ok(i.length <= 64, `too long (${i.length}): ${i}`));
  check(app.marketsItems(s));
  s.screen = { kind: 'detail', id: 'bitcoin' };
  check(app.detailItems(s, 'bitcoin'));
  app.select(s, 0); // buy so positions screen has a row
  s.screen = { kind: 'positions' };
  check(app.positionsItems(s));
  // headers must fit the 1000-char startup/rebuild text limit
  assert.ok(app.marketsHeader(s).length <= 1000);
  assert.ok(app.detailHeader(s, 'bitcoin').length <= 1000);
  assert.ok(app.positionsHeader(s).length <= 1000);
});

// ---------- upgrade: trade history ----------
import { emptyAlertState, checkAlerts, toggleWatch, cycleThreshold, fmtAlert } from '../src/alerts.ts';
import { parseCommand } from '../src/voice.ts';
import { createTelegramService } from '../server/telegram.mjs';

ok('trades are recorded with side, price and realized PnL', () => {
  const p = emptyPortfolio();
  buy(p, 'bitcoin', 50_000, 100, '09:41');
  buy(p, 'bitcoin', 50_000, 100, '09:42');
  sellAll(p, 'bitcoin', 60_000, '09:43');
  assert.equal(p.trades.length, 3);
  assert.equal(p.trades[0].side, 'buy');
  assert.equal(p.trades[0].at, '09:41');
  assert.equal(p.trades[2].side, 'sell');
  assert.ok(Math.abs(p.trades[2].pnl - 40) < 0.01, `pnl=${p.trades[2].pnl}`);
  // portfolios saved by the pre-upgrade version (no trades) still load
  const legacy = { cash: 5, positions: {}, realized: 0 };
  buy(legacy, 'bitcoin', 10, 5);
  assert.equal(legacy.trades.length, 1);
});

// ---------- upgrade: alert engine ----------
ok('alert engine: baseline, threshold, fire-once, baseline reset', () => {
  const a = emptyAlertState(['bitcoin']);
  const mkt = (price) => [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price, change24h: 0 }];
  assert.equal(checkAlerts(a, mkt(100), '10:00').length, 0); // first sight = baseline
  assert.equal(checkAlerts(a, mkt(102), '10:01').length, 0); // +2% < 3% threshold
  const fired = checkAlerts(a, mkt(104), '10:02'); // +4% from baseline 100
  assert.equal(fired.length, 1);
  assert.equal(fired[0].from, 100);
  assert.equal(fired[0].to, 104);
  assert.equal(checkAlerts(a, mkt(105), '10:03').length, 0); // baseline reset to 104
  assert.equal(checkAlerts(a, mkt(100), '10:04').length, 1); // -3.8% from 104 fires
  assert.equal(a.history.length, 2);
  assert.ok(fmtAlert(a.history[0]).length <= 64);
});

ok('alert engine: unwatched assets never fire; threshold cycles', () => {
  const a = emptyAlertState(['bitcoin']);
  const mkt = (id, price) => [{ id, symbol: 'X', name: 'X', price, change24h: 0 }];
  checkAlerts(a, mkt('ethereum', 100), '10:00');
  assert.equal(checkAlerts(a, mkt('ethereum', 200), '10:01').length, 0);
  toggleWatch(a, 'bitcoin');
  checkAlerts(a, mkt('bitcoin', 100), '10:02');
  assert.equal(checkAlerts(a, mkt('bitcoin', 200), '10:03').length, 0);
  assert.equal(cycleThreshold(a), 5);
  assert.equal(cycleThreshold(a), 10);
  assert.equal(cycleThreshold(a), 1);
  assert.deepEqual(a.baselines, {}); // re-baselines after a sensitivity change
});

// ---------- upgrade: voice parsing ----------
ok('voice parser: navigation, trades, watch, screens, unknown', () => {
  assert.deepEqual(parseCommand('show Bitcoin'), { type: 'open', id: 'bitcoin' });
  assert.deepEqual(parseCommand('Ethereum'), { type: 'open', id: 'ethereum' });
  assert.deepEqual(parseCommand('buy $500 of Ethereum'), { type: 'buy', usd: 500, id: 'ethereum' });
  assert.deepEqual(parseCommand('buy one hundred of Bitcoin'), { type: 'buy', usd: 100, id: 'bitcoin' });
  assert.deepEqual(parseCommand('buy Bitcoin'), { type: 'buy', usd: 100, id: 'bitcoin' }); // smart default
  assert.deepEqual(parseCommand('buy 250'), { type: 'buy', usd: 250, id: undefined });
  assert.deepEqual(parseCommand('sell all'), { type: 'sellAll', id: undefined });
  assert.deepEqual(parseCommand('portfolio'), { type: 'screen', screen: 'positions' });
  assert.deepEqual(parseCommand('trade history'), { type: 'screen', screen: 'history' });
  assert.deepEqual(parseCommand('watch Solana'), { type: 'watch', id: 'solana', on: true });
  assert.deepEqual(parseCommand('unwatch Solana'), { type: 'watch', id: 'solana', on: false });
  assert.deepEqual(parseCommand('alerts'), { type: 'screen', screen: 'alerts' });
  assert.deepEqual(parseCommand('go back'), { type: 'back' });
  assert.equal(parseCommand('flibberty gibbet').type, 'unknown');
});

// ---------- upgrade: voice execution + new screens ----------
function freshState2() {
  return {
    markets: structuredClone(SAMPLE_MARKETS),
    portfolio: emptyPortfolio(),
    screen: { kind: 'markets' },
    notice: '',
    updatedAt: '09:41',
    offline: true,
    save: () => {},
    alerts: emptyAlertState(),
    refreshSec: 60,
    telegram: { viaProxy: false },
    saveAlerts: () => {},
    savePrefs: () => {},
    syncAlerts: () => {},
  };
}

ok('voice execution: context rules and end-to-end buy/watch', () => {
  const s = freshState2();
  assert.match(app.executeCommand(s, parseCommand('buy 100')), /Which asset/);
  assert.match(app.executeCommand(s, parseCommand('show Bitcoin')), /Showing Bitcoin/);
  assert.equal(s.screen.kind, 'detail');
  const r = app.executeCommand(s, parseCommand('buy 200'));
  assert.match(r, /Bought/);
  assert.ok(Math.abs(s.portfolio.positions.bitcoin.qty - 200 / 97_240) < 1e-9);
  assert.match(app.executeCommand(s, parseCommand('watch Bitcoin')), /Watching BTC/);
  assert.ok(s.alerts.watchlist.includes('bitcoin'));
  assert.equal(app.executeCommand(s, parseCommand('portfolio')), 'Showing your paper portfolio');
  assert.equal(s.screen.kind, 'positions');
});

ok('new screens: watch toggle, history nav, settings cycling, 64-char rule', () => {
  const s = freshState2();
  s.screen = { kind: 'detail', id: 'bitcoin' };
  const items = app.detailItems(s, 'bitcoin');
  assert.equal(items[4], 'Watch BTC');
  app.select(s, 4); // watch
  assert.ok(s.alerts.watchlist.includes('bitcoin'));
  assert.equal(app.detailItems(s, 'bitcoin')[4], 'Unwatch BTC');
  app.select(s, 0); // buy $100 so history has a row
  s.screen = { kind: 'positions' };
  const posItems = app.positionsItems(s);
  const histIdx = posItems.indexOf('Trade history');
  assert.ok(histIdx > 0);
  app.select(s, histIdx);
  assert.equal(s.screen.kind, 'history');
  assert.ok(app.historyItems(s)[0].startsWith('BUY BTC'));
  app.select(s, 0); // tap the trade -> back to the asset
  assert.equal(s.screen.kind, 'detail');
  s.screen = { kind: 'settings' };
  app.select(s, 0);
  assert.equal(s.alerts.thresholdPct, 5); // 3 -> 5
  app.select(s, 1);
  assert.equal(s.refreshSec, 300); // 60 -> 300
  const check = (list) => list.forEach((i) => assert.ok(i.length <= 64, `too long (${i.length}): ${i}`));
  check(app.historyItems(s));
  check(app.alertsItems(s));
  check(app.settingsItems(s));
  assert.ok(app.historyHeader(s).length <= 1000);
  assert.ok(app.alertsHeader(s).length <= 1000);
  assert.ok(app.settingsHeader(s).length <= 1000);
});

ok('applyAlertCheck fires into the header notice exactly once per move', () => {
  const s = freshState2();
  s.alerts = emptyAlertState(['bitcoin']);
  assert.equal(app.applyAlertCheck(s, '10:00').length, 0); // baseline
  s.markets[0].price = 97_240 * 1.05;
  const fired = app.applyAlertCheck(s, '10:05');
  assert.equal(fired.length, 1);
  assert.match(s.notice, /^ALERT BTC/);
  assert.equal(app.applyAlertCheck(s, '10:06').length, 0); // no refire
});

// ---------- upgrade: Telegram companion (mock mode, no real bot) ----------
const priceFn = async (ids) => Object.fromEntries(ids.map((id) => [id, { bitcoin: 100_000, ethereum: 3_500 }[id] ?? 1]));
function fakeReq(body, method = 'POST') {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}
function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = b ?? '';
    },
  };
}

const svc = createTelegramService({ token: undefined, nowFn: () => 1_000_000 });
assert.equal(svc.mock, true);
{
  // pairing through the real HTTP route, then commands via injected updates
  const pairRes = fakeRes();
  assert.equal(await svc.handleRoute(fakeReq({}), pairRes, new URL('http://x/api/telegram/pair'), priceFn), true);
  const { code } = JSON.parse(pairRes.body);
  assert.match(code, /^\d{6}$/);
  await svc.handleUpdate({ message: { chat: { id: 42 }, text: `/start ${code}` } }, priceFn);
  assert.ok(svc.chats.has(42));
  assert.ok(svc.outbox.some((m) => m.chatId === 42 && /linked/.test(m.text)));

  await svc.handleUpdate({ message: { chat: { id: 42 }, text: '/price BTC' } }, priceFn);
  assert.ok(svc.outbox.some((m) => /\$100,000/.test(m.text)), 'price reply sent');

  const portRes = fakeRes();
  await svc.handleRoute(
    fakeReq({ cash: 9_900, totalValue: 10_070, realized: 70, positions: [{ symbol: 'BTC', qty: 0.002, avgPrice: 50_000, value: 170, pnl: 70 }] }),
    portRes,
    new URL('http://x/api/telegram/portfolio'),
    priceFn,
  );
  await svc.handleUpdate({ message: { chat: { id: 42 }, text: '/portfolio' } }, priceFn);
  assert.ok(svc.outbox.some((m) => /Paper portfolio: \$10,070/.test(m.text)), 'portfolio reply sent');

  // server-side poller: baseline first, then one alert, then silence
  assert.equal(svc.setAlertsConfig({ watchlist: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' }], thresholdPct: 3 }), true);
  assert.equal((await svc.pollAlerts(priceFn, '10:00')).length, 0);
  const jumping = async () => ({ bitcoin: 110_000 });
  assert.equal((await svc.pollAlerts(jumping, '10:05')).length, 1);
  assert.ok(svc.outbox.some((m) => /^ALERT: Bitcoin/.test(m.text)), 'alert pushed to paired chat');
  assert.equal((await svc.pollAlerts(jumping, '10:06')).length, 0);

  await svc.handleUpdate({ message: { chat: { id: 42 }, text: '/alerts' } }, priceFn);
  assert.ok(svc.outbox.some((m) => /Recent paper alerts/.test(m.text)));

  // unlinked chats are refused; bad codes do not pair
  await svc.handleUpdate({ message: { chat: { id: 99 }, text: '/start 000000' } }, priceFn);
  assert.ok(!svc.chats.has(99));
  await svc.handleUpdate({ message: { chat: { id: 99 }, text: '/price BTC' } }, priceFn);
  assert.ok(svc.outbox.some((m) => m.chatId === 99 && /not linked/.test(m.text)));

  const statusRes = fakeRes();
  await svc.handleRoute(fakeReq(undefined, 'GET'), statusRes, new URL('http://x/api/telegram/status'), priceFn);
  assert.deepEqual(JSON.parse(statusRes.body), { configured: true, mock: true, linked: true });
}
passed += 1;
console.log('PASS telegram companion: pairing, commands, poller alerts, route surface (mock mode)');

console.log(`\nAll ${passed} smoke checks passed.`);
