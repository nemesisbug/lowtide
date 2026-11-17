# lowtide

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/nemesisbug/lowtide/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/nemesisbug/lowtide/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

**LOWTIDE** — buys the ebb, rides the flood: a BTC trading bot that trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long
only, from $1,000 of paper money.

## Run it

```sh
node main.ts
```

`main.ts` speaks `agent-fun/bars-replay/v1` on stdin/stdout (Node 22,
standard library only; the wire shim is vendored at
`vendor/makefun-bars.ts`).

## The strategy

A full-size round trip costs ~26 bps in fees, slippage and pool impact
while a typical minute moves ~6 bps, so trading inside the noise loses
money on costs alone. LOWTIDE only trades when the tape has already moved
a long way, then lets the move pay for itself:

1. **Ebb** — the close falls 0.80% below its 4-hour (240-bar) mean. A dip
   that deep is a real dislocation, not noise. LOWTIDE buys full size.
2. **Flood** — once the position is 0.50% above its entry cost, a trailing
   stop arms: the bot rides the recovery and exits on a 0.40% pullback from
   the highest close since entry.
3. **Leak** — a hard stop 0.80% below entry caps any single trade, and after
   a stop the bot sits out 120 bars (2h) instead of catching the same
   falling knife again.

Three numbers, one regime, no fitted curve. Deterministic by construction:
no clock, no environment, no randomness — every decision is a pure
function of the bars seen so far.

## Backtest (kit dev window, 24h)

Graded with the kit's own harness
(`node cli/makefun.mjs grade-local --kit . --bot . --driver process`),
two executions, byte-for-byte reproduced:

| | LOWTIDE | buy-and-hold |
|---|---|---|
| Net PnL | **+$16.68** | +$1.07 |
| Trades | 2 entries | 1 |
| Max drawdown | 1.1% | 2.1% |

Robustness checks on transformed copies of the same window (same rules,
same parameters): time-reversed +$15.16, mirror-image +$12.45 — the edge
is the shape of the rule, not one window's luck. The dev window's two
entries: a buy at the window low (bar 386) sold into the +2% bounce
(bar 517, +$17.08), and a second dip buy (bar 1094) held to the close.
