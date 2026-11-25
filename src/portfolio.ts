// Paper-trading portfolio for MarketGlance.
// Pure logic, no DOM / SDK dependencies — unit-testable in plain Node.
// All money is paper money. No real funds are ever touched.

export interface Position {
  id: string; // asset id, e.g. 'bitcoin'
  qty: number; // units held
  avgPrice: number; // average buy price in USD
}

export interface Trade {
  at: string; // 'HH:MM' when the trade happened ('' if unknown)
  id: string; // asset id
  side: 'buy' | 'sell';
  usd: number; // buy: amount spent; sell: proceeds received
  qty: number; // units traded
  price: number; // execution price in USD
  pnl?: number; // sells only: realized PnL of this trade
}

export interface Portfolio {
  cash: number; // paper USD available
  positions: Record<string, Position>;
  realized: number; // realized PnL in paper USD
  trades: Trade[]; // full paper-trade history, oldest first
}

export const START_CASH = 10_000;

export function emptyPortfolio(): Portfolio {
  return { cash: START_CASH, positions: {}, realized: 0, trades: [] };
}

/** Tolerate portfolios saved by older versions (no trades array yet). */
export function withTrades(p: Portfolio): Portfolio {
  if (!Array.isArray(p.trades)) p.trades = [];
  return p;
}

export interface TradeResult {
  ok: boolean;
  message: string;
}

/** Buy `usd` worth of asset `id` at `price`. Fails if cash is insufficient. */
export function buy(p: Portfolio, id: string, price: number, usd: number, at = ''): TradeResult {
  if (!(price > 0)) return { ok: false, message: 'No live price yet' };
  if (usd <= 0) return { ok: false, message: 'Amount must be positive' };
  if (usd > p.cash) return { ok: false, message: `Not enough paper cash ($${p.cash.toFixed(2)})` };
  withTrades(p);
  const qty = usd / price;
  const existing = p.positions[id];
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.avgPrice = (existing.qty * existing.avgPrice + qty * price) / totalQty;
    existing.qty = totalQty;
  } else {
    p.positions[id] = { id, qty, avgPrice: price };
  }
  p.cash -= usd;
  p.trades.push({ at, id, side: 'buy', usd, qty, price });
  return { ok: true, message: `Bought $${usd} @ $${fmtPrice(price)}` };
}

/** Sell the entire position in `id` at `price`. */
export function sellAll(p: Portfolio, id: string, price: number, at = ''): TradeResult {
  const pos = p.positions[id];
  if (!pos) return { ok: false, message: 'No position to sell' };
  if (!(price > 0)) return { ok: false, message: 'No live price yet' };
  withTrades(p);
  const proceeds = pos.qty * price;
  const pnl = proceeds - pos.qty * pos.avgPrice;
  p.cash += proceeds;
  p.realized += pnl;
  p.trades.push({ at, id, side: 'sell', usd: proceeds, qty: pos.qty, price, pnl });
  delete p.positions[id];
  return {
    ok: true,
    message: `Sold for $${proceeds.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
  };
}

/** Total account value at the given prices (missing price = valued at avg cost). */
export function totalValue(p: Portfolio, prices: Record<string, number>): number {
  let v = p.cash;
  for (const pos of Object.values(p.positions)) {
    v += pos.qty * (prices[pos.id] ?? pos.avgPrice);
  }
  return v;
}

/** Unrealized PnL of one position at `price`. */
export function unrealizedPnl(pos: Position, price: number): number {
  return pos.qty * (price - pos.avgPrice);
}

// ---------- formatting helpers (shared with the UI) ----------

/** $97,240 / $1,234.56 / $0.1523 depending on magnitude. */
export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

/** +1.2% / -0.4% */
export function fmtChange(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** +$12.30 / -$4.00 */
export function fmtSignedUsd(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
