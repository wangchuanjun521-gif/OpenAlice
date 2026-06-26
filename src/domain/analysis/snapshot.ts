/**
 * As-of snapshot — the honest "what did it look like at time T" primitive.
 *
 * The Retrospective / Time-Machine workflow's load-bearing read. Unlike the quant
 * calculator (latest scalars, dateless), a snapshot returns:
 *   - DATED OHLCV bars up to (and never past) `asOf` — no lookahead, the命门 of
 *     an honest retro,
 *   - the most-recent ACTUAL bar at/before `asOf` as the "current as of T" print
 *     (close + vs-prevClose + day high/low + amplitude),
 *   - a compact technical state (sma20/50, rsi14, period high/low, distance from
 *     high/low),
 *   - and the FRESHNESS CONTRACT from the bar layer (asOf / isLatestActual /
 *     staleTradingDays) surfaced LOUDLY — a delayed source that stopped a day
 *     behind the anchor is the failure mode this exists to prevent.
 *
 * Lives in `domain/analysis` (not `domain/market-data`): it consumes the bar
 * service AND the indicator stat lib, and the dependency direction is
 * analysis → market-data, never the reverse.
 */

import type { BarService, BarSourceRef, BarCapability, BarSourceKind } from '@/domain/market-data/bars/index'
import { SMA } from './indicator/functions/statistics.js'
import { RSI } from './indicator/functions/technical.js'

export interface SnapshotOpts {
  /** Point-in-time anchor (YYYY-MM-DD). Bars never run past it (no lookahead). Default: now. */
  asOf?: string
  /** Bar interval. Default '1d'. */
  interval?: string
  /** Bars of dated context to return + compute over. Default 90. */
  count?: number
}

export interface SnapshotBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface SnapshotResult {
  symbol: string
  barId?: string
  source?: BarSourceKind
  barCapability?: BarCapability
  interval: string
  /** Effective anchor. */
  asOf: string
  /** LOUD freshness: did the data reach `asOf`? */
  isLatestActual: boolean
  staleTradingDays: number
  /** Human banner — present only when the data is stale relative to the anchor. */
  freshnessWarning?: string
  /** The most recent ACTUAL bar ≤ asOf — the honest "current as of T". */
  latest: {
    date: string
    close: number
    prevClose: number | null
    changePct: number | null
    dayHigh: number
    dayLow: number
    /** (high − low) / prevClose, %. The intraday range a single vs-prevClose number hides. */
    dayAmplitudePct: number | null
  } | null
  /** Compact technical state AS OF the anchor (over the returned window). */
  levels: {
    sma20: number | null
    sma50: number | null
    rsi14: number | null
    periodHigh: number
    periodLow: number
    /** (close − periodHigh)/periodHigh, % (≤0). "How far off the high" — the dump-from-high feel. */
    distFromHighPct: number
    distFromLowPct: number
  } | null
  /** Dated OHLCV, ascending, ≤ asOf. The dated series the quant tool can't emit. */
  bars: SnapshotBar[]
}

function r(v: number | null, dp = 4): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp))
}
function safe(fn: () => number): number | null {
  try { const v = fn(); return Number.isFinite(v) ? v : null } catch { return null }
}

export async function getSnapshot(
  barService: BarService,
  ref: BarSourceRef,
  opts: SnapshotOpts = {},
): Promise<SnapshotResult> {
  const interval = opts.interval ?? '1d'
  const count = opts.count ?? 90
  // `end` (not just asOf) is what actually caps the upper bound in BOTH branches
  // — pass both so the window is sized AND clamped to the anchor (no lookahead).
  const { bars, meta } = await barService.getBars(ref, {
    interval,
    count,
    ...(opts.asOf ? { end: opts.asOf, asOf: opts.asOf } : {}),
  })

  const asOf = meta.asOf ?? opts.asOf ?? new Date().toISOString().slice(0, 10)
  const isLatestActual = meta.isLatestActual ?? true
  const staleTradingDays = meta.staleTradingDays ?? 0
  const warning = !isLatestActual && bars.length > 0
    ? `⚠ Data ends ${bars[bars.length - 1].date.slice(0, 10)}, but you anchored as-of ${asOf} — ${staleTradingDays} trading day(s) behind. You are NOT seeing the latest print; treat this close as stale, not "current".`
    : undefined

  const base = {
    symbol: meta.symbol,
    barId: meta.barId,
    source: meta.source,
    barCapability: meta.barCapability,
    interval,
    asOf,
    isLatestActual,
    staleTradingDays,
    ...(warning ? { freshnessWarning: warning } : {}),
  }

  if (bars.length === 0) {
    return { ...base, latest: null, levels: null, bars: [] }
  }

  const closes = bars.map((b) => b.close)
  const last = bars[bars.length - 1]
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].close : null
  const periodHigh = Math.max(...bars.map((b) => b.high))
  const periodLow = Math.min(...bars.map((b) => b.low))

  return {
    ...base,
    latest: {
      date: last.date,
      close: r(last.close)!,
      prevClose: r(prevClose),
      changePct: r(prevClose != null ? ((last.close - prevClose) / prevClose) * 100 : null, 2),
      dayHigh: r(last.high)!,
      dayLow: r(last.low)!,
      dayAmplitudePct: r(prevClose != null ? ((last.high - last.low) / prevClose) * 100 : null, 2),
    },
    levels: {
      sma20: r(closes.length >= 20 ? safe(() => SMA(closes, 20)) : null),
      sma50: r(closes.length >= 50 ? safe(() => SMA(closes, 50)) : null),
      rsi14: r(closes.length >= 15 ? safe(() => RSI(closes, 14)) : null, 2),
      periodHigh: r(periodHigh)!,
      periodLow: r(periodLow)!,
      distFromHighPct: r(((last.close - periodHigh) / periodHigh) * 100, 2)!,
      distFromLowPct: r(((last.close - periodLow) / periodLow) * 100, 2)!,
    },
    bars: bars.map((b) => ({
      date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })),
  }
}
