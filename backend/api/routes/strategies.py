"""
Strategies module — Momentum Rotation, Breakout Scanner, Collar Optimizer.
All three are read-only analysis endpoints; no trades are executed automatically.
"""

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

router = APIRouter()


# ═══════════════════════════════════════════════════════════════
# 1. MOMENTUM ROTATION
# ═══════════════════════════════════════════════════════════════

def _momentum_rotation_data(top_n: int = 5, lookback_days: int = 20) -> dict:
    """
    Sector Rotation Strategy — identifies sectors that are:
    1. In a LONG-TERM uptrend (above 3M SMA) — structurally healthy
    2. In a SHORT-TERM pullback (below 20d SMA or near 20d low) — good entry point
    3. Show RECOVERY signs (last 5 days turning positive after pullback)

    Logic: Don't chase what already ran. Enter sectors pulling back within an uptrend.
    Exit sectors that have broken their long-term trend.
    """
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor
    from data.indices import SECTOR_INDEX_MAP

    SECTOR_ETF_MAP = {
        "IT":                 {"etf": "ITETF.NS",     "label": "Nifty IT ETF"},
        "Banking":            {"etf": "BANKBEES.NS",  "label": "BankBees ETF"},
        "Pharma":             {"etf": "PHARMABEES.NS","label": "Pharma BeES"},
        "Auto":               {"etf": "AUTOBEES.NS",  "label": "Nifty Auto ETF"},
        "FMCG":               {"etf": "FMCGIETF.NS",  "label": "Nifty FMCG ETF"},
        "Metal":              {"etf": "METALIETF.NS", "label": "Nifty Metal ETF"},
        "Energy":             {"etf": "ENERGYETF.NS", "label": "Nifty Energy ETF"},
        "Financial Services": {"etf": "NIFTYBEES.NS", "label": "NiftyBees (proxy)"},
        "Infrastructure":     {"etf": "INFRABEES.NS", "label": "Nifty Infra ETF"},
    }

    def _fetch_sector(sector: str, idx_sym: str) -> dict | None:
        try:
            t    = yf.Ticker(idx_sym)
            hist = t.history(period="1y")
            if hist.empty or len(hist) < 65:
                return None
            close = hist["Close"]
            cmp   = float(close.iloc[-1])

            # Long-term trend: 3-month (63-day) SMA
            sma63   = float(close.rolling(63).mean().iloc[-1])
            # Medium trend: 50-day SMA
            sma50   = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
            # Short-term: 20-day SMA
            sma20   = float(close.rolling(20).mean().iloc[-1])

            above_sma63  = cmp > sma63   # long-term uptrend
            above_sma20  = cmp > sma20   # short-term above/below

            # Pullback from 3M high
            high_3m = float(close.iloc[-63:].max())
            pullback_from_3m_high = round((cmp / high_3m - 1) * 100, 2)  # negative = pulled back

            # Recovery: last 5 days positive
            ret_5d  = round((float(close.iloc[-1]) / float(close.iloc[-5]) - 1) * 100, 2) if len(close) >= 5 else 0.0
            # 1M and 3M returns for context
            ret_1m  = round((float(close.iloc[-1]) / float(close.iloc[-21]) - 1) * 100, 2) if len(close) >= 21 else None
            ret_3m  = round((float(close.iloc[-1]) / float(close.iloc[-63]) - 1) * 100, 2) if len(close) >= 63 else None

            # Volume
            vol       = hist["Volume"]
            avg_vol20 = float(vol.rolling(20).mean().iloc[-1]) if not vol.empty else 0
            vol_ratio = round(float(vol.iloc[-1]) / avg_vol20, 2) if avg_vol20 > 0 else 1.0

            # ── Scoring: reward pullback-in-uptrend entries ──────────────────
            score = 50

            # MUST be in long-term uptrend
            if above_sma63:
                score += 20   # structurally healthy
            else:
                score -= 25   # broken trend — avoid

            # Reward pullback depth (ideal: -3% to -10% from 3M high)
            if -10 <= pullback_from_3m_high <= -3:
                score += 20   # sweet spot: meaningful dip but not broken
            elif -3 < pullback_from_3m_high <= 0:
                score += 5    # marginal dip
            elif pullback_from_3m_high < -10:
                score += 10   # deep pullback — may need more time to recover
            elif pullback_from_3m_high > 5:
                score -= 15   # extended — already ran up

            # Reward early recovery signs
            if ret_5d > 1.0:   score += 15  # turning up after dip
            elif ret_5d > 0:   score += 5
            elif ret_5d < -2:  score -= 10  # still falling

            # Volume on recovery
            if not above_sma20 and vol_ratio > 1.3:
                score += 5   # volume on recovery day = institutions buying dip

            score = min(100, max(0, score))

            # ── Signal ──────────────────────────────────────────────────────
            if not above_sma63:
                signal   = "AVOID — trend broken"
                rationale = f"Below 3M avg (₹{round(sma63,0):,.0f}). Wait for trend recovery."
            elif pullback_from_3m_high < -3 and ret_5d > 0 and above_sma63:
                signal   = "BUY DIP — enter now"
                rationale = f"In uptrend, pulled back {abs(pullback_from_3m_high):.1f}% from 3M high, showing 5d recovery. Good entry."
            elif pullback_from_3m_high < -3:
                signal   = "WATCH — wait for recovery"
                rationale = f"Pullback {abs(pullback_from_3m_high):.1f}% from high but no recovery yet. Set alert for 5d turn positive."
            elif pullback_from_3m_high > 5:
                signal   = "HOLD — don't chase"
                rationale = f"Already {pullback_from_3m_high:.1f}% above 3M high. Wait for next pullback to enter."
            else:
                signal   = "NEUTRAL — monitor"
                rationale = "Near fair value. No strong entry or exit signal."

            etf_info = SECTOR_ETF_MAP.get(sector, {"etf": None, "label": "No ETF"})

            return {
                "sector":              sector,
                "index":               idx_sym,
                "cmp":                 round(cmp, 2),
                "sma20":               round(sma20, 2),
                "sma50":               round(sma50, 2) if sma50 else None,
                "sma63":               round(sma63, 2),
                "above_sma63":         above_sma63,
                "above_sma20":         above_sma20,
                "pullback_from_3m_high": pullback_from_3m_high,
                "high_3m":             round(high_3m, 2),
                "ret_5d":              ret_5d,
                "ret_1m":              ret_1m,
                "ret_3m":              ret_3m,
                "vol_ratio":           vol_ratio,
                "score":               score,
                "signal":              signal,
                "rationale":           rationale,
                "etf":                 etf_info["etf"],
                "etf_label":           etf_info["label"],
            }
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda kv: _fetch_sector(*kv), SECTOR_INDEX_MAP.items()))

    ranked = sorted([r for r in results if r], key=lambda x: x["score"], reverse=True)
    buy_dip   = [r for r in ranked if "BUY DIP" in r["signal"]]
    watch     = [r for r in ranked if "WATCH" in r["signal"]]
    avoid     = [r for r in ranked if "AVOID" in r["signal"]]

    return {
        "lookback_days":  lookback_days,
        "top_n":          top_n,
        "buy_dip":        buy_dip[:top_n],
        "watch":          watch[:top_n],
        "avoid":          avoid,
        "all_sectors":    ranked,
        "strategy_note":  "Enter sectors pulling back within long-term uptrend. Don't chase sectors already extended. Exit when 3M trend (SMA63) breaks.",
        "summary":        f"Buy-the-dip opportunities: {', '.join(r['sector'] for r in buy_dip[:3]) or 'None right now'}",
    }


@router.get("/strategies/momentum-rotation")
async def momentum_rotation(
    top_n:         int   = Query(default=5,  ge=1, le=10),
    lookback_days: int   = Query(default=20, ge=5, le=120),
):
    """Rank NSE sectors by momentum and suggest rotation."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        ThreadPoolExecutor(max_workers=1),
        lambda: _momentum_rotation_data(top_n, lookback_days)
    )
    return JSONResponse(content=result)


# ═══════════════════════════════════════════════════════════════
# 2. BREAKOUT SCANNER
# ═══════════════════════════════════════════════════════════════

def _breakout_scan_data(
    min_vol_ratio: float = 1.5,
    lookback_days: int   = 20,
    min_score:     int   = 60,
) -> dict:
    """
    Scan Nifty500 universe for stocks:
    - Breaking out of recent highs (last `lookback_days` sessions)
    - Volume surge >= min_vol_ratio x 20-day avg volume
    - Above 50 DMA (trend filter)
    """
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor
    from data.indices import NIFTY50, NIFTY_BANK, NIFTY_IT, NIFTY_MIDCAP_SELECTION

    candidates = list(set(NIFTY50 + NIFTY_BANK + NIFTY_IT + NIFTY_MIDCAP_SELECTION))

    def _check_one(sym: str) -> dict | None:
        try:
            t   = yf.Ticker(sym)
            fi  = t.fast_info
            cmp = float(getattr(fi, "last_price", None) or 0)
            if not cmp:
                return None

            hist = t.history(period="6mo")
            if hist.empty or len(hist) < lookback_days + 5:
                return None

            close  = hist["Close"]
            volume = hist["Volume"]
            high   = hist["High"]

            # Breakout: close above highest high of prior `lookback_days` bars (excluding today)
            prior_high = float(high.iloc[-(lookback_days+1):-1].max())
            is_breakout = cmp > prior_high
            breakout_pct = round((cmp / prior_high - 1) * 100, 2) if prior_high > 0 else 0

            # 52W breakout bonus
            high_52w = float(getattr(fi, "year_high", prior_high) or prior_high)
            is_52w_breakout = cmp >= high_52w * 0.99  # within 1% of 52W high

            # Volume
            avg_vol_20 = float(volume.rolling(20).mean().iloc[-1])
            today_vol  = float(volume.iloc[-1])
            vol_ratio  = round(today_vol / avg_vol_20, 2) if avg_vol_20 > 0 else 0

            if vol_ratio < min_vol_ratio:
                return None
            if not is_breakout and not is_52w_breakout:
                return None

            # SMA filters
            sma50  = float(close.rolling(50).mean().iloc[-1])  if len(close) >= 50 else None
            sma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
            above_sma50  = cmp > sma50  if sma50  else False
            above_sma200 = cmp > sma200 if sma200 else False

            # ATR for stop-loss suggestion
            tr = hist.apply(lambda r: max(r["High"]-r["Low"], abs(r["High"]-r["Close"]), abs(r["Low"]-r["Close"])), axis=1)
            atr14 = round(float(tr.rolling(14).mean().iloc[-1]), 2)

            # 5-day price change
            ret_5d = round((float(close.iloc[-1]) / float(close.iloc[-5]) - 1) * 100, 2) if len(close) >= 5 else 0

            # Score
            score = 50
            if is_breakout:      score += 20
            if is_52w_breakout:  score += 10
            if vol_ratio > 2.0:  score += 15
            elif vol_ratio > 1.5: score += 8
            if above_sma50:      score += 8
            if above_sma200:     score += 7
            if ret_5d > 3:       score += 5
            score = min(100, max(0, score))

            if score < min_score:
                return None

            # Suggested stop-loss and target
            stop_loss  = round(cmp - 1.5 * atr14, 2)
            target_1r  = round(cmp + 2.0 * atr14, 2)
            target_2r  = round(cmp + 3.0 * atr14, 2)

            from data.indices import get_sector
            bare = sym.replace(".NS", "")
            sector = get_sector(sym)

            return {
                "symbol":          bare,
                "sector":          sector,
                "cmp":             round(cmp, 2),
                "prior_high":      round(prior_high, 2),
                "breakout_pct":    breakout_pct,
                "is_52w_breakout": is_52w_breakout,
                "vol_ratio":       vol_ratio,
                "above_sma50":     above_sma50,
                "above_sma200":    above_sma200,
                "atr14":           atr14,
                "ret_5d":          ret_5d,
                "stop_loss":       stop_loss,
                "target_1r":       target_1r,
                "target_2r":       target_2r,
                "score":           score,
                "signal":          "BREAKOUT" if is_breakout else "NEAR 52W HIGH",
            }
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=12) as ex:
        results = list(ex.map(_check_one, candidates))

    hits = sorted([r for r in results if r], key=lambda x: x["score"], reverse=True)
    return {
        "count":         len(hits),
        "scanned":       len(candidates),
        "min_vol_ratio": min_vol_ratio,
        "lookback_days": lookback_days,
        "stocks":        hits,
    }


@router.get("/strategies/breakout-scan")
async def breakout_scan(
    min_vol_ratio: float = Query(default=1.5, ge=1.0, le=5.0),
    lookback_days: int   = Query(default=20,  ge=5,   le=60),
    min_score:     int   = Query(default=60,  ge=0,   le=100),
):
    """Scan for breakout stocks with volume confirmation."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        ThreadPoolExecutor(max_workers=1),
        lambda: _breakout_scan_data(min_vol_ratio, lookback_days, min_score)
    )
    return JSONResponse(content=result)


# ═══════════════════════════════════════════════════════════════
# 3. COLLAR OPTIMIZER
# ═══════════════════════════════════════════════════════════════

# Index metadata: name → {nse_symbol for option chain, lot_size, yf_sym for price}
_INDEX_META = {
    "nifty":     {"chain_sym": "NIFTY",     "lot": 75,  "yf_sym": "^NSEI",     "round_step": 100},
    "banknifty": {"chain_sym": "BANKNIFTY", "lot": 35,  "yf_sym": "^NSEBANK",  "round_step": 100},
    "finnifty":  {"chain_sym": "FINNIFTY",  "lot": 65,  "yf_sym": "^NSEMDCP50","round_step": 100},
    "sensex":    {"chain_sym": "SENSEX",    "lot": 10,  "yf_sym": "^BSESN",    "round_step": 100},
}


def _is_monthly_expiry(expiry_str: str) -> bool:
    """True if expiry is the last Thursday of its month (NSE monthly expiry)."""
    from datetime import datetime, timedelta
    try:
        d = datetime.strptime(expiry_str, "%d-%b-%Y").date()
        if d.weekday() != 3:          # must be Thursday
            return False
        return (d + timedelta(days=7)).month != d.month  # no Thursday next week in same month
    except Exception:
        return False


def _days_to_expiry(expiry_str: str) -> int:
    """Parse '28-Aug-2026' → days from today (int)."""
    from datetime import datetime, date
    try:
        exp_dt = datetime.strptime(expiry_str, "%d-%b-%Y").date()
        return max(1, (exp_dt - date.today()).days)
    except Exception:
        return 30


def _pick_expiry_for_collar(expiry_dates: list, target_days: int, monthly_only: bool = False) -> str | None:
    """Pick the NSE expiry string closest to target_days DTE.
    When monthly_only=True, only consider last-Thursday-of-month expiries."""
    if not expiry_dates:
        return None
    if monthly_only:
        candidates = [ed for ed in expiry_dates if _is_monthly_expiry(ed)]
        if not candidates:
            candidates = expiry_dates   # fallback to all if no monthly found
    else:
        candidates = expiry_dates
    best, best_diff = None, 9999
    for ed in candidates:
        diff = abs(_days_to_expiry(ed) - target_days)
        if diff < best_diff:
            best_diff = diff
            best = ed
    return best


def _enrich_strike(row: dict, spot: float, dte: int, side: str) -> dict:
    """Extract + enrich one option row with BS Greeks."""
    from api.routes.cc_strategy import _bs_greeks
    leg   = row.get(side, {})
    strike = float(row.get("strikePrice", 0))
    ltp    = float(leg.get("lastPrice", 0) or 0)
    iv_pct = float(leg.get("impliedVolatility", 0) or 0)
    oi     = int(leg.get("openInterest", 0) or 0)
    bid    = float(leg.get("buyPrice1", 0) or 0)
    ask    = float(leg.get("sellPrice1", 0) or 0)
    vol    = int(leg.get("totalTradedVolume", 0) or 0)

    greeks = {}
    if iv_pct > 0 and ltp > 0:
        g = _bs_greeks(spot, strike, iv_pct, dte)
        if side == "PE":   # put delta is negative
            g["delta"] = round(g.get("delta", 0) - 1, 3)
        greeks = g

    return {
        "strike": strike, "ltp": round(ltp, 2), "iv": round(iv_pct, 1),
        "oi": oi, "bid": round(bid, 2), "ask": round(ask, 2), "vol": vol,
        **greeks,
    }


def _fetch_collar_chain(
    underlying_type: str,
    symbol:          str,
    expiry_days:     int,
    monthly_only:    bool = False,
) -> dict:
    """
    Fetch option chain for either index or stock.
    Returns: {spot, expiry, dte, rows, is_index, lot_size, bare, round_step, yf_sym}
    """
    import yfinance as yf
    from jugaad_data.nse import NSELive
    import time

    nse = NSELive()

    if underlying_type in _INDEX_META:
        meta      = _INDEX_META[underlying_type]
        chain_sym = meta["chain_sym"]
        lot_size  = meta["lot"]
        yf_sym    = meta["yf_sym"]
        round_step = meta.get("round_step", 100)
        is_index  = True

        fi  = yf.Ticker(yf_sym).fast_info
        spot = float(getattr(fi, "last_price", None) or 0)

        chain = nse.index_option_chain(chain_sym)
    else:
        # Stock
        sym = symbol.upper()
        if not sym.endswith(".NS"):
            sym += ".NS"
        bare = sym.replace(".NS", "")
        from api.routes.cc_strategy import LOT_SIZES
        lot_size  = LOT_SIZES.get(bare, 100)
        chain_sym = bare
        yf_sym    = sym
        round_step = 50          # stock options: prefer 50-point round strikes
        is_index  = False

        fi   = yf.Ticker(sym).fast_info
        spot = float(getattr(fi, "last_price", None) or 0)

        chain = nse.equities_option_chain(bare)

    rec          = chain.get("records", {})
    expiry_dates = rec.get("expiryDates", [])
    spot_chain   = float(rec.get("underlyingValue") or spot or 1)

    # Use spot from chain when available — more reliable intraday
    if spot_chain > 0:
        spot = spot_chain

    # Pick best expiry (monthly only when requested)
    best_expiry = _pick_expiry_for_collar(expiry_dates, expiry_days, monthly_only=monthly_only)
    dte         = _days_to_expiry(best_expiry) if best_expiry else expiry_days

    # Refetch with specific expiry if available
    if best_expiry and expiry_dates:
        time.sleep(0.08)
        if is_index:
            chain2 = nse.index_option_chain(chain_sym, expiry=best_expiry)
        else:
            chain2 = nse.equities_option_chain(chain_sym, expiry=best_expiry)
        rows = (chain2.get("filtered", {}).get("data") or
                chain2.get("records", {}).get("data") or [])
    else:
        rows = rec.get("data") or []

    return {
        "spot":       spot,
        "expiry":     best_expiry or "",
        "dte":        dte,
        "rows":       rows,
        "is_index":   is_index,
        "lot_size":   lot_size,
        "bare":       chain_sym,
        "yf_sym":     yf_sym,
        "round_step": round_step,
        "all_expiries": expiry_dates,
    }


def _collar_analyze(
    underlying_type: str,
    symbol:          str,
    qty:             int,
    avg_cost:        float,
    call_otm_pct:    float,
    put_otm_pct:     float,
    expiry_days:     int,
) -> dict:
    import math
    from api.routes.cc_strategy import (
        _bs_greeks, _prob_above, _prob_below, _price_range, _iv_spike_risk,
        LOT_SIZES,
    )

    try:
        chain_data = _fetch_collar_chain(underlying_type, symbol, expiry_days)
    except Exception as e:
        return {"error": f"Failed to fetch option chain: {str(e)[:120]}"}

    spot     = chain_data["spot"]
    rows     = chain_data["rows"]
    dte      = chain_data["dte"]
    expiry   = chain_data["expiry"]
    lot_size = chain_data["lot_size"]
    bare     = chain_data["bare"]
    is_index = chain_data["is_index"]

    if not spot or spot <= 0:
        return {"error": "Could not fetch spot price. Market may be closed or symbol invalid."}

    # Entry price: for index use spot (user's futures entry); for stock use avg_cost
    entry_price = avg_cost if avg_cost > 0 else spot

    # Find best call + put closest to OTM targets
    call_target = spot * (1 + call_otm_pct / 100)
    put_target  = spot * (1 - put_otm_pct  / 100)

    best_call_dist = best_put_dist = 1e9
    call_row = put_row = None
    for r in rows:
        strike = float(r.get("strikePrice", 0))
        if r.get("CE") and r["CE"].get("lastPrice", 0) > 0:
            dist = abs(strike - call_target)
            if dist < best_call_dist:
                best_call_dist = dist
                call_row = r
        if r.get("PE") and r["PE"].get("lastPrice", 0) > 0:
            dist = abs(strike - put_target)
            if dist < best_put_dist:
                best_put_dist = dist
                put_row = r

    # Enrich with Greeks
    call = _enrich_strike(call_row, spot, dte, "CE") if call_row else None
    put  = _enrich_strike(put_row,  spot, dte, "PE") if put_row  else None

    # Fallback strikes when chain unavailable
    call_strike = call["strike"] if call else round(call_target / 50) * 50
    put_strike  = put["strike"]  if put  else round(put_target  / 50) * 50

    # Premiums
    call_ltp = call["ltp"] if call else 0.0
    put_ltp  = put["ltp"]  if put  else 0.0
    net_per_unit   = round(call_ltp - put_ltp, 2)           # per unit (index point or ₹/share)
    net_total      = round(net_per_unit * lot_size, 2)       # total ₹

    # ATM IV (average of call + put IV, or whichever is available)
    atm_iv = 0.0
    if call and call.get("iv", 0) > 0 and put and put.get("iv", 0) > 0:
        atm_iv = (call["iv"] + put["iv"]) / 2
    elif call and call.get("iv", 0) > 0:
        atm_iv = call["iv"]
    elif put and put.get("iv", 0) > 0:
        atm_iv = put["iv"]

    # P&L boundaries
    max_gain_pu  = round(call_strike - entry_price + net_per_unit, 2)
    max_loss_pu  = round(put_strike  - entry_price + net_per_unit, 2)
    max_gain     = round(max_gain_pu * qty, 2)
    max_loss     = round(max_loss_pu * qty, 2)
    breakeven    = round(entry_price - net_per_unit, 2)
    prot_pct     = round((1 - put_strike / spot) * 100, 2) if spot > 0 else 0

    # Margin estimate: 12% of lot value (notional SPAN approximation)
    margin_est   = round(spot * lot_size * 0.12, 0)
    ann_yield    = round(net_total / margin_est * (365 / dte) * 100, 2) if margin_est > 0 else 0

    # Black-Scholes probabilities (using call IV as primary)
    iv_for_prob  = atm_iv if atm_iv > 0 else 20.0
    prob_above_call  = _prob_above(spot, call_strike, iv_for_prob, dte)
    prob_below_put   = _prob_below(spot, put_strike,  iv_for_prob, dte)
    prob_in_range    = round(max(0, 100 - prob_above_call - prob_below_put), 1)

    # Price range (1σ, 2σ)
    price_range = _price_range(spot, iv_for_prob, dte) if iv_for_prob > 0 else {}

    # IV spike risk
    iv_spike = {}
    try:
        iv_spike = _iv_spike_risk(bare, expiry, atm_iv)
    except Exception:
        pass

    # Net Greeks for the collar position:
    # Long future: delta ≈ 1, gamma=theta=vega=0
    # Short call: -delta_call, -gamma_call, +theta_call (earn decay), -vega_call
    # Long put: +delta_put (negative), +gamma_put, -theta_put (pay decay), +vega_put
    call_delta = call.get("delta", 0) if call else 0
    put_delta  = abs(put.get("delta", 0)) if put else 0  # put delta is stored negative, show abs
    net_delta  = round(1.0 - call_delta - put_delta, 3)  # long fut + short call - long put

    # Recommendation
    if is_index:
        if max_loss_pu < 0:
            rec = f"PROTECTED — Max loss capped at {abs(prot_pct):.1f}% below spot. Upside capped at ₹{fmt_n(call_strike)}."
        else:
            rec = "NET CREDIT — Collar generates income. Both legs OTM at expiry = full credit kept."
    else:
        pnl_pct = round((spot / entry_price - 1) * 100, 1) if entry_price > 0 else 0
        if pnl_pct > 15:
            rec = f"STRONG FIT — You're up {pnl_pct}%. Collar locks in gains, limits further upside at ₹{fmt_n(call_strike)}."
        elif pnl_pct > 5:
            rec = f"GOOD FIT — Up {pnl_pct}%. Moderate protection recommended before results/events."
        elif pnl_pct < -5:
            rec = f"DEFENSIVE — Position down {abs(pnl_pct)}%. Collar limits further loss below ₹{fmt_n(put_strike)}."
        else:
            rec = "NEUTRAL — Near cost basis. Collar adds stability, low net cost."

    return {
        "underlying_type":   underlying_type,
        "symbol":            bare,
        "is_index":          is_index,
        "qty":               qty,
        "lots":              max(1, qty // lot_size),
        "lot_size":          lot_size,
        "entry_price":       round(entry_price, 2),
        "spot":              round(spot, 2),
        "expiry":            expiry,
        "days_to_expiry":    dte,
        "all_expiries":      chain_data.get("all_expiries", [])[:6],

        "call_strike":       call_strike,
        "put_strike":        put_strike,
        "call_ltp":          round(call_ltp, 2),
        "put_ltp":           round(put_ltp, 2),
        "call_iv":           call.get("iv") if call else None,
        "put_iv":            put.get("iv")  if put  else None,
        "atm_iv":            round(atm_iv, 1) if atm_iv else None,
        "call_oi":           call.get("oi") if call else None,
        "put_oi":            put.get("oi")  if put  else None,
        "call_bid":          call.get("bid") if call else None,
        "call_ask":          call.get("ask") if call else None,
        "put_bid":           put.get("bid")  if put  else None,
        "put_ask":           put.get("ask")  if put  else None,

        # Greeks per lot (short call + long put)
        "call_delta":        round(call_delta, 3) if call else None,
        "call_gamma":        call.get("gamma")   if call else None,
        "call_theta":        call.get("theta")   if call else None,
        "call_vega":         call.get("vega")    if call else None,
        "put_delta":         round(-put_delta, 3) if put else None,  # negative (long put)
        "put_gamma":         put.get("gamma")    if put  else None,
        "put_theta":         put.get("theta")    if put  else None,
        "put_vega":          put.get("vega")     if put  else None,
        "net_delta":         net_delta,

        "net_per_unit":      net_per_unit,
        "net_total":         net_total,
        "is_credit":         net_per_unit >= 0,

        "max_gain_per_unit": max_gain_pu,
        "max_loss_per_unit": max_loss_pu,
        "max_gain":          max_gain,
        "max_loss":          max_loss,
        "max_gain_pct":      round(max_gain_pu / entry_price * 100, 2) if entry_price else 0,
        "max_loss_pct":      round(max_loss_pu / entry_price * 100, 2) if entry_price else 0,
        "breakeven":         breakeven,
        "protected_down_pct": prot_pct,
        "margin_est":        margin_est,
        "annualized_yield":  ann_yield,

        "prob_above_call":   prob_above_call,
        "prob_below_put":    prob_below_put,
        "prob_in_range":     prob_in_range,

        "price_range":       price_range,
        "iv_spike_risk":     iv_spike,
        "recommendation":    rec,
    }


def fmt_n(v) -> str:
    try:
        return f"{float(v):,.0f}"
    except Exception:
        return str(v)


# ═══════════════════════════════════════════════════════════════
# 4. WIDE WING IRON FLY
# ═══════════════════════════════════════════════════════════════

def _ironfly_analyze(
    underlying_type: str,
    symbol:          str,
    qty_lots:        int,
    wing_width_pct:  float,
    expiry_days:     int,
) -> dict:
    """
    Wide Wing Iron Fly:
      SELL ATM Call + SELL ATM Put  (body — collect max premium)
      BUY  OTM Call + BUY  OTM Put  (wings — cap max loss)

    Net credit = (sc_ltp + sp_ltp) - (bc_ltp + bp_ltp)
    Max profit = net_credit × lot_size × qty_lots  (spot pins at ATM at expiry)
    Max loss   = (wing_width - net_credit) × lot_size × qty_lots
    Break-evens: ATM ± net_credit
    """
    import math
    from api.routes.cc_strategy import (
        _bs_greeks, _prob_above, _prob_below, _price_range, _iv_spike_risk,
    )

    try:
        chain_data = _fetch_collar_chain(underlying_type, symbol, expiry_days, monthly_only=True)
    except Exception as e:
        return {"error": f"Failed to fetch option chain: {str(e)[:120]}"}

    spot       = chain_data["spot"]
    rows       = chain_data["rows"]
    dte        = chain_data["dte"]
    expiry     = chain_data["expiry"]
    lot_size   = chain_data["lot_size"]
    bare       = chain_data["bare"]
    is_index   = chain_data["is_index"]
    round_step = chain_data.get("round_step", 100)

    if not spot or spot <= 0:
        return {"error": "Could not fetch spot price. Market may be closed or symbol invalid."}
    if not rows:
        return {"error": "No option chain data available. Market may be closed."}

    # Round-number strike targets for better liquidity
    atm_target        = round(spot / round_step) * round_step
    upper_wing_target = round((spot * (1 + wing_width_pct / 100)) / round_step) * round_step
    lower_wing_target = round((spot * (1 - wing_width_pct / 100)) / round_step) * round_step

    # Find the 4 legs: ATM strike + wing strikes
    best_atm_dist = best_uc_dist = best_lw_dist = 1e9
    atm_row = uc_row = lw_row = None

    for r in rows:
        strike = float(r.get("strikePrice", 0))
        has_ce = r.get("CE") and r["CE"].get("lastPrice", 0) > 0
        has_pe = r.get("PE") and r["PE"].get("lastPrice", 0) > 0

        # ATM (needs both legs)
        if has_ce and has_pe:
            dist = abs(strike - atm_target)
            if dist < best_atm_dist:
                best_atm_dist = dist
                atm_row = r

        # Upper wing (call only)
        if has_ce:
            dist = abs(strike - upper_wing_target)
            if dist < best_uc_dist:
                best_uc_dist = dist
                uc_row = r

        # Lower wing (put only)
        if has_pe:
            dist = abs(strike - lower_wing_target)
            if dist < best_lw_dist:
                best_lw_dist = dist
                lw_row = r

    if not atm_row:
        return {"error": "Could not find ATM strike. Option chain may be sparse."}

    atm_strike = float(atm_row.get("strikePrice", spot))

    # Ensure wings are strictly beyond ATM
    if uc_row and float(uc_row["strikePrice"]) <= atm_strike:
        uc_row = None
    if lw_row and float(lw_row["strikePrice"]) >= atm_strike:
        lw_row = None

    # Enrich all legs
    sc = _enrich_strike(atm_row, spot, dte, "CE")  # SELL ATM Call
    sp = _enrich_strike(atm_row, spot, dte, "PE")  # SELL ATM Put
    bc = _enrich_strike(uc_row,  spot, dte, "CE") if uc_row else None  # BUY OTM Call (upper wing)
    bp = _enrich_strike(lw_row,  spot, dte, "PE") if lw_row else None  # BUY OTM Put  (lower wing)

    bc_strike = bc["strike"] if bc else round(upper_wing_target / 50) * 50
    bp_strike = bp["strike"] if bp else round(lower_wing_target / 50) * 50

    sc_ltp = sc["ltp"]
    sp_ltp = sp["ltp"]
    bc_ltp = bc["ltp"] if bc else 0.0
    bp_ltp = bp["ltp"] if bp else 0.0

    # Wing widths (may be asymmetric)
    upper_wing_width = bc_strike - atm_strike
    lower_wing_width = atm_strike - bp_strike
    wing_width_pts   = min(upper_wing_width, lower_wing_width)  # effective max loss wing

    # Net credit per unit
    net_credit_pu = round(sc_ltp + sp_ltp - bc_ltp - bp_ltp, 2)
    net_credit_total = round(net_credit_pu * lot_size * qty_lots, 2)

    # P&L per unit
    max_profit_pu = round(net_credit_pu, 2)
    max_loss_pu   = round(wing_width_pts - net_credit_pu, 2)  # per unit

    max_profit_total = round(max_profit_pu * lot_size * qty_lots, 2)
    max_loss_total   = round(max_loss_pu   * lot_size * qty_lots, 2)

    # Break-evens
    upper_be = round(atm_strike + net_credit_pu, 2)
    lower_be = round(atm_strike - net_credit_pu, 2)

    # ATM IV
    atm_iv = 0.0
    if sc.get("iv", 0) > 0 and sp.get("iv", 0) > 0:
        atm_iv = (sc["iv"] + sp["iv"]) / 2
    elif sc.get("iv", 0) > 0:
        atm_iv = sc["iv"]
    elif sp.get("iv", 0) > 0:
        atm_iv = sp["iv"]

    iv_for_prob = atm_iv if atm_iv > 0 else 20.0

    # Probabilities
    prob_above_upper_be = _prob_above(spot, upper_be, iv_for_prob, dte)
    prob_below_lower_be = _prob_below(spot, lower_be, iv_for_prob, dte)
    prob_profit         = round(max(0.0, 100.0 - prob_above_upper_be - prob_below_lower_be), 1)

    # Prob beyond wings (max loss zone)
    prob_above_uc = _prob_above(spot, bc_strike, iv_for_prob, dte) if bc else 0.0
    prob_below_lw = _prob_below(spot, bp_strike, iv_for_prob, dte) if bp else 0.0
    prob_max_loss = round(prob_above_uc + prob_below_lw, 1)

    # Price range
    price_range = _price_range(spot, iv_for_prob, dte) if iv_for_prob > 0 else {}

    # IV spike risk
    iv_spike = {}
    try:
        iv_spike = _iv_spike_risk(bare, expiry, atm_iv)
    except Exception:
        pass

    # Net Greeks  (iron fly = short 2 ATM + long 2 OTM)
    # Delta: net ≈ 0 for symmetric ATM iron fly
    sc_delta  = sc.get("delta", 0) or 0
    sp_delta  = sp.get("delta", 0) or 0   # stored negative for puts
    bc_delta  = bc.get("delta", 0) if bc else 0
    bp_delta  = bp.get("delta", 0) if bp else 0  # negative for put

    net_delta = round(-sc_delta - sp_delta + bc_delta + bp_delta, 3)

    # Theta (earn decay on shorts, pay on longs)
    sc_theta  = sc.get("theta", 0) or 0
    sp_theta  = sp.get("theta", 0) or 0
    bc_theta  = bc.get("theta", 0) if bc else 0
    bp_theta  = bp.get("theta", 0) if bp else 0
    net_theta = round(-sc_theta - sp_theta + bc_theta + bp_theta, 3)  # positive = earn decay

    # Vega (short: lose when IV rises)
    sc_vega  = sc.get("vega", 0) or 0
    sp_vega  = sp.get("vega", 0) or 0
    bc_vega  = bc.get("vega", 0) if bc else 0
    bp_vega  = bp.get("vega", 0) if bp else 0
    net_vega = round(-sc_vega - sp_vega + bc_vega + bp_vega, 3)  # negative = short vega

    # Gamma (short: suffer from large moves)
    sc_gamma  = sc.get("gamma", 0) or 0
    sp_gamma  = sp.get("gamma", 0) or 0
    bc_gamma  = bc.get("gamma", 0) if bc else 0
    bp_gamma  = bp.get("gamma", 0) if bp else 0
    net_gamma = round(-sc_gamma - sp_gamma + bc_gamma + bp_gamma, 4)  # negative

    # Margin estimate: wing_width × lot_size × qty_lots × 1.1 (SPAN approximation)
    margin_est   = round(wing_width_pts * lot_size * qty_lots * 1.1, 0)
    ann_yield    = round(net_credit_total / margin_est * (365 / dte) * 100, 2) if margin_est > 0 else 0.0

    # Reward:Risk ratio
    rr_ratio = round(max_profit_pu / max_loss_pu, 2) if max_loss_pu > 0 else 0.0

    # Recommendation
    if net_credit_pu <= 0:
        rec = "⚠ Net DEBIT — iron fly should always be a net credit. Widen wings or check liquidity."
    elif net_theta < 0:
        rec = (f"⚠ HIGH PUT SKEW — net theta is negative ({round(net_theta,2)}/day), meaning you're paying "
               f"more for the long put (IV {bp.get('iv','?')}%) than you earn from the short body. "
               f"Wait for skew to normalise or narrow the lower wing.")
    elif prob_profit >= 60:
        rec = f"HIGH POP — {prob_profit}% probability of profit. Net credit ₹{fmt_n(net_credit_total)}. Ideal for low-volatility consolidation phase."
    elif prob_profit >= 45:
        rec = f"MODERATE POP — {prob_profit}% probability of profit. Max profit if {bare} stays within ₹{fmt_n(lower_be)}–₹{fmt_n(upper_be)}."
    else:
        rec = f"LOW POP — {prob_profit}% probability. Consider tighter wings or wait for lower IV."

    return {
        "underlying_type": underlying_type,
        "symbol":          bare,
        "is_index":        is_index,
        "qty_lots":        qty_lots,
        "lot_size":        lot_size,
        "spot":            round(spot, 2),
        "expiry":          expiry,
        "days_to_expiry":  dte,
        "all_expiries":    chain_data.get("all_expiries", [])[:6],
        "atm_iv":          round(atm_iv, 1) if atm_iv else None,

        # Legs
        "atm_strike":   atm_strike,
        "bc_strike":    bc_strike,
        "bp_strike":    bp_strike,

        "sc_ltp":  round(sc_ltp, 2),
        "sp_ltp":  round(sp_ltp, 2),
        "bc_ltp":  round(bc_ltp, 2),
        "bp_ltp":  round(bp_ltp, 2),

        "sc_iv":   sc.get("iv"),
        "sp_iv":   sp.get("iv"),
        "bc_iv":   bc.get("iv") if bc else None,
        "bp_iv":   bp.get("iv") if bp else None,

        "sc_oi":   sc.get("oi"),
        "sp_oi":   sp.get("oi"),
        "bc_oi":   bc.get("oi") if bc else None,
        "bp_oi":   bp.get("oi") if bp else None,

        "sc_bid":  sc.get("bid"),  "sc_ask":  sc.get("ask"),
        "sp_bid":  sp.get("bid"),  "sp_ask":  sp.get("ask"),
        "bc_bid":  bc.get("bid") if bc else None, "bc_ask": bc.get("ask") if bc else None,
        "bp_bid":  bp.get("bid") if bp else None, "bp_ask": bp.get("ask") if bp else None,

        # P&L
        "net_credit_pu":     net_credit_pu,
        "net_credit_total":  net_credit_total,
        "wing_width_pts":    wing_width_pts,
        "upper_wing_width":  upper_wing_width,
        "lower_wing_width":  lower_wing_width,
        "max_profit_pu":     max_profit_pu,
        "max_loss_pu":       max_loss_pu,
        "max_profit_total":  max_profit_total,
        "max_loss_total":    max_loss_total,
        "upper_be":          upper_be,
        "lower_be":          lower_be,
        "rr_ratio":          rr_ratio,
        "margin_est":        margin_est,
        "ann_yield":         ann_yield,

        # Probabilities
        "prob_profit":       prob_profit,
        "prob_max_loss":     prob_max_loss,
        "prob_above_upper_be": prob_above_upper_be,
        "prob_below_lower_be": prob_below_lower_be,
        "prob_above_uc":    prob_above_uc,
        "prob_below_lw":    prob_below_lw,

        # Greeks (net position)
        "net_delta": net_delta,
        "net_theta": net_theta,
        "net_vega":  net_vega,
        "net_gamma": net_gamma,

        # Per-leg Greeks
        "sc_delta": round(sc_delta, 3),  "sc_gamma": round(sc_gamma, 4),
        "sc_theta": round(sc_theta, 3),  "sc_vega":  round(sc_vega, 3),
        "sp_delta": round(sp_delta, 3),  "sp_gamma": round(sp_gamma, 4),
        "sp_theta": round(sp_theta, 3),  "sp_vega":  round(sp_vega, 3),
        "bc_delta": round(bc_delta, 3) if bc else None,
        "bc_gamma": round(bc_gamma, 4) if bc else None,
        "bc_theta": round(bc_theta, 3) if bc else None,
        "bc_vega":  round(bc_vega, 3)  if bc else None,
        "bp_delta": round(bp_delta, 3) if bp else None,
        "bp_gamma": round(bp_gamma, 4) if bp else None,
        "bp_theta": round(bp_theta, 3) if bp else None,
        "bp_vega":  round(bp_vega, 3)  if bp else None,

        "price_range":    price_range,
        "iv_spike_risk":  iv_spike,
        "recommendation": rec,
    }


@router.get("/strategies/ironfly")
async def ironfly_optimizer(
    underlying_type: str   = Query(default="nifty",
                                   description="nifty | banknifty | stock"),
    symbol:          str   = Query(default="",   description="Stock symbol (required when type=stock)"),
    qty_lots:        int   = Query(default=1,    description="Number of lots"),
    wing_width_pct:  float = Query(default=3.0,  description="Wing OTM % from ATM (wide = 3-5%)"),
    expiry_days:     int   = Query(default=30,   description="Preferred DTE"),
):
    """Analyse a Wide Wing Iron Fly (short straddle + long strangle) for index or stock."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    if underlying_type == "stock" and not symbol:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="symbol is required when underlying_type=stock")

    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        ThreadPoolExecutor(max_workers=1),
        lambda: _ironfly_analyze(underlying_type, symbol, qty_lots, wing_width_pct, expiry_days)
    )
    return JSONResponse(content=result)



# ═══════════════════════════════════════════════════════════════
# 5. CUSTOM FLY — STAGED ENTRY (legged-in iron fly)
# ═══════════════════════════════════════════════════════════════

def _customfly_chain(
    underlying_type: str,
    symbol:          str,
    wing_width_pct:  float,
    expiry_days:     int,
) -> dict:
    """
    Fetch live option chain for a staged-entry iron fly.
    Uses monthly expiries only and round-100 strike targets for liquidity.
    Returns all 4 suggested legs + spread summaries + trend analysis.
    """
    from api.routes.cc_strategy import _prob_above, _prob_below
    import yfinance as yf

    try:
        chain_data = _fetch_collar_chain(underlying_type, symbol, expiry_days, monthly_only=True)
    except Exception as e:
        return {"error": f"Failed to fetch option chain: {str(e)[:120]}"}

    spot       = chain_data["spot"]
    rows       = chain_data["rows"]
    dte        = chain_data["dte"]
    expiry     = chain_data["expiry"]
    lot_size   = chain_data["lot_size"]
    bare       = chain_data["bare"]
    is_index   = chain_data["is_index"]
    round_step = chain_data.get("round_step", 100)
    yf_sym     = chain_data.get("yf_sym", "")

    if not spot or not rows:
        return {"error": "Could not fetch spot or option chain. Market may be closed."}

    # ── Trend analysis via yfinance history ────────────────────────────
    prev_day_chg = 0.0
    five_day_chg = 0.0
    last5_closes: list = []
    suggested_direction = "neutral"
    direction_reason    = "No strong trend detected — consider entering all legs simultaneously."
    try:
        hist   = yf.Ticker(yf_sym).history(period="10d")
        closes = hist["Close"].dropna().tolist()
        if len(closes) >= 2:
            prev_day_chg = round(spot - closes[-2], 2)
        if len(closes) >= 6:
            five_day_chg = round(spot - closes[-6], 2)
        elif closes:
            five_day_chg = round(spot - closes[0], 2)
        last5_closes = [round(c, 2) for c in closes[-5:]]

        if prev_day_chg >= 100:
            suggested_direction = "up"
            direction_reason = (
                f"Market up {prev_day_chg:+.0f} pts yesterday — call IV likely elevated. "
                f"Enter Bear Call Spread first (Stage 1), add Put Spread after pullback."
            )
        elif prev_day_chg <= -100:
            suggested_direction = "down"
            direction_reason = (
                f"Market down {prev_day_chg:+.0f} pts yesterday — put skew likely elevated. "
                f"Enter Bull Put Spread first (Stage 1), add Call Spread after bounce."
            )
        elif five_day_chg >= 300:
            suggested_direction = "up"
            direction_reason = (
                f"5-day uptrend ({five_day_chg:+.0f} pts) with mild yesterday ({prev_day_chg:+.0f}). "
                f"Call premiums likely still elevated — entering call spread first is preferred."
            )
        elif five_day_chg <= -300:
            suggested_direction = "down"
            direction_reason = (
                f"5-day downtrend ({five_day_chg:+.0f} pts) with mild yesterday ({prev_day_chg:+.0f}). "
                f"Put skew likely elevated — entering put spread first is preferred."
            )
        else:
            suggested_direction = "neutral"
            direction_reason = (
                f"No strong directional bias (yesterday {prev_day_chg:+.0f} pts, "
                f"5-day {five_day_chg:+.0f} pts). Enter all 4 legs simultaneously."
            )
    except Exception:
        pass   # trend data is advisory; don't fail the whole response

    # ── Round-number strike targets (prefer multiples of round_step for liquidity) ──
    atm_target        = round(spot / round_step) * round_step
    upper_wing_target = round((spot * (1 + wing_width_pct / 100)) / round_step) * round_step
    lower_wing_target = round((spot * (1 - wing_width_pct / 100)) / round_step) * round_step

    best_atm_d = best_uc_d = best_lw_d = 1e9
    atm_row = uc_row = lw_row = None

    for r in rows:
        strike  = float(r.get("strikePrice", 0))
        has_ce  = r.get("CE") and r["CE"].get("lastPrice", 0) > 0
        has_pe  = r.get("PE") and r["PE"].get("lastPrice", 0) > 0

        if has_ce and has_pe:
            d = abs(strike - atm_target)
            if d < best_atm_d:
                best_atm_d, atm_row = d, r
        if has_ce:
            d = abs(strike - upper_wing_target)
            if d < best_uc_d:
                best_uc_d, uc_row = d, r
        if has_pe:
            d = abs(strike - lower_wing_target)
            if d < best_lw_d:
                best_lw_d, lw_row = d, r

    if not atm_row:
        return {"error": "Could not find ATM strike."}

    atm_strike = float(atm_row["strikePrice"])
    if uc_row and float(uc_row["strikePrice"]) <= atm_strike:
        uc_row = None
    if lw_row and float(lw_row["strikePrice"]) >= atm_strike:
        lw_row = None

    sc = _enrich_strike(atm_row, spot, dte, "CE")
    sp = _enrich_strike(atm_row, spot, dte, "PE")
    bc = _enrich_strike(uc_row,  spot, dte, "CE") if uc_row else None
    bp = _enrich_strike(lw_row,  spot, dte, "PE") if lw_row else None

    bc_strike = float(uc_row["strikePrice"]) if uc_row else upper_wing_target
    bp_strike = float(lw_row["strikePrice"]) if lw_row else lower_wing_target

    call_spread_credit = round(sc["ltp"] - (bc["ltp"] if bc else 0), 2)
    put_spread_credit  = round(sp["ltp"] - (bp["ltp"] if bp else 0), 2)
    total_credit       = round(call_spread_credit + put_spread_credit, 2)

    atm_iv = ((sc.get("iv", 0) or 0) + (sp.get("iv", 0) or 0)) / 2
    iv_for_prob = atm_iv if atm_iv > 0 else 20.0

    wing_pts    = min(bc_strike - atm_strike, atm_strike - bp_strike)
    max_loss_pu = round(wing_pts - total_credit, 2)
    upper_be    = round(atm_strike + total_credit, 2)
    lower_be    = round(atm_strike - total_credit, 2)
    pop         = round(max(0, 100 - _prob_above(spot, upper_be, iv_for_prob, dte)
                                  - _prob_below(spot, lower_be,  iv_for_prob, dte)), 1)

    def _leg_dict(enriched, type_label, pos, stage):
        if not enriched:
            return None
        return {
            "type":   type_label,  "pos":   pos,
            "strike": enriched["strike"],   "ltp": enriched["ltp"],
            "iv":     enriched.get("iv"),   "oi":  enriched.get("oi"),
            "bid":    enriched.get("bid"),  "ask": enriched.get("ask"),
            "stage":  stage,
        }

    return {
        "underlying_type": underlying_type,
        "symbol":          bare,
        "is_index":        is_index,
        "spot":            round(spot, 2),
        "expiry":          expiry,
        "dte":             dte,
        "lot_size":        lot_size,
        "all_expiries":    chain_data.get("all_expiries", [])[:6],
        "atm_iv":          round(atm_iv, 1),
        "atm_strike":      atm_strike,
        "bc_strike":       bc_strike,
        "bp_strike":       bp_strike,
        "wing_width_pct":  wing_width_pct,
        "trend": {
            "prev_day_chg":        prev_day_chg,
            "five_day_chg":        five_day_chg,
            "last5_closes":        last5_closes,
            "suggested_direction": suggested_direction,
            "direction_reason":    direction_reason,
        },
        "sc":  _leg_dict(sc, "CE", "short", 1),
        "sp":  _leg_dict(sp, "PE", "short", 2),
        "bc":  _leg_dict(bc, "CE", "long",  1),
        "bp":  _leg_dict(bp, "PE", "long",  2),
        "call_spread": {
            "short_strike":  atm_strike,    "long_strike":   bc_strike,
            "short_ltp":     sc["ltp"],     "long_ltp":      bc["ltp"] if bc else 0,
            "net_credit":    call_spread_credit,
            "net_credit_rs": round(call_spread_credit * lot_size, 2),
        },
        "put_spread": {
            "short_strike":  atm_strike,    "long_strike":   bp_strike,
            "short_ltp":     sp["ltp"],     "long_ltp":      bp["ltp"] if bp else 0,
            "net_credit":    put_spread_credit,
            "net_credit_rs": round(put_spread_credit * lot_size, 2),
        },
        "combined": {
            "total_credit":    total_credit,
            "total_credit_rs": round(total_credit * lot_size, 2),
            "wing_width_pts":  wing_pts,
            "max_loss_pu":     max_loss_pu,
            "max_loss_rs":     round(max_loss_pu * lot_size, 2),
            "upper_be":        upper_be,
            "lower_be":        lower_be,
            "pop":             pop,
        },
        # ── OI distribution (for chart background bars) ─────────────
        "oi_distribution": sorted([
            {
                "strike":   float(r.get("strikePrice", 0)),
                "call_oi":  int(r.get("CE", {}).get("openInterest", 0) or 0),
                "put_oi":   int(r.get("PE", {}).get("openInterest", 0) or 0),
            }
            for r in rows
            if abs(float(r.get("strikePrice", 0)) - spot) / max(spot, 1) <= 0.12
        ], key=lambda x: x["strike"]),
        # ── Standard deviation bands ─────────────────────────────────
        "sd": (lambda iv=atm_iv, s=spot, d=dte: {
            "sd1_pts":   round(s * (iv/100) / (252**0.5) * (d**0.5), 0),
            "sd2_pts":   round(s * (iv/100) / (252**0.5) * (d**0.5) * 2, 0),
            "upper_1sd": round(s + s*(iv/100)/(252**0.5)*(d**0.5), 0),
            "lower_1sd": round(s - s*(iv/100)/(252**0.5)*(d**0.5), 0),
            "upper_2sd": round(s + s*(iv/100)/(252**0.5)*(d**0.5)*2, 0),
            "lower_2sd": round(s - s*(iv/100)/(252**0.5)*(d**0.5)*2, 0),
        })() if atm_iv > 0 else None,
    }


@router.get("/strategies/customfly")
async def customfly_endpoint(
    underlying_type: str   = Query(default="nifty"),
    symbol:          str   = Query(default=""),
    wing_width_pct:  float = Query(default=5.0),
    expiry_days:     int   = Query(default=30),
):
    """Fetch live option chain for staged-entry Custom Fly."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    if underlying_type == "stock" and not symbol:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="symbol required when underlying_type=stock")
    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        ThreadPoolExecutor(max_workers=1),
        lambda: _customfly_chain(underlying_type, symbol, wing_width_pct, expiry_days)
    )
    return JSONResponse(content=result)


@router.get("/strategies/collar")
async def collar_optimizer(
    underlying_type: str   = Query(default="stock",
                                   description="nifty | banknifty | finnifty | sensex | stock"),
    symbol:          str   = Query(default="",    description="Stock symbol (required when type=stock)"),
    qty:             int   = Query(default=75,    description="Quantity (shares for stock, units for index)"),
    avg_cost:        float = Query(default=0.0,   description="Entry/avg buy price (0 = use spot)"),
    call_otm_pct:    float = Query(default=2.0,   description="Sell call OTM %"),
    put_otm_pct:     float = Query(default=2.0,   description="Buy put OTM %"),
    expiry_days:     int   = Query(default=30,    description="Preferred DTE"),
):
    """Analyze a protective collar for index futures or stock position."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    if underlying_type == "stock" and not symbol:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="symbol is required when underlying_type=stock")

    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        ThreadPoolExecutor(max_workers=1),
        lambda: _collar_analyze(underlying_type, symbol, qty, avg_cost,
                                call_otm_pct, put_otm_pct, expiry_days)
    )
    return JSONResponse(content=result)

