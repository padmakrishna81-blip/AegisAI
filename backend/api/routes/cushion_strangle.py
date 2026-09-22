"""
Cushion Strangle Strategy — two modes:

Stock mode (equity):
  1. Buy 25% of lot size in shares (the "cushion")
  2. Sell 1 OTM CE + 1 OTM PE at delta ~0.20, 35-40 DTE
  3. If stock falls to 1SD → add another 25% shares
  4. If further down → let PE expire, get assigned at discount
  5. If stock rises → shares cushion limits CE loss; exit CE at delta ≥ 0.50

Index Futures mode:
  1. Buy 1 Futures lot (NIFTY/BANKNIFTY)
  2. Sell 2 OTM CE + 2 OTM PE at delta ~0.20, 35-40 DTE
  3. Exit CE when delta ≥ 0.50; no adjustments (set-and-forget)
"""

import math
import time
from typing import Optional, List, Dict, Any
from datetime import datetime, date
import yfinance as yf
import requests as _req
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter()

# ─── Black-Scholes core ───────────────────────────────────────────────────────

def _ncdf(x: float) -> float:
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def _npdf(x: float) -> float:
    return math.exp(-x * x / 2.0) / math.sqrt(2.0 * math.pi)

def _d1(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    s = iv / 100.0
    if s <= 0 or T <= 0 or S <= 0 or K <= 0:
        return 0.0
    return (math.log(S / K) + (r + 0.5 * s * s) * T) / (s * math.sqrt(T))

def call_price(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0: return max(0.0, S - K)
    d1 = _d1(S, K, iv, T, r); d2 = d1 - iv / 100 * math.sqrt(T)
    return S * _ncdf(d1) - K * math.exp(-r * T) * _ncdf(d2)

def put_price(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0: return max(0.0, K - S)
    d1 = _d1(S, K, iv, T, r); d2 = d1 - iv / 100 * math.sqrt(T)
    return K * math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1)

def call_delta(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0: return 1.0 if S >= K else 0.0
    return _ncdf(_d1(S, K, iv, T, r))

def put_delta_abs(S: float, K: float, iv: float, T: float, r: float = 0.065) -> float:
    if T <= 0: return 1.0 if S <= K else 0.0
    return 1.0 - _ncdf(_d1(S, K, iv, T, r))

def theta_per_day(S: float, K: float, iv: float, T: float, r: float = 0.065, is_call: bool = True) -> float:
    if T <= 0: return 0.0
    s = iv / 100
    d1 = _d1(S, K, iv, T, r); d2 = d1 - s * math.sqrt(T)
    base = -(S * _npdf(d1) * s) / (2 * math.sqrt(T))
    if is_call:
        return (base - r * K * math.exp(-r * T) * _ncdf(d2)) / 365
    else:
        return (base + r * K * math.exp(-r * T) * _ncdf(-d2)) / 365

def find_strike_for_delta(S: float, iv: float, T: float, target: float, is_call: bool = True, r: float = 0.065) -> float:
    lo, hi = S * 0.3, S * 3.0
    for _ in range(100):
        K = (lo + hi) / 2.0
        d = call_delta(S, K, iv, T, r) if is_call else put_delta_abs(S, K, iv, T, r)
        if abs(d - target) < 1e-6: break
        if is_call:
            if d > target: lo = K
            else: hi = K
        else:
            # put delta (abs) increases as K rises → higher K needed when d < target
            if d < target: lo = K
            else: hi = K
    return K

def _round_strike(K: float, cmp: float) -> float:
    interval = (2.5 if cmp < 100 else 5 if cmp < 250 else 10 if cmp < 500
                else 20 if cmp < 1000 else 50 if cmp < 2000 else 100)
    return round(K / interval) * interval

# ─── Symbol / lot-size helpers ────────────────────────────────────────────────

# Maps yfinance index symbols → (common name, yfinance ticker)
_SYMBOL_NORM = {
    '^NSEI':                  ('NIFTY',      '^NSEI'),
    '^NSEBANK':               ('BANKNIFTY',  '^NSEBANK'),
    'NIFTY_FIN_SERVICE.NS':   ('FINNIFTY',   'NIFTY_FIN_SERVICE.NS'),
    '^NSEMDCP50':             ('MIDCPNIFTY', '^NSEMDCP50'),
    '^CNXIT':                 ('CNXIT',      '^CNXIT'),
    '^CNXPHARMA':             ('CNXPHARMA',  '^CNXPHARMA'),
    '^CNXAUTO':               ('CNXAUTO',    '^CNXAUTO'),
    '^CNXFMCG':               ('CNXFMCG',    '^CNXFMCG'),
}

_LOTS = {
    # Index F&O
    "NIFTY": 65, "BANKNIFTY": 35, "FINNIFTY": 65, "MIDCPNIFTY": 120,
    # Nifty50 / F&O stocks (synced with cc_strategy.py LOT_SIZES)
    "ADANIENT":  309, "ADANIPORTS": 475, "APOLLOHOSP": 125, "ASIANPAINT": 250,
    "AXISBANK":  625, "BAJAJ-AUTO":  75, "BAJFINANCE": 750, "BAJAJFINSV": 300,
    "BEL":      1425, "BHARTIARTL": 475, "BPCL":      1975, "BRITANNIA":  125,
    "CHOLAFIN":  625, "CIPLA":       425, "COALINDIA": 1350, "DIVISLAB":   100,
    "DRREDDY":   625, "EICHERMOT":   100, "GRASIM":    250,  "HAL":        150,
    "HCLTECH":   400, "HDFCBANK":    650, "HDFCLIFE":  1100, "HEROMOTOCO": 150,
    "HINDALCO":  700, "HINDUNILVR":  300, "ICICIBANK":  700, "INFY":       400,
    "IOC":      4875, "IRCTC":       875, "ITC":       1725, "JSWSTEEL":   675,
    "KOTAKBANK":2000, "LT":          175, "M&M":        200, "MARUTI":      50,
    "NESTLEIND": 500, "NMDC":       6750, "NTPC":      1500, "ONGC":      2250,
    "POWERGRID":1900, "RELIANCE":    500, "SBIN":       750, "SBILIFE":    375,
    "SUNPHARMA": 350, "TATACONSUM":  550, "TATAMOTORS":1425, "TATASTEEL": 2750,
    "TCS":       225, "TECHM":       600, "TITAN":      175, "TRENT":      175,
    "ULTRACEMCO": 50, "VEDL":       1150, "WIPRO":     3000,
    # Others commonly traded in F&O
    "DMART":     100, "ZOMATO":     2475, "ETERNAL":   4500, "DLF":        950,
    "INDUSINDBK":700, "FEDERALBNK":2500, "BANKBARODA":2925, "PNB":       8000,
    "CANBK":    6750, "BHEL":       2625, "SAIL":      4700, "GAIL":      3825,
    "PFC":      1300, "RECLTD":     1575, "IRFC":      5425, "NHPC":      6950,
    "IDFCFIRSTB":9275,"MUTHOOTFIN": 275, "SHRIRAMFIN": 825, "PIDILITIND": 500,
    "UPL":      1300, "LUPIN":       425, "AUROPHARMA": 550, "ZYDUSLIFE":  900,
    "CDSL":      475, "MCX":         250, "CESC":       600, "GODREJPROP": 325,
    "PRESTIGE":  450, "SIEMENS":      75, "ABB":         75,
}

def _lot(sym: str) -> int:
    s = sym.upper()
    if s in _SYMBOL_NORM:
        clean = _SYMBOL_NORM[s][0]
    else:
        clean = s.replace('.NS', '').replace('.BO', '').replace('^', '')
    return _LOTS.get(clean, 500)

def _yf_sym(sym: str) -> str:
    s = sym.upper()
    if s in _SYMBOL_NORM:
        return _SYMBOL_NORM[s][1]
    if s.startswith('^') or 'NIFTY_FIN_SERVICE' in s:
        return s
    clean = s.replace('.NS', '').replace('.BO', '')
    return clean + '.NS'

def _is_index(sym: str) -> bool:
    s = sym.upper()
    return s.startswith('^') or s in _SYMBOL_NORM or 'NIFTY_FIN_SERVICE' in s

def _find_be(chart: list, side: str, cmp: float) -> float:
    """Find zero-crossing in stage1 P&L from chart data."""
    pts = sorted(chart, key=lambda d: d['price'])
    if side == 'down':
        candidates = [(d['price'], d['stage1']) for d in pts if d['price'] <= cmp and d['stage1'] is not None]
        candidates.reverse()
    else:
        candidates = [(d['price'], d['stage1']) for d in pts if d['price'] >= cmp and d['stage1'] is not None]

    for i in range(1, len(candidates)):
        p1, v1 = candidates[i - 1]
        p2, v2 = candidates[i]
        if v1 * v2 < 0 and (v2 - v1) != 0:
            t = -v1 / (v2 - v1)
            return round(p1 + (p2 - p1) * t, 2)
    return round(candidates[-1][0] if candidates else cmp, 2)

# ─── Prediction helpers ───────────────────────────────────────────────────────

_POS_NEWS = {
    'up','gain','beat','profit','strong','growth','rise','surge','positive',
    'outperform','upgrade','buy','bull','record','high','boost','rally','advance',
    'exceed','expand','robust','solid','optimistic','revenue','margin',
}
_NEG_NEWS = {
    'down','loss','miss','weak','fall','drop','decline','negative','sell','bear',
    'low','cut','downgrade','concern','risk','crash','warn','disappoint','slow',
    'contract','volatile','uncertain','trouble','slump','lawsuit','probe',
}

def _rsi(prices: list, period: int = 14) -> float:
    if len(prices) < period + 1: return 50.0
    deltas = [prices[i] - prices[i-1] for i in range(-period, 0)]
    gains  = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    ag = sum(gains) / period; al = sum(losses) / period
    if al == 0: return 100.0
    return 100.0 - 100.0 / (1.0 + ag / al)

def _sma(prices: list, period: int) -> float:
    if len(prices) < period: return prices[-1] if prices else 0.0
    return sum(prices[-period:]) / period

def _technical_bias(hist) -> tuple:
    """Returns (bias, signals, rsi, sma20, trend_5d)."""
    closes = hist['Close'].tolist()
    n = len(closes)
    if n < 5:
        return 0.0, ["Insufficient price history"], 50.0, closes[-1] if closes else 0.0, 0.0

    cmp_p = closes[-1]
    score = 0.0; count = 0; signals = []

    rsi_val = _rsi(closes)
    if   rsi_val >= 75: score -= 0.6; signals.append(f"RSI overbought {rsi_val:.0f} — reversal risk")
    elif rsi_val >= 60: score += 0.3; signals.append(f"RSI bullish momentum {rsi_val:.0f}")
    elif rsi_val <= 25: score += 0.6; signals.append(f"RSI oversold {rsi_val:.0f} — rebound likely")
    elif rsi_val <= 40: score -= 0.3; signals.append(f"RSI bearish {rsi_val:.0f}")
    else:               signals.append(f"RSI neutral {rsi_val:.0f}")
    count += 1

    sma20_val = cmp_p
    if n >= 20:
        sma20_val = _sma(closes, 20)
        pct = (cmp_p / sma20_val - 1) * 100
        if   pct >  3:   score += 0.4; signals.append(f"+{pct:.1f}% above SMA20 — uptrend")
        elif pct >  0.5: score += 0.2; signals.append(f"+{pct:.1f}% above SMA20")
        elif pct < -3:   score -= 0.4; signals.append(f"{pct:.1f}% below SMA20 — downtrend")
        elif pct < -0.5: score -= 0.2; signals.append(f"{pct:.1f}% below SMA20")
        else:            signals.append(f"Hugging SMA20 (₹{sma20_val:.0f})")
        count += 1

    if n >= 50:
        sma50 = _sma(closes, 50)
        if cmp_p > sma50: score += 0.2; signals.append(f"Above SMA50 (₹{sma50:.0f})")
        else:             score -= 0.2; signals.append(f"Below SMA50 (₹{sma50:.0f})")
        count += 1

    trend_5d = 0.0
    if n >= 6:
        trend_5d = (closes[-1] / closes[-6] - 1) * 100
        if   trend_5d >  5:  score += 0.5; signals.append(f"5-day surge +{trend_5d:.1f}%")
        elif trend_5d >  2:  score += 0.3; signals.append(f"5-day rally +{trend_5d:.1f}%")
        elif trend_5d >  0.5:score += 0.1; signals.append(f"5-day up +{trend_5d:.1f}%")
        elif trend_5d < -5:  score -= 0.5; signals.append(f"5-day sell-off {trend_5d:.1f}%")
        elif trend_5d < -2:  score -= 0.3; signals.append(f"5-day decline {trend_5d:.1f}%")
        elif trend_5d < -0.5:score -= 0.1; signals.append(f"5-day down {trend_5d:.1f}%")
        else:                signals.append(f"5-day flat {trend_5d:.1f}%")
        count += 1

    if n >= 20:
        s20 = _sma(closes, 20)
        std20 = math.sqrt(sum((c - s20) ** 2 for c in closes[-20:]) / 20.0)
        if std20 > 0:
            bb_pct = (cmp_p - (s20 - 2 * std20)) / (4 * std20)
            if   bb_pct > 0.90: score -= 0.3; signals.append(f"Near upper Bollinger band ({bb_pct:.0%})")
            elif bb_pct < 0.10: score += 0.3; signals.append(f"Near lower Bollinger band ({bb_pct:.0%})")
            else:               signals.append(f"Mid Bollinger band ({bb_pct:.0%})")

    bias = max(-1.0, min(1.0, score / max(count, 1)))
    return round(bias, 2), signals[:6], round(rsi_val, 1), round(sma20_val, 2), round(trend_5d, 1)

def _news_bias(yfsym: str) -> tuple:
    """Returns (bias, count, summary, headlines[:3])."""
    try:
        news_items = yf.Ticker(yfsym).news or []
    except Exception:
        return 0.0, 0, "News data unavailable", []
    if not news_items:
        return 0.0, 0, "No recent news found", []
    scores: list = []; headlines: list = []
    for item in news_items[:10]:
        title = (item.get('title') or item.get('headline') or '').lower()
        if not title: continue
        words = set(title.split())
        p, ng = len(words & _POS_NEWS), len(words & _NEG_NEWS)
        scores.append(1 if p > ng else -1 if ng > p else 0)
        headlines.append(item.get('title') or item.get('headline') or '')
    if not scores: return 0.0, 0, "No relevant headlines", []
    avg = round(sum(scores) / len(scores), 2)
    pos, neg, neu = scores.count(1), scores.count(-1), scores.count(0)
    return avg, len(scores), f"{pos} bullish · {neg} bearish · {neu} neutral", headlines[:3]

def _market_bias_score() -> tuple:
    """Returns (bias, nifty_5d_pct, summary)."""
    try:
        hist = yf.Ticker('^NSEI').history(period='12d')
        if hist.empty or len(hist) < 5: return 0.0, 0.0, "NIFTY data unavailable"
        p5d = (hist['Close'].iloc[-1] / hist['Close'].iloc[-5] - 1) * 100
        p1d = (hist['Close'].iloc[-1] / hist['Close'].iloc[-2] - 1) * 100
        if   p5d >  2.5: bias = 0.5;  tone = "strongly bullish"
        elif p5d >  0.8: bias = 0.3;  tone = "mildly bullish"
        elif p5d < -2.5: bias = -0.5; tone = "strongly bearish"
        elif p5d < -0.8: bias = -0.3; tone = "mildly bearish"
        else:            bias = 0.0;  tone = "neutral"
        return round(bias, 2), round(p5d, 1), f"NIFTY {p5d:+.1f}% (5d) · {p1d:+.1f}% today · {tone}"
    except Exception:
        return 0.0, 0.0, "Market data unavailable"

def _global_bias_score() -> tuple:
    """Returns (bias, summary)."""
    vals: dict = {}
    for tkr, name in {'^GSPC': 'S&P500', '^DJI': 'Dow', '^VIX': 'VIX'}.items():
        try:
            h = yf.Ticker(tkr).history(period='5d')
            if len(h) >= 2:
                vals[name] = round((h['Close'].iloc[-1] / h['Close'].iloc[-2] - 1) * 100, 2)
        except Exception:
            pass
    moves = [v for k, v in vals.items() if k != 'VIX']
    if not moves: return 0.0, "Global data unavailable"
    avg = sum(moves) / len(moves)
    vix = vals.get('VIX', 20.0)
    vix_note = f" · VIX {vix:.0f} ({'elevated' if vix > 25 else 'normal'})" if 'VIX' in vals else ''
    bias = 0.3 if avg > 0.5 else -0.3 if avg < -0.5 else 0.0
    sp = vals.get('S&P500', 0); dw = vals.get('Dow', 0)
    return round(bias, 2), f"S&P500 {sp:+.1f}% · Dow {dw:+.1f}%{vix_note}"

def _strategy_mid_pnl(price: float, T_rem: float, iv: float, r: float,
                       opt_legs: list, sh_legs: list) -> int:
    total = 0.0
    for o in opt_legs:
        qty = o['lots'] * o['lot_size']
        ep  = o.get('exit_premium')
        if ep is not None:
            total += (o['premium'] - float(ep)) * qty
        else:
            if T_rem > 0:
                cv = call_price(price, o['strike'], iv, T_rem, r) if o['type'] == 'CE' \
                     else put_price(price, o['strike'], iv, T_rem, r)
            else:
                cv = max(0.0, price - o['strike']) if o['type'] == 'CE' \
                     else max(0.0, o['strike'] - price)
            total += (o['premium'] - cv) * qty
    for s in sh_legs:
        ep = s.get('exit_price')
        if ep is not None:
            total += (float(ep) - s['buy_price']) * s['qty']
        else:
            total += (price - s['buy_price']) * s['qty']
    return int(round(total))

def _strategy_pnl_breakdown(price: float, T_rem: float, iv: float, r: float,
                              opt_legs: list, sh_legs: list) -> tuple:
    opt_t = 0.0
    for o in opt_legs:
        qty = o['lots'] * o['lot_size']
        ep  = o.get('exit_premium')
        if ep is not None:
            opt_t += (o['premium'] - float(ep)) * qty
        else:
            if T_rem > 0:
                cv = call_price(price, o['strike'], iv, T_rem, r) if o['type'] == 'CE' \
                     else put_price(price, o['strike'], iv, T_rem, r)
            else:
                cv = max(0.0, price - o['strike']) if o['type'] == 'CE' \
                     else max(0.0, o['strike'] - price)
            opt_t += (o['premium'] - cv) * qty
    sh_t = 0.0
    for s in sh_legs:
        ep = s.get('exit_price')
        if ep is not None:
            sh_t += (float(ep) - s['buy_price']) * s['qty']
        else:
            sh_t += (price - s['buy_price']) * s['qty']
    return int(round(opt_t)), int(round(sh_t))

def _prob_profit(cmp: float, drift: float, sigma_d: float, T_rem: float,
                  iv: float, r: float, opt_legs: list, sh_legs: list) -> float:
    """
    Probability that mid-cycle P&L > 0, integrating over the log-normal price distribution.
    drift and sigma_d are the mean/std of log(S_T / cmp).
    """
    if sigma_d < 1e-6:
        return 50.0
    n_pts = 300
    lo_x  = drift - 4 * sigma_d
    hi_x  = drift + 4 * sigma_d
    dx    = (hi_x - lo_x) / n_pts
    k     = sigma_d * math.sqrt(2 * math.pi)
    total = 0.0; profit = 0.0
    for i in range(n_pts):
        x     = lo_x + dx * (i + 0.5)
        price = cmp * math.exp(x)
        if price <= 0:
            continue
        z   = (x - drift) / sigma_d
        pdf = math.exp(-0.5 * z * z) / k
        pnl = _strategy_mid_pnl(price, T_rem, iv, r, opt_legs, sh_legs)
        total  += pdf * dx
        if pnl > 0:
            profit += pdf * dx
    if total < 1e-10:
        return 50.0
    return round(profit / total * 100, 1)

# ─── Analyze endpoint ─────────────────────────────────────────────────────────

class CushionParams(BaseModel):
    symbol: str
    instrument_type: str = "auto"   # "stock", "future", or "auto" (auto-detect from symbol)
    dte: int = 37
    target_delta: float = 0.20
    equity_pct: float = 0.25
    add_equity_pct: float = 0.25
    iv_override: Optional[float] = None
    rf: float = 0.065

@router.get("/cushion-strangle/quote/{symbol}")
async def quote_symbol(symbol: str):
    """Return CMP + historical IV + lot size for a symbol — used by the custom builder."""
    raw = symbol.upper()
    yfsym = _yf_sym(raw)
    lot   = _lot(raw)
    try:
        t   = yf.Ticker(yfsym)
        fi  = t.fast_info
        cmp = float(getattr(fi, "last_price", None) or getattr(fi, "open", None) or 0)
        if cmp <= 0:
            return JSONResponse({"error": "price unavailable"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    try:
        hist = t.history(period="2mo")
        if not hist.empty and len(hist) >= 10:
            rv = float(hist["Close"].pct_change().dropna().std() * math.sqrt(252) * 100)
            iv = round(rv * 1.15, 1)
        else:
            iv = 22.0
    except Exception:
        iv = 22.0
    clean = _SYMBOL_NORM.get(raw, (raw.replace('.NS', '').replace('.BO', '').replace('^', ''), ''))[0]
    return JSONResponse({"symbol": clean, "cmp": round(cmp, 2), "iv": iv, "lot_size": lot})


# ─── NSE live option price ────────────────────────────────────────────────────

_NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
}
_NSE_SESSION: Optional[_req.Session] = None
_NSE_SESSION_TS: float = 0.0
_NSE_SESSION_TTL = 300  # refresh cookies every 5 min


def _nse_session() -> _req.Session:
    global _NSE_SESSION, _NSE_SESSION_TS
    now = time.time()
    if _NSE_SESSION is None or (now - _NSE_SESSION_TS) > _NSE_SESSION_TTL:
        s = _req.Session()
        try:
            s.get("https://www.nseindia.com", headers=_NSE_HEADERS, timeout=8)
        except Exception:
            pass
        _NSE_SESSION = s
        _NSE_SESSION_TS = now
    return _NSE_SESSION


def _parse_expiry(expiry_str: str) -> Optional[date]:
    """Parse any reasonable date string into a date object."""
    fmts = ["%Y-%m-%d", "%d-%b-%Y", "%d/%m/%Y", "%d %b %Y", "%b %d, %Y", "%d-%m-%Y"]
    for fmt in fmts:
        try:
            return datetime.strptime(expiry_str.strip(), fmt).date()
        except ValueError:
            pass
    return None


def _nse_clean_sym(sym: str) -> str:
    """NSE option-chain uses plain symbols like INFY, NIFTY — strip suffixes."""
    raw = sym.upper()
    if raw in _SYMBOL_NORM:
        return _SYMBOL_NORM[raw][0]
    return raw.replace(".NS", "").replace(".BO", "").replace("^", "")


@router.get("/cushion-strangle/option-price/{symbol}")
async def get_option_price(
    symbol: str,
    strike: float = Query(...),
    expiry: str   = Query(...),
    opt_type: str = Query(...),
):
    """
    Return live LTP + IV for a specific NSE option contract.
    Tries NSE option-chain API first; falls back to yfinance.
    expiry: any parseable date string (2024-10-27, 27-Oct-2024, etc.)
    opt_type: CE or PE
    """
    raw      = symbol.upper()
    clean    = _nse_clean_sym(raw)
    otype    = opt_type.upper()
    t_expiry = _parse_expiry(expiry)

    # ── NSE primary ──────────────────────────────────────────────────────────
    try:
        is_idx = _is_index(raw)
        url = (
            f"https://www.nseindia.com/api/option-chain-indices?symbol={clean}"
            if is_idx else
            f"https://www.nseindia.com/api/option-chain-equities?symbol={clean}"
        )
        sess = _nse_session()
        r = sess.get(url, headers=_NSE_HEADERS, timeout=10)
        if r.status_code == 403:
            # Session stale — force refresh once
            global _NSE_SESSION_TS
            _NSE_SESSION_TS = 0.0
            sess = _nse_session()
            r = sess.get(url, headers=_NSE_HEADERS, timeout=10)

        if r.status_code == 200:
            data    = r.json()
            records = data.get("records", {}).get("data", [])
            best    = None
            best_dist = float("inf")
            for item in records:
                if otype not in item:
                    continue
                # Match strike
                if abs(item.get("strikePrice", -1) - strike) > strike * 0.01:
                    continue
                # Match expiry (compare date objects, tolerant of format differences)
                item_expiry_str = item.get("expiryDate", "")
                item_expiry = _parse_expiry(item_expiry_str)
                if item_expiry is None:
                    continue
                if t_expiry is not None:
                    dist = abs((item_expiry - t_expiry).days)
                    if dist > 3:
                        continue
                    if dist < best_dist:
                        best_dist = dist
                        best = item[otype]
                else:
                    best = item[otype]  # take first match if no expiry filter
                    break

            if best:
                ltp  = float(best.get("lastPrice") or 0)
                bid  = float(best.get("bidprice", best.get("bid", 0)) or 0)
                ask  = float(best.get("askPrice", best.get("ask", 0)) or 0)
                iv   = float(best.get("impliedVolatility") or 0)
                oi   = int(best.get("openInterest") or 0)
                vol  = int(best.get("totalTradedVolume", best.get("volume", 0)) or 0)
                mid  = round((bid + ask) / 2, 2) if bid > 0 and ask > 0 else ltp
                return JSONResponse({
                    "ltp":    round(ltp, 2),
                    "bid":    round(bid, 2),
                    "ask":    round(ask, 2),
                    "mid":    round(mid, 2),
                    "iv":     round(iv, 1),
                    "oi":     oi,
                    "volume": vol,
                    "source": "nse",
                })
    except Exception:
        pass  # fall through to yfinance

    # ── yfinance fallback ────────────────────────────────────────────────────
    try:
        yfsym = _yf_sym(raw)
        t = yf.Ticker(yfsym)
        available = t.options  # list of expiry date strings (YYYY-MM-DD)
        if not available:
            return JSONResponse({"error": "no option data"}, status_code=404)

        # Pick closest expiry date
        if t_expiry:
            target_ts = t_expiry.toordinal()
            chosen = min(available, key=lambda d: abs(
                datetime.strptime(d, "%Y-%m-%d").date().toordinal() - target_ts
            ))
        else:
            chosen = available[0]

        chain = t.option_chain(chosen)
        df    = chain.calls if otype == "CE" else chain.puts
        rows  = df[df["strike"].between(strike * 0.99, strike * 1.01)]
        if rows.empty:
            return JSONResponse({"error": "strike not found"}, status_code=404)
        row   = rows.iloc[0]
        ltp   = float(row.get("lastPrice", 0) or 0)
        bid   = float(row.get("bid", 0) or 0)
        ask   = float(row.get("ask", 0) or 0)
        iv    = round(float(row.get("impliedVolatility", 0) or 0) * 100, 1)
        mid   = round((bid + ask) / 2, 2) if bid > 0 and ask > 0 else ltp
        return JSONResponse({
            "ltp":    round(ltp, 2),
            "bid":    round(bid, 2),
            "ask":    round(ask, 2),
            "mid":    round(mid, 2),
            "iv":     round(iv, 1),
            "oi":     int(row.get("openInterest", 0) or 0),
            "volume": int(row.get("volume", 0) or 0),
            "source": "yfinance",
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)


class PredictStrategyBody(BaseModel):
    symbol: str
    cmp:     float
    iv:      float
    dte:     int
    rf:      float = 0.065
    options: List[Dict[str, Any]] = []
    shares:  List[Dict[str, Any]] = []


@router.post("/cushion-strangle/predict")
async def predict_strategy(body: PredictStrategyBody):
    """
    Rule-based AI prediction: technical indicators + news sentiment + market bias.
    Returns P&L predictions at Day 1, 2, 3, 10, 20, 30 using Black-Scholes mid-cycle pricing.
    """
    raw   = body.symbol.upper()
    yfsym = _yf_sym(raw)
    iv    = body.iv
    cmp_v = body.cmp
    r     = body.rf

    # 1. Technical analysis (from 3-month price history)
    tech_bias = 0.0; tech_signals = ["No data"]; rsi_val = 50.0; sma20_val = cmp_v; trend_5d = 0.0
    try:
        hist = yf.Ticker(yfsym).history(period="3mo")
        if not hist.empty and len(hist) >= 10:
            tech_bias, tech_signals, rsi_val, sma20_val, trend_5d = _technical_bias(hist)
    except Exception:
        tech_signals = ["Technical data unavailable"]

    # 2. News sentiment
    news_bias, news_count, news_summary, headlines = _news_bias(yfsym)

    # 3. Domestic + global market bias
    mkt_bias, nifty_5d, mkt_summary = _market_bias_score()
    glb_bias, global_summary        = _global_bias_score()

    # 4. Combined directional bias (-0.8 … +0.8 cap)
    combined = tech_bias * 0.45 + news_bias * 0.25 + mkt_bias * 0.20 + glb_bias * 0.10
    combined = max(-0.8, min(0.8, combined))

    if   combined >  0.30: outlook = "Bullish · price likely to trend higher"
    elif combined >  0.10: outlook = "Mildly bullish · slight upward bias"
    elif combined < -0.30: outlook = "Bearish · price likely to trend lower"
    elif combined < -0.10: outlook = "Mildly bearish · slight downward pressure"
    else:                   outlook = "Neutral · range-bound movement expected"

    # 5. P&L predictions for each target day
    target_days = [d for d in [1, 2, 3, 10, 20, 30] if d < body.dte]
    predictions = []
    for day in target_days:
        T_d     = day / 365.0
        sigma_d = iv / 100.0 * math.sqrt(T_d)
        drift   = combined * sigma_d * 0.7

        price_pt   = round(cmp_v * math.exp(drift),                2)
        price_low  = round(cmp_v * math.exp(drift - 0.8 * sigma_d), 2)
        price_high = round(cmp_v * math.exp(drift + 0.8 * sigma_d), 2)

        T_rem = max((body.dte - day) / 365.0, 0.0)

        pnl_pt   = _strategy_mid_pnl(price_pt,   T_rem, iv, r, body.options, body.shares)
        pnl_low  = _strategy_mid_pnl(price_low,  T_rem, iv, r, body.options, body.shares)
        pnl_high = _strategy_mid_pnl(price_high, T_rem, iv, r, body.options, body.shares)
        opt_pnl, sh_pnl = _strategy_pnl_breakdown(price_pt, T_rem, iv, r, body.options, body.shares)

        # P&L if position held to expiry (T_rem = 0) at each predicted price
        pnl_exp_pt   = _strategy_mid_pnl(price_pt,   0.0, iv, r, body.options, body.shares)
        pnl_exp_low  = _strategy_mid_pnl(price_low,  0.0, iv, r, body.options, body.shares)
        pnl_exp_high = _strategy_mid_pnl(price_high, 0.0, iv, r, body.options, body.shares)

        # Probability that mid-cycle P&L > 0 given log-normal price distribution
        prob_profit = _prob_profit(cmp_v, drift, sigma_d, T_rem, iv, r, body.options, body.shares)

        conf = "high" if day <= 3 else "medium" if day <= 10 else "low"

        predictions.append({
            "day":              day,
            "price_low":        price_low,
            "price_point":      price_pt,
            "price_high":       price_high,
            "sigma_pct":        round(sigma_d * 100, 1),
            "pnl_low":          pnl_low,
            "pnl_point":        pnl_pt,
            "pnl_high":         pnl_high,
            "pnl_expiry_low":   pnl_exp_low,
            "pnl_expiry_point": pnl_exp_pt,
            "pnl_expiry_high":  pnl_exp_high,
            "opt_pnl":          opt_pnl,
            "sh_pnl":           sh_pnl,
            "prob_profit":      prob_profit,
            "confidence":       conf,
        })

    return JSONResponse({
        "symbol": raw.replace('.NS', '').replace('^', ''),
        "cmp":    cmp_v,
        "analysis": {
            "tech_bias":      tech_bias,
            "news_bias":      news_bias,
            "market_bias":    mkt_bias,
            "global_bias":    glb_bias,
            "combined_bias":  round(combined, 2),
            "outlook":        outlook,
            "rsi":            rsi_val,
            "sma20":          sma20_val,
            "trend_5d":       trend_5d,
            "tech_signals":   tech_signals,
            "news_count":     news_count,
            "news_summary":   news_summary,
            "top_headlines":  headlines,
            "market_summary": mkt_summary,
            "global_summary": global_summary,
            "nifty_5d_pct":   nifty_5d,
        },
        "predictions": predictions,
    })


@router.post("/cushion-strangle/analyze")
async def analyze(p: CushionParams):
    raw = p.symbol.upper()

    # Determine mode
    is_future = (p.instrument_type == 'future') or (p.instrument_type == 'auto' and _is_index(raw))

    yfsym = _yf_sym(raw)
    lot   = _lot(raw)
    T     = p.dte / 365.0
    r     = p.rf

    try:
        t  = yf.Ticker(yfsym)
        fi = t.fast_info
        cmp = float(getattr(fi, "last_price", None) or getattr(fi, "open", None) or 0)
        if cmp <= 0:
            return JSONResponse({"error": "Could not fetch live price"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    # IV
    iv = p.iv_override
    if not iv:
        try:
            hist = t.history(period="2mo")
            if not hist.empty and len(hist) >= 10:
                rv = float(hist["Close"].pct_change().dropna().std() * math.sqrt(252) * 100)
                iv = round(rv * 1.15, 1)
            else:
                iv = 22.0
        except Exception:
            iv = 22.0

    sigma = iv / 100.0 * math.sqrt(T)

    # Strikes at target delta
    ce_K = _round_strike(find_strike_for_delta(cmp, iv, T, p.target_delta, is_call=True,  r=r), cmp)
    pe_K = _round_strike(find_strike_for_delta(cmp, iv, T, p.target_delta, is_call=False, r=r), cmp)

    # Premiums & greeks
    ce_px = round(call_price(cmp, ce_K, iv, T, r), 2)
    pe_px = round(put_price (cmp, pe_K, iv, T, r), 2)
    ce_d  = round(call_delta   (cmp, ce_K, iv, T, r), 3)
    pe_d  = round(put_delta_abs(cmp, pe_K, iv, T, r), 3)

    # 1-sigma bands
    sd1_up   = round(cmp * math.exp( sigma), 2)
    sd1_down = round(cmp * math.exp(-sigma), 2)

    # CE exit level: delta ~0.5 ≈ 98% of CE strike
    ce_exit_price = round(ce_K * 0.98, 2)

    n_lots = 2 if is_future else 1   # options lots per leg

    ce_inc    = round(ce_px * lot * n_lots, 2)
    pe_inc    = round(pe_px * lot * n_lots, 2)
    total_inc = round(ce_inc + pe_inc, 2)

    ce_th     = round(theta_per_day(cmp, ce_K, iv, T, r, is_call=True)  * lot * n_lots, 2)
    pe_th     = round(theta_per_day(cmp, pe_K, iv, T, r, is_call=False) * lot * n_lots, 2)
    daily_theta = round(-(ce_th + pe_th), 2)

    # ── Mode-specific: capital + payoff ───────────────────────────────────────
    lo, hi = cmp * 0.68, cmp * 1.38
    n_pts  = 200
    step   = (hi - lo) / n_pts
    chart  = []

    if is_future:
        futures_margin  = round(cmp * lot * 0.105)
        options_margin  = round(cmp * lot * 0.08 * n_lots * 2)
        share_cap  = futures_margin
        add_cap    = 0
        total_cap  = int(futures_margin + options_margin)
        init_shares = lot
        add_shares  = 0

        for i in range(n_pts + 1):
            px = lo + i * step
            fut_pnl = (px - cmp) * lot
            ce_pnl  = ce_inc - max(0.0, px - ce_K) * lot * n_lots
            pe_pnl  = pe_inc - max(0.0, pe_K - px) * lot * n_lots
            opt     = round(ce_pnl + pe_pnl, 2)
            total   = round(fut_pnl + ce_pnl + pe_pnl, 2)
            chart.append({"price": round(px, 2), "stage1": total, "stage2": None, "opt": opt})

        be_down = _find_be(chart, 'down', cmp)
        be_up   = _find_be(chart, 'up',   cmp)

    else:
        init_shares = max(1, int(lot * p.equity_pct))
        add_shares  = max(1, int(lot * p.add_equity_pct))
        share_cap   = round(init_shares * cmp, 2)
        add_cap     = round(add_shares  * sd1_down, 2)
        margin      = round(cmp * lot * 0.12 * 2, 0)
        total_cap   = int(share_cap + margin)

        for i in range(n_pts + 1):
            px  = lo + i * step
            opt = (ce_inc - max(0.0, px - ce_K) * lot) + (pe_inc - max(0.0, pe_K - px) * lot)
            s1  = round((px - cmp) * init_shares + opt, 2)
            s2  = round((px - cmp) * init_shares + (px - sd1_down) * add_shares + opt, 2)
            chart.append({"price": round(px, 2), "stage1": s1, "stage2": s2, "opt": round(opt, 2)})

        be_down = round(pe_K - total_inc / lot, 2)
        be_up   = round(ce_K + total_inc / lot, 2)

    max_profit = round(total_inc, 0)

    clean_sym = _SYMBOL_NORM.get(raw, (raw.replace('.NS','').replace('.BO','').replace('^',''), ''))[0]

    # ── Scenario Analysis ─────────────────────────────────────────────────────
    s_f = iv / 100.0
    if T > 0 and s_f > 0 and cmp > 0:
        d2_pe = (math.log(cmp / pe_K) + (r - 0.5 * s_f * s_f) * T) / (s_f * math.sqrt(T))
        d2_ce = (math.log(cmp / ce_K) + (r - 0.5 * s_f * s_f) * T) / (s_f * math.sqrt(T))
        p_below = round(_ncdf(-d2_pe) * 100, 1)
        p_above = round(_ncdf(d2_ce)  * 100, 1)
        p_range = round(max(0.0, 100.0 - p_below - p_above), 1)
    else:
        p_below, p_above, p_range = 20.0, 20.0, 60.0

    def _pnl_expiry(px, add_at=None):
        """P&L at expiry at price px."""
        opt = (ce_inc - max(0.0, px - ce_K) * lot * n_lots) + \
              (pe_inc - max(0.0, pe_K - px) * lot * n_lots)
        if is_future:
            eq = (px - cmp) * lot
        elif add_at is not None:
            eq = (px - cmp) * init_shares + (px - add_at) * add_shares
        else:
            eq = (px - cmp) * init_shares
        return round(eq + opt, 2)

    # Reference prices for each scenario
    ref_neutral = round(cmp, 0)
    ref_bearish = round(pe_K * 0.93, 0)   # ~7% below PE
    ref_bullish = round(ce_K * 1.07, 0)   # ~7% above CE

    pnl_neutral  = _pnl_expiry(ref_neutral)
    pnl_bearish  = _pnl_expiry(ref_bearish)
    pnl_bullish  = _pnl_expiry(ref_bullish)
    pnl_at_pe_k  = _pnl_expiry(pe_K)
    pnl_at_ce_k  = _pnl_expiry(ce_K)

    # Add-shares management scenario (stock mode only)
    if not is_future and add_shares > 0:
        avg_cost_s2   = round((cmp * init_shares + sd1_down * add_shares) / (init_shares + add_shares), 2)
        pnl_s2_at_pe  = _pnl_expiry(pe_K,        add_at=sd1_down)
        pnl_s2_at_cmp = _pnl_expiry(cmp,          add_at=sd1_down)
        pnl_s2_deep   = _pnl_expiry(ref_bearish,  add_at=sd1_down)
    else:
        avg_cost_s2 = pnl_s2_at_pe = pnl_s2_at_cmp = pnl_s2_deep = None

    # CE exit mid-cycle (35% DTE remaining, stock at ce_exit_price)
    T_rem = max(T * 0.35, 4.0 / 365.0)
    ce_buyback  = round(call_price(ce_exit_price, ce_K, iv, T_rem, r) * lot * n_lots, 2)
    pe_close    = round(put_price (ce_exit_price, pe_K, iv, T_rem, r) * lot * n_lots, 2)
    eq_at_exit  = round((ce_exit_price - cmp) * (lot if is_future else init_shares), 2)
    net_ce_exit = round(ce_inc - ce_buyback + (pe_inc - pe_close) + eq_at_exit, 2)

    return JSONResponse({
        "symbol":          clean_sym,
        "cmp":             round(cmp, 2),
        "lot_size":        lot,
        "iv":              round(iv, 1),
        "dte":             p.dte,
        "sigma_pct":       round(sigma * 100, 2),
        "instrument_type": "future" if is_future else "stock",
        "ce_lots":         n_lots,
        "pe_lots":         n_lots,

        "ce_strike":       ce_K,
        "pe_strike":       pe_K,
        "ce_premium":      ce_px,
        "pe_premium":      pe_px,
        "ce_delta":        ce_d,
        "pe_delta":        pe_d,
        "ce_income":       ce_inc,
        "pe_income":       pe_inc,
        "total_income":    total_inc,
        "daily_theta":     daily_theta,

        "sd1_up":          sd1_up,
        "sd1_down":        sd1_down,
        "init_shares":     init_shares,
        "add_shares":      add_shares,
        "share_capital":   share_cap,
        "add_capital":     add_cap,
        "total_capital":   total_cap,

        "be_down":         be_down,
        "be_up":           be_up,
        "max_profit":      max_profit,
        "ce_exit_price":   ce_exit_price,

        # Scenario probabilities
        "p_in_range":      p_range,
        "p_below_pe":      p_below,
        "p_above_ce":      p_above,

        # P&L at reference prices (at expiry, no adjustment)
        "ref_neutral":     ref_neutral,
        "ref_bearish":     ref_bearish,
        "ref_bullish":     ref_bullish,
        "pnl_neutral":     pnl_neutral,
        "pnl_bearish":     pnl_bearish,
        "pnl_bullish":     pnl_bullish,
        "pnl_at_pe_k":     pnl_at_pe_k,
        "pnl_at_ce_k":     pnl_at_ce_k,

        # Add-shares management (stock mode only, null for futures)
        "avg_cost_s2":     avg_cost_s2,
        "pnl_s2_at_pe":    pnl_s2_at_pe,
        "pnl_s2_at_cmp":   pnl_s2_at_cmp,
        "pnl_s2_deep":     pnl_s2_deep,

        # CE exit mid-cycle
        "ce_buyback":      ce_buyback,
        "pe_close_val":    pe_close,
        "eq_at_exit":      eq_at_exit,
        "net_ce_exit":     net_ce_exit,

        "chart_data":      chart,
    })
