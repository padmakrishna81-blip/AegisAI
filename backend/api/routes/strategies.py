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
    "nifty":     {"chain_sym": "NIFTY",     "lot": 75,  "yf_sym": "^NSEI"},
    "banknifty": {"chain_sym": "BANKNIFTY", "lot": 35,  "yf_sym": "^NSEBANK"},
    "finnifty":  {"chain_sym": "FINNIFTY",  "lot": 65,  "yf_sym": "^NSEMDCP50"},
    "sensex":    {"chain_sym": "SENSEX",    "lot": 10,  "yf_sym": "^BSESN"},
}


def _days_to_expiry(expiry_str: str) -> int:
    """Parse '28-Aug-2026' → days from today (int)."""
    from datetime import datetime, date
    try:
        exp_dt = datetime.strptime(expiry_str, "%d-%b-%Y").date()
        return max(1, (exp_dt - date.today()).days)
    except Exception:
        return 30


def _pick_expiry_for_collar(expiry_dates: list, target_days: int) -> str | None:
    """Pick the NSE expiry string closest to target_days DTE."""
    if not expiry_dates:
        return None
    best, best_diff = None, 9999
    for ed in expiry_dates:
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


def _fetch_collar_chain(underlying_type: str, symbol: str, expiry_days: int) -> dict:
    """
    Fetch option chain for either index or stock.
    Returns: {spot, expiry, dte, rows, is_index, lot_size, bare}
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

    # Pick best expiry
    best_expiry = _pick_expiry_for_collar(expiry_dates, expiry_days)
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
        "spot":     spot,
        "expiry":   best_expiry or "",
        "dte":      dte,
        "rows":     rows,
        "is_index": is_index,
        "lot_size": lot_size,
        "bare":     chain_sym,
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

