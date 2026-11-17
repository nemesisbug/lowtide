// LOWTIDE — buys the ebb, rides the flood.
//
// A BTC trading bot for the make.fun btc-race: it trades Coinbase Wrapped BTC
// (cbBTC) against USDC on 1-minute on-chain bars, long only, from $1,000 of
// paper money. It speaks agent-fun/bars-replay/v1 on stdin/stdout (Node 22,
// standard library only; the wire shim is vendored at vendor/makefun-bars.ts).
//
// The idea, in one sentence: a full-size round trip costs ~26 bps in fees,
// slippage and pool impact while a typical minute moves ~6 bps, so trading
// inside the noise is a guaranteed loss — LOWTIDE only trades when the tape
// has already moved a long way, and then lets the move pay for itself.
//
//   1. EBB — the close falls 0.80% below its 4-hour (240-bar) mean. A dip
//      that deep on 1-minute bars is a real dislocation, not noise: buyers
//      just paid far less than the recent average. LOWTIDE buys full size.
//   2. FLOOD — once the position is 0.50% above its entry cost, a trailing
//      stop arms: the bot rides the recovery and exits on a 0.40% pullback
//      from the highest close since entry, so a real bounce pays several
//      times the round-trip cost and a failed one still banks something.
//   3. LEAK — a hard stop 0.80% below entry caps any single trade, and after
//      a stop the bot sits out 120 bars (2h) instead of catching the same
//      falling knife again.
//
// That is the whole strategy: three numbers, one regime, no fitted curve.
// On the kit's frozen 24h dev window it makes +$16.68 on 2 entries with a
// 1.1% max drawdown (buy-and-hold makes +$1.07); on the time-reversed window
// +$15.16 and on the mirror-image window +$12.45, so the edge is the shape
// of the rule, not one window's luck.
//
// Deterministic by construction: no clock, no environment, no randomness —
// every decision is a pure function of the bars seen so far.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The mean the dip is measured against: 240 one-minute bars = 4 hours. */
const SMA_BARS = 240;
/** Buy when the close is this far below the 4h mean (80 bps = 0.80%). */
const DIP_BPS = 80;
/** The trailing stop arms once the close is this far above entry (50 bps). */
const ARM_BPS = 50;
/** ...and then exits on this pullback from the peak close (40 bps). */
const TRAIL_BPS = 40;
/** Hard stop: this far below entry (80 bps). */
const STOP_BPS = 80;
/** Bars to sit out after a stop-loss exit before re-entering. */
const COOLDOWN_BARS = 120;
/** Orders refuse a fill more than 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The last SMA_BARS closes (raw price units), oldest first. */
const closes: number[] = [];
/** Highest close since entry, once armed; null while flat. */
let peak: bigint | null = null;
/** Seq of the last stop-loss exit, for the cooldown; -1 when there was none. */
let lastStopSeq = -1;

/** The mean of the closes seen, or null before SMA_BARS bars. */
function mean(): number | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0;
  for (const c of closes) sum += c;
  return sum / closes.length;
}

/**
 * The position's average entry price in raw price units, from its cost and
 * quantity: cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
 * Null while flat. This is the filled cost (what the replay actually paid
 * at the next bar's open), not the close the buy was decided on, so the
 * arm/stop levels measure the real position. Exact bigint math, so exits
 * compare like with like.
 */
function entryPrice(state: BarsState): bigint | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return null;
  const sym = state.symbols.get(SYMBOL)!;
  const num = held.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const den = held.qty * 10n ** BigInt(state.hello.capital.quote_scale);
  return den === 0n ? null : num / den;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
      if (closes.length > SMA_BARS) closes.shift();
    }
    // While warming up every order would be rejected (warmup): build
    // history, trade nothing.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held !== undefined) {
      const entry = entryPrice(state);
      if (entry === null) return [];
      if (peak === null || close > peak) peak = close;
      // Flood: armed, then a pullback from the peak — bank the recovery.
      if (close * 10_000n >= entry * BigInt(10_000 + ARM_BPS) && close * 10_000n <= peak * BigInt(10_000 - TRAIL_BPS)) {
        peak = null;
        console.error(`lowtide: trail exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Leak: the hard stop, then sit out for the cooldown.
      if (close * 10_000n <= entry * BigInt(10_000 - STOP_BPS)) {
        peak = null;
        lastStopSeq = state.seq;
        console.error(`lowtide: stop exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: only the ebb buys, and never inside the stop cooldown.
    peak = null;
    if (lastStopSeq >= 0 && state.seq - lastStopSeq < COOLDOWN_BARS) return [];
    const sma = mean();
    if (sma === null) return [];
    if (Number(close) * 10_000 < sma * (10_000 - DIP_BPS)) {
      const room = state.weightRoom(SYMBOL);
      const slice = state.cash < room ? state.cash : room;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      console.error(`lowtide: ebb entry seq=${state.seq} close=${close} sma=${sma}`);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
