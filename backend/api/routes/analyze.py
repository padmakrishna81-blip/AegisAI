"""Analyze endpoint — full 6-engine analysis for a single stock."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from engines.recommendation import calculate_full
from engines import company_health, technical_strength
from data.market_data import get_info, normalize_symbol, safe_get
from api.utils import clean_for_json

router = APIRouter()


@router.get("/analyze/{symbol}")
async def analyze_stock(symbol: str):
    """Full analysis: all 6 engines + AI verdict."""
    sym = normalize_symbol(symbol)
    try:
        result = calculate_full(sym)
        # Enrich with prev_close + day change for consistency with /ai/explain
        info       = get_info(sym)
        cmp        = result.get("current_price") or 0
        prev_close = safe_get(info, "previousClose") or safe_get(info, "regularMarketPreviousClose")
        if cmp and prev_close:
            result["prev_close"]  = round(float(prev_close), 2)
            result["change_inr"]  = round(float(cmp) - float(prev_close), 2)
            result["change_pct"]  = round((float(cmp) / float(prev_close) - 1) * 100, 2)
        return JSONResponse(content=clean_for_json(result))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/analyze/{symbol}/quick")
async def quick_analyze(symbol: str):
    """Quick analysis: Company Health + Technical only (faster)."""
    sym = normalize_symbol(symbol)
    try:
        info = get_info(sym)
        company_name = safe_get(info, "longName", default=sym) or sym
        current_price = safe_get(info, "currentPrice", default=0) or safe_get(info, "regularMarketPrice", default=0) or 0

        ch_result = company_health.calculate(sym)
        tech_result = technical_strength.calculate(sym)

        ch_score = ch_result.get("score", 50)
        tech_score = tech_result.get("score", 50)
        overall = round(ch_score * 0.6 + tech_score * 0.4)

        return {
            "symbol": sym,
            "company_name": company_name,
            "current_price": current_price,
            "overall_score": overall,
            "company_health": ch_score,
            "technical_strength": tech_score,
            "recommendation": "BUY" if overall >= 75 else "HOLD" if overall >= 55 else "SELL",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


import math as _math


@router.get("/analyze/{symbol}/volatility")
async def analyze_volatility(symbol: str, sessions: int = 50, threshold_pct: float = 5.0):
    """
    Price movement analysis over last N trading sessions.
    Returns large day moves, gaps, NIFTY correlation, and confidence score for options selling.
    """
    import yfinance as yf
    import pandas as pd

    sym = normalize_symbol(symbol)
    try:
        ticker = yf.Ticker(sym)
        hist   = ticker.history(period="3mo")
        if hist.empty or len(hist) < 10:
            raise HTTPException(status_code=404, detail=f"Insufficient history for {sym}")

        hist = hist.tail(sessions).copy()
        actual_sessions = len(hist)

        hist["day_chg_pct"] = hist["Close"].pct_change() * 100
        hist["gap_pct"]     = ((hist["Open"] - hist["Close"].shift(1)) / hist["Close"].shift(1)) * 100

        try:
            nifty = yf.Ticker("^NSEI").history(period="3mo").tail(sessions + 5)
            nifty["nifty_chg"] = nifty["Close"].pct_change() * 100
            hist.index  = pd.to_datetime(hist.index.date)
            nifty.index = pd.to_datetime(nifty.index.date)
            merged = hist.join(nifty[["nifty_chg"]], how="left")
        except Exception:
            merged = hist.copy()
            merged["nifty_chg"] = float("nan")

        large_day = merged[abs(merged["day_chg_pct"]) > threshold_pct].dropna(subset=["day_chg_pct"])
        day_moves_detail = []
        for idx, row in large_day.iterrows():
            nc = row.get("nifty_chg", float("nan"))
            nc_ok = not _math.isnan(float(nc)) if nc is not None else False
            with_nifty = ("with Nifty" if (nc_ok and (row["day_chg_pct"] > 0) == (nc > 0))
                          else "vs Nifty" if nc_ok else "Nifty N/A")
            day_moves_detail.append({
                "date":          str(idx.date() if hasattr(idx, "date") else idx)[:10],
                "change_pct":    round(float(row["day_chg_pct"]), 2),
                "close":         round(float(row["Close"]), 2),
                "direction":     "up" if row["day_chg_pct"] > 0 else "down",
                "nifty_pct":     round(float(nc), 2) if nc_ok else None,
                "aligned_nifty": with_nifty,
            })
        day_moves_detail.sort(key=lambda x: abs(x["change_pct"]), reverse=True)

        large_gap = merged[abs(merged["gap_pct"]) > threshold_pct].dropna(subset=["gap_pct"])
        gap_detail = []
        for idx, row in large_gap.iterrows():
            nc = row.get("nifty_chg", float("nan"))
            nc_ok = not _math.isnan(float(nc)) if nc is not None else False
            gap_detail.append({
                "date":       str(idx.date() if hasattr(idx, "date") else idx)[:10],
                "gap_pct":    round(float(row["gap_pct"]), 2),
                "open":       round(float(row["Open"]), 2),
                "prev_close": round(float(row["Close"]), 2),
                "direction":  "up" if row["gap_pct"] > 0 else "down",
                "nifty_pct":  round(float(nc), 2) if nc_ok else None,
            })
        gap_detail.sort(key=lambda x: abs(x["gap_pct"]), reverse=True)

        chg = merged["day_chg_pct"].dropna()
        gap = merged["gap_pct"].dropna()

        max_up_day   = round(float(chg.max()), 2)
        max_down_day = round(float(chg.min()), 2)
        max_gap_up   = round(float(gap.max()), 2)
        max_gap_down = round(float(gap.min()), 2)
        avg_abs_move = round(float(chg.abs().mean()), 2)
        moves_count  = len(large_day)
        gaps_count   = len(large_gap)

        aligned = merged.dropna(subset=["day_chg_pct", "nifty_chg"])
        nifty_align_pct = None
        if not aligned.empty:
            same_dir = ((aligned["day_chg_pct"] > 0) == (aligned["nifty_chg"] > 0)).mean()
            nifty_align_pct = round(float(same_dir) * 100, 1)

        base_score = 100
        base_score -= moves_count * 8
        base_score -= gaps_count  * 10
        base_score -= max(0, abs(max_up_day)   - 3) * 3
        base_score -= max(0, abs(max_down_day) - 3) * 3
        base_score -= max(0, avg_abs_move - 1.5) * 5
        if nifty_align_pct and nifty_align_pct > 70:
            base_score += 5
        confidence = max(0, min(100, round(base_score)))

        worst_move    = max(abs(max_up_day), abs(max_down_day))
        suggested_otm = round(max(8, min(15, worst_move * 1.5)), 1)
        safe_note = (
            f"No moves >{threshold_pct}% in last {actual_sessions} sessions. "
            f"Selling ≥{suggested_otm}% OTM adds {suggested_otm/max(worst_move,0.1):.1f}× buffer over max {worst_move:.1f}% historical move."
            if moves_count == 0 else
            f"⚠ {moves_count} large day move(s) >5% in {actual_sessions} sessions. "
            f"Selling ≥{suggested_otm}% OTM provides {suggested_otm/max(worst_move,0.1):.1f}× buffer over {worst_move:.1f}% max move."
        )

        # ── Expiry-cycle analysis (last 12 months of monthly expiry windows) ──
        # For each NSE monthly expiry cycle (last Thu of month → last Thu next month),
        # compute how much the stock moved within that ~30-day window.
        # This directly answers: "would my strike have been breached this cycle?"
        expiry_windows = []
        try:
            from datetime import date as date_cls, timedelta
            full_hist = ticker.history(period="1y")
            full_hist.index = pd.to_datetime(full_hist.index.date)
            full_close = full_hist["Close"]

            def _last_thursday(yr: int, mn: int):
                """Last Thursday of a given month."""
                import calendar
                # Find last day of month
                last_day = calendar.monthrange(yr, mn)[1]
                d = date_cls(yr, mn, last_day)
                while d.weekday() != 3:  # 3 = Thursday
                    d -= timedelta(days=1)
                return d

            today = date_cls.today()
            expiry_dates = []
            for offset in range(14, -1, -1):
                yr, mn = today.year, today.month - offset
                while mn <= 0: mn += 12; yr -= 1
                expiry_dates.append(_last_thursday(yr, mn))

            for i in range(len(expiry_dates) - 1):
                start_exp = expiry_dates[i]
                end_exp   = expiry_dates[i + 1]
                # Find prices on or just after each expiry date
                start_prices = full_close[full_close.index >= pd.Timestamp(start_exp)]
                end_prices   = full_close[full_close.index >= pd.Timestamp(end_exp)]
                if start_prices.empty or end_prices.empty:
                    continue
                sp = float(start_prices.iloc[0])
                ep = float(end_prices.iloc[0])
                # Max high and low WITHIN the window
                window_slice = full_hist[(full_hist.index >= pd.Timestamp(start_exp)) &
                                         (full_hist.index <= pd.Timestamp(end_exp))]
                if window_slice.empty:
                    continue
                wh = float(window_slice["High"].max())
                wl = float(window_slice["Low"].min())
                net_pct   = round((ep / sp - 1) * 100, 1)
                up_pct    = round((wh / sp - 1) * 100, 1)
                down_pct  = round((wl / sp - 1) * 100, 1)
                breached10 = up_pct > 10 or abs(down_pct) > 10
                expiry_windows.append({
                    "from":         str(start_exp),
                    "to":           str(end_exp),
                    "start_price":  round(sp, 1),
                    "end_price":      round(ep, 1),
                    "net_pct":        net_pct,
                    "max_up_pct":     up_pct,
                    "max_down_pct":   down_pct,
                    "breached_10pct": breached10,
                    "breached_up":    up_pct > 10,     # rose >10% — bad for CALL sellers
                    "breached_down":  abs(down_pct) > 10,  # fell >10% — bad for PUT sellers
                    "sessions":       len(window_slice),
                })
        except Exception:
            pass

        windows_breached      = sum(1 for w in expiry_windows if w["breached_10pct"])
        windows_breached_up   = sum(1 for w in expiry_windows if w.get("breached_up"))
        windows_breached_down = sum(1 for w in expiry_windows if w.get("breached_down"))
        windows_total         = len(expiry_windows)
        breach_rate_pct       = round(windows_breached / windows_total * 100, 1) if windows_total else None

        # Update confidence score to incorporate expiry window data
        if breach_rate_pct is not None:
            if breach_rate_pct > 50:
                confidence = max(0, confidence - 20)
            elif breach_rate_pct > 30:
                confidence = max(0, confidence - 10)
            elif breach_rate_pct == 0:
                confidence = min(100, confidence + 5)

        return JSONResponse(content=clean_for_json({
            "symbol": sym, "sessions_analysed": actual_sessions, "threshold_pct": threshold_pct,
            "large_day_moves_count": moves_count, "large_gaps_count": gaps_count,
            "max_up_day_pct": max_up_day, "max_down_day_pct": max_down_day,
            "max_gap_up_pct": max_gap_up, "max_gap_down_pct": max_gap_down,
            "avg_abs_daily_move": avg_abs_move,
            "nifty_alignment_pct": nifty_align_pct,
            "confidence_score": confidence,
            "suggested_min_otm": suggested_otm,
            "safe_strike_note": safe_note,
            "large_day_moves": day_moves_detail[:10],
            "large_gaps": gap_detail[:10],
            # Expiry cycle analysis
            "expiry_windows":           expiry_windows[-12:],
            "expiry_windows_total":     windows_total,
            "expiry_windows_breached":  windows_breached,
            "expiry_windows_up_breach": windows_breached_up,    # up>10% — CALL sellers risk
            "expiry_windows_dn_breach": windows_breached_down,  # down>10% — PUT sellers risk
            "expiry_breach_rate_pct":   breach_rate_pct,
        }))

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
