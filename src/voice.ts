// Voice command parsing for MarketGlance.
// The parser is pure and unit-tested: it turns a transcript ("buy one hundred
// of Bitcoin", "show portfolio", "watch Solana") into a structured command
// that src/app.ts executes through exactly the same code paths as ring/tap
// selection — voice is a second input to the same state machine, not a
// parallel implementation.
//
// Where transcripts come from:
//   - Browser preview / simulator demo: the Web Speech API
//     (webkitSpeechRecognition) in src/main.ts.
//   - On real G2 hardware the SDK exposes raw microphone PCM only, so the
//     audio is streamed to the backend proxy's /api/stt endpoint, which is
//     where a server-side STT provider (e.g. Whisper) plugs in. See README.

import { ASSETS } from './data.ts';

export type VoiceCommand =
  | { type: 'open'; id: string }
  | { type: 'buy'; usd: number; id?: string }
  | { type: 'sellAll'; id?: string }
  | { type: 'screen'; screen: 'markets' | 'positions' | 'history' | 'alerts' | 'settings' }
  | { type: 'watch'; id: string; on: boolean }
  | { type: 'back' }
  | { type: 'refresh' }
  | { type: 'unknown'; text: string };

const WORD_AMOUNTS: Record<string, number> = {
  fifty: 50,
  hundred: 100,
  'one hundred': 100,
  'two hundred': 200,
  'three hundred': 300,
  'five hundred': 500,
  thousand: 1000,
  'one thousand': 1000,
};

function findAsset(text: string): string | undefined {
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  for (const a of ASSETS) {
    if (a.keywords.some((k) => tokens.has(k)) || tokens.has(a.symbol.toLowerCase())) return a.id;
  }
  return undefined;
}

function findAmount(text: string): number | undefined {
  const digit = text.match(/\$?\s*(\d[\d,]*)/);
  if (digit) {
    const n = Number(digit[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  // longest word-amount first so "five hundred" wins over "hundred"
  for (const phrase of Object.keys(WORD_AMOUNTS).sort((x, y) => y.length - x.length)) {
    if (new RegExp(`\\b${phrase}\\b`).test(text)) return WORD_AMOUNTS[phrase];
  }
  return undefined;
}

/** Parse a raw transcript into a command. Never throws. */
export function parseCommand(raw: string): VoiceCommand {
  const text = ` ${raw.toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ')} `.replace(/\s+/g, ' ');
  const id = findAsset(text);

  if (/\b(unwatch|stop watching|remove)\b/.test(text) && id) return { type: 'watch', id, on: false };
  if (/\b(watch|alert me)\b/.test(text) && id) return { type: 'watch', id, on: true };

  if (/\bbuy\b/.test(text)) {
    // smart default: "buy Bitcoin" with no amount means the $100 quick-buy,
    // the same default as the first tap target on the detail screen.
    return { type: 'buy', usd: findAmount(text) ?? 100, id };
  }
  if (/\bsell\b/.test(text)) return { type: 'sellAll', id };

  if (/\b(portfolio|positions|holdings)\b/.test(text)) return { type: 'screen', screen: 'positions' };
  if (/\b(history|trades)\b/.test(text)) return { type: 'screen', screen: 'history' };
  if (/\balerts\b/.test(text)) return { type: 'screen', screen: 'alerts' };
  if (/\bsettings\b/.test(text)) return { type: 'screen', screen: 'settings' };
  if (/\b(home|markets|prices)\b/.test(text)) return { type: 'screen', screen: 'markets' };

  if (/\b(refresh|update)\b/.test(text)) return { type: 'refresh' };
  if (/\bback\b/.test(text)) return { type: 'back' };

  if (id && /\b(show|open|check)\b/.test(text)) return { type: 'open', id };
  if (id) return { type: 'open', id }; // just naming an asset opens it

  return { type: 'unknown', text: raw.trim() };
}
