// Market data for MarketGlance.
// Sources (both keyless, public, CORS-enabled, and whitelisted in app.json):
//   - CoinGecko public API  -> spot prices + 24h change (Track 02 listed app)
//   - Polymarket Gamma API  -> live prediction-market odds (Track 02 listed app)
// If the network is unreachable the app falls back to a clearly-labelled
// offline sample snapshot so the demo still runs end to end.

export interface MarketInfo {
  id: string; // CoinGecko id
  symbol: string;
  name: string;
  price: number; // USD
  change24h: number; // percent
  pmQuestion?: string; // matched Polymarket market question
  pmYes?: number; // Polymarket YES price, 0..1
}

export const ASSETS: Array<{ id: string; symbol: string; name: string; keywords: string[] }> = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', keywords: ['bitcoin', 'btc'] },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', keywords: ['ethereum', 'eth'] },
  { id: 'solana', symbol: 'SOL', name: 'Solana', keywords: ['solana', 'sol'] },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', keywords: ['chainlink', 'link'] },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', keywords: ['avalanche', 'avax'] },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', keywords: ['dogecoin', 'doge'] },
];

// When the app is served by server/proxy.mjs (port 8787) it calls the proxy's
// relative /api/* routes (Even's recommended pattern: route calls through your
// own backend, keep the WebView away from third-party CORS/keys). Everywhere
// else (Vite dev server, simulator, static hosting) it calls the APIs directly.
const USE_PROXY = typeof location !== 'undefined' && location.port === '8787';

function coingeckoUrl(): string {
  const ids = ASSETS.map((a) => a.id).join(',');
  const path = `/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  return USE_PROXY ? `/api/coingecko${path}` : `https://api.coingecko.com${path}`;
}

function polymarketUrl(): string {
  const path = `/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100`;
  return USE_PROXY ? `/api/polymarket${path}` : `https://gamma-api.polymarket.com${path}`;
}

interface PmMarket {
  question: string;
  outcomePrices: string; // JSON string, e.g. "[\"0.63\", \"0.37\"]"
  volume24hr?: number;
}

/** Parse Polymarket's outcomePrices JSON string into a YES probability (0..1). */
export function parseYesPrice(raw: string): number | undefined {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr.length > 0) {
      const v = Number(arr[0]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    }
  } catch {
    /* malformed -> undefined */
  }
  return undefined;
}

/** Pick the highest-volume Polymarket market whose question mentions the asset.
 *  Keywords match as whole words (token equality), so 'sol' does not match
 *  "solved" and 'eth' does not match "whether". */
export function matchPolymarket(
  markets: PmMarket[],
  keywords: string[],
): { question: string; yes: number } | undefined {
  for (const m of markets) {
    const tokens = new Set((m.question ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    if (keywords.some((k) => tokens.has(k))) {
      const yes = parseYesPrice(m.outcomePrices);
      if (yes !== undefined) return { question: m.question, yes };
    }
  }
  return undefined;
}

export interface FetchResult {
  markets: MarketInfo[];
  offline: boolean;
}

export async function fetchMarkets(fetchFn: typeof fetch = fetch): Promise<FetchResult> {
  try {
    const [cgRes, pmRes] = await Promise.all([
      fetchFn(coingeckoUrl(), { signal: AbortSignal.timeout(12000) }),
      fetchFn(polymarketUrl(), { signal: AbortSignal.timeout(12000) }).catch(() => null),
    ]);
    if (!cgRes.ok) throw new Error(`CoinGecko HTTP ${cgRes.status}`);
    const cg = (await cgRes.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
    const pmMarkets: PmMarket[] = pmRes && pmRes.ok ? ((await pmRes.json()) as PmMarket[]) : [];

    const markets: MarketInfo[] = [];
    for (const a of ASSETS) {
      const row = cg[a.id];
      if (!row || !(row.usd > 0)) continue;
      const pm = matchPolymarket(pmMarkets, a.keywords);
      markets.push({
        id: a.id,
        symbol: a.symbol,
        name: a.name,
        price: row.usd,
        change24h: row.usd_24h_change ?? 0,
        pmQuestion: pm?.question,
        pmYes: pm?.yes,
      });
    }
    if (markets.length === 0) throw new Error('CoinGecko returned no usable rows');
    return { markets, offline: false };
  } catch {
    return { markets: SAMPLE_MARKETS, offline: true };
  }
}

// Offline snapshot (clearly labelled in the UI as "OFFLINE SAMPLE").
export const SAMPLE_MARKETS: MarketInfo[] = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price: 97240, change24h: 1.2, pmQuestion: 'Will Bitcoin reach $120k by December?', pmYes: 0.63 },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', price: 3412.55, change24h: -0.8 },
  { id: 'solana', symbol: 'SOL', name: 'Solana', price: 214.3, change24h: 3.1 },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', price: 22.41, change24h: 0.4 },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', price: 38.92, change24h: -1.5 },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', price: 0.1523, change24h: 2.2 },
];
