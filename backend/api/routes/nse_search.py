"""NSE stock search endpoint — typeahead for Indian stocks."""

import json
import os
import threading
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

# ─── Static catalog: Nifty50 + BankNifty + IT + known sector stocks ──────────
# symbol (without .NS) → (company_name, sector)
_CATALOG: dict[str, dict] = {}
_catalog_lock = threading.Lock()
_CATALOG_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "nse_catalog.json")

_SEED_SYMBOLS = [
    # Nifty 50 core
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","KOTAKBANK","LT","AXISBANK",
    "SBIN","HINDUNILVR","BAJFINANCE","BHARTIARTL","ASIANPAINT","MARUTI","NTPC",
    "POWERGRID","TITAN","SUNPHARMA","ULTRACEMCO","TECHM","WIPRO","HCLTECH",
    "ONGC","COALINDIA","BAJAJFINSV","DIVISLAB","DRREDDY","CIPLA","APOLLOHOSP",
    "ADANIPORTS","ADANIENT","JSWSTEEL","TATASTEEL","HINDALCO","GRASIM",
    "BPCL","IOC","HEROMOTOCO","BAJAJ-AUTO","EICHERMOT","M&M","TATACONSUM",
    "BRITANNIA","NESTLEIND","ITC","LTIM","INDUSINDBK","SBILIFE","HDFCLIFE",
    # Bank Nifty extras
    "FEDERALBNK","IDFCFIRSTB","PNB","BANKBARODA","CANBK","UNIONBANK",
    # IT extras
    "PERSISTENT","MPHASIS","LTTS","COFORGE","KPITTECH","TATAELXSI",
    # Midcap popular
    "BEL","HAL","BHEL","IRCTC","IRFC","RECLTD","PFC","HUDCO",
    "VEDL","HINDZINC","NMDC","SAIL","MOIL",
    "ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY",
    "JUBLFOOD","DEVYANI","WESTLIFE","SAPPHIRE",
    "VOLTAS","HAVELLS","POLYCAB","KEI","FINOLEX",
    "PIDILITIND","ASTRAL","SUPREME","VBL","MCDOWELL-N",
    "ABBOTINDIA","AUROPHARMA","BIOCON","ALKEM","TORNTPHARM","IPCALAB",
    "MUTHOOTFIN","CHOLAFIN","MANAPPURAM","SHRIRAMFIN","LICHSGFIN",
    "CONCOR","MAERSK","BLUEDART","GLENMARK",
    "TATAMOTORS","ASHOKLEY","ESCORTS","TIINDIA","MOTHERSON",
    "AARTIIND","SRF","ATUL","DEEPAKNITR","GNFC","COROMANDEL",
    "OBEROIRLTY","GODREJPROP","DLF","PRESTIGE","PHOENIXLTD",
    "PAGEIND","RAJESHEXPO","TRENT","SHOPERSTOP",
    "IDEA","MTNL","BSNL",
    "ADANIGREEN","ADANITRANS","ADANIGAS","ADANIPOWER","AWL",
    "ZYDUSLIFE","LUPIN","NATCOPHARM","SANOFI","GLAXO",
    "COLPAL","DABUR","MARICO","EMAMILTD","GODREJCP",
    "PIIND","DMART","ABFRL","MANYAVAR",
    "CAMS","CDSL","BSE","MCX","IIFL","ANGELONE","ICICIPRULI",
    "HDFCAMC","NIPPONLIFE","ICICIGI","NIACL","SBICARD",
    "SUNTV","ZEEL","PVR","INOXLEISUR",
    "LALPATHLAB","METROPOLIS","THYROCARE",
    "IREDA","SJVN","NHPC","CESC","TATAPOWER","TORNTPOWER","JSPL",
    "ATGL","MGL","IGL","GUJGASLTD",
    "TANLA","ONMOBILE","ROUTE",
]

# Fallback names for seeds (avoids one-time yfinance calls on first boot)
_SEED_NAMES = {
    "RELIANCE": ("Reliance Industries Ltd", "Energy"),
    "HDFCBANK": ("HDFC Bank Ltd", "Financial Services"),
    "ICICIBANK": ("ICICI Bank Ltd", "Financial Services"),
    "INFY": ("Infosys Ltd", "Technology"),
    "TCS": ("Tata Consultancy Services", "Technology"),
    "KOTAKBANK": ("Kotak Mahindra Bank", "Financial Services"),
    "LT": ("Larsen & Toubro Ltd", "Industrials"),
    "AXISBANK": ("Axis Bank Ltd", "Financial Services"),
    "SBIN": ("State Bank of India", "Financial Services"),
    "HINDUNILVR": ("Hindustan Unilever Ltd", "Consumer Staples"),
    "BAJFINANCE": ("Bajaj Finance Ltd", "Financial Services"),
    "BHARTIARTL": ("Bharti Airtel Ltd", "Communication"),
    "ASIANPAINT": ("Asian Paints Ltd", "Materials"),
    "MARUTI": ("Maruti Suzuki India Ltd", "Consumer Discretionary"),
    "NTPC": ("NTPC Ltd", "Utilities"),
    "POWERGRID": ("Power Grid Corp of India", "Utilities"),
    "TITAN": ("Titan Company Ltd", "Consumer Discretionary"),
    "SUNPHARMA": ("Sun Pharmaceutical Industries", "Healthcare"),
    "ULTRACEMCO": ("UltraTech Cement Ltd", "Materials"),
    "TECHM": ("Tech Mahindra Ltd", "Technology"),
    "WIPRO": ("Wipro Ltd", "Technology"),
    "HCLTECH": ("HCL Technologies Ltd", "Technology"),
    "ONGC": ("Oil & Natural Gas Corporation", "Energy"),
    "COALINDIA": ("Coal India Ltd", "Energy"),
    "BAJAJFINSV": ("Bajaj Finserv Ltd", "Financial Services"),
    "DIVISLAB": ("Divi's Laboratories", "Healthcare"),
    "DRREDDY": ("Dr Reddy's Laboratories", "Healthcare"),
    "CIPLA": ("Cipla Ltd", "Healthcare"),
    "APOLLOHOSP": ("Apollo Hospitals Enterprise", "Healthcare"),
    "ADANIPORTS": ("Adani Ports & SEZ Ltd", "Industrials"),
    "ADANIENT": ("Adani Enterprises Ltd", "Industrials"),
    "JSWSTEEL": ("JSW Steel Ltd", "Materials"),
    "TATASTEEL": ("Tata Steel Ltd", "Materials"),
    "HINDALCO": ("Hindalco Industries Ltd", "Materials"),
    "GRASIM": ("Grasim Industries Ltd", "Materials"),
    "BPCL": ("Bharat Petroleum Corp Ltd", "Energy"),
    "IOC": ("Indian Oil Corporation Ltd", "Energy"),
    "HEROMOTOCO": ("Hero MotoCorp Ltd", "Consumer Discretionary"),
    "BAJAJ-AUTO": ("Bajaj Auto Ltd", "Consumer Discretionary"),
    "EICHERMOT": ("Eicher Motors Ltd", "Consumer Discretionary"),
    "M&M": ("Mahindra & Mahindra Ltd", "Consumer Discretionary"),
    "TATACONSUM": ("Tata Consumer Products", "Consumer Staples"),
    "BRITANNIA": ("Britannia Industries Ltd", "Consumer Staples"),
    "NESTLEIND": ("Nestle India Ltd", "Consumer Staples"),
    "ITC": ("ITC Ltd", "Consumer Staples"),
    "LTIM": ("LTIMindtree Ltd", "Technology"),
    "INDUSINDBK": ("IndusInd Bank Ltd", "Financial Services"),
    "SBILIFE": ("SBI Life Insurance", "Financial Services"),
    "HDFCLIFE": ("HDFC Life Insurance", "Financial Services"),
    "BEL": ("Bharat Electronics Ltd", "Industrials"),
    "HAL": ("Hindustan Aeronautics Ltd", "Industrials"),
    "BHEL": ("Bharat Heavy Electricals", "Industrials"),
    "IRCTC": ("Indian Railway Catering & Tourism", "Industrials"),
    "IRFC": ("Indian Railway Finance Corp", "Financial Services"),
    "RECLTD": ("REC Ltd", "Financial Services"),
    "PFC": ("Power Finance Corporation", "Financial Services"),
    "HUDCO": ("Housing & Urban Dev Corp", "Financial Services"),
    "VEDL": ("Vedanta Ltd", "Materials"),
    "TATAMOTORS": ("Tata Motors Ltd", "Consumer Discretionary"),
    "ZOMATO": ("Zomato Ltd", "Consumer Discretionary"),
    "DLF": ("DLF Ltd", "Real Estate"),
    "DMART": ("Avenue Supermarts (DMart)", "Consumer Staples"),
    "IREDA": ("Indian Renewable Energy Dev Agency", "Financial Services"),
    "TATAPOWER": ("Tata Power Company", "Utilities"),
    "IGL": ("Indraprastha Gas Ltd", "Utilities"),
    "MGL": ("Mahanagar Gas Ltd", "Utilities"),
    "ATGL": ("Adani Total Gas Ltd", "Utilities"),
    "PERSISTENTSYSTEMS": ("Persistent Systems Ltd", "Technology"),
    "PERSISTENT": ("Persistent Systems Ltd", "Technology"),
    "MPHASIS": ("Mphasis Ltd", "Technology"),
    "LTTS": ("L&T Technology Services", "Technology"),
    "COFORGE": ("Coforge Ltd", "Technology"),
    "FEDERALBNK": ("Federal Bank Ltd", "Financial Services"),
    "IDFCFIRSTB": ("IDFC First Bank", "Financial Services"),
    "PNB": ("Punjab National Bank", "Financial Services"),
    "BANKBARODA": ("Bank of Baroda", "Financial Services"),
    "NMDC": ("NMDC Ltd", "Materials"),
    "SAIL": ("Steel Authority of India", "Materials"),
    "ANGELONE": ("Angel One Ltd", "Financial Services"),
    "CDSL": ("Central Depository Services", "Financial Services"),
    "MCX": ("Multi Commodity Exchange", "Financial Services"),
    "COLPAL": ("Colgate-Palmolive India", "Consumer Staples"),
    "DABUR": ("Dabur India Ltd", "Consumer Staples"),
    "MARICO": ("Marico Ltd", "Consumer Staples"),
    "GODREJCP": ("Godrej Consumer Products", "Consumer Staples"),
    "LUPIN": ("Lupin Ltd", "Healthcare"),
    "AUROPHARMA": ("Aurobindo Pharma Ltd", "Healthcare"),
    "BIOCON": ("Biocon Ltd", "Healthcare"),
    "ALKEM": ("Alkem Laboratories", "Healthcare"),
    "TORNTPHARM": ("Torrent Pharmaceuticals", "Healthcare"),
    "TATAELXSI": ("Tata Elxsi Ltd", "Technology"),
    "PIDILITIND": ("Pidilite Industries Ltd", "Materials"),
    "HAVELLS": ("Havells India Ltd", "Industrials"),
    "POLYCAB": ("Polycab India Ltd", "Industrials"),
    "VOLTAS": ("Voltas Ltd", "Industrials"),
    "CONCOR": ("Container Corp of India", "Industrials"),
    "ASHOKLEY": ("Ashok Leyland Ltd", "Consumer Discretionary"),
    "ESCORTS": ("Escorts Kubota Ltd", "Consumer Discretionary"),
    "MOTHERSON": ("Samvardhana Motherson", "Consumer Discretionary"),
    "OBEROIRLTY": ("Oberoi Realty Ltd", "Real Estate"),
    "GODREJPROP": ("Godrej Properties Ltd", "Real Estate"),
    "PRESTIGE": ("Prestige Estates Projects", "Real Estate"),
    "PHOENIXLTD": ("Phoenix Mills Ltd", "Real Estate"),
    "SUNTV": ("Sun TV Network Ltd", "Communication"),
    "PVR": ("PVR INOX Ltd", "Consumer Discretionary"),
    "LALPATHLAB": ("Dr Lal PathLabs Ltd", "Healthcare"),
    "METROPOLIS": ("Metropolis Healthcare Ltd", "Healthcare"),
    "NHPC": ("NHPC Ltd", "Utilities"),
    "SJVN": ("SJVN Ltd", "Utilities"),
    "CESC": ("CESC Ltd", "Utilities"),
    "JSPL": ("Jindal Steel & Power", "Materials"),
    "HINDZINC": ("Hindustan Zinc Ltd", "Materials"),
    "MOIL": ("MOIL Ltd", "Materials"),
    "ICICIGI": ("ICICI Lombard General Insurance", "Financial Services"),
    "ICICIPRULI": ("ICICI Prudential Life Insurance", "Financial Services"),
    "HDFCAMC": ("HDFC Asset Management", "Financial Services"),
    "SBICARD": ("SBI Cards & Payment Services", "Financial Services"),
    "MUTHOOTFIN": ("Muthoot Finance Ltd", "Financial Services"),
    "CHOLAFIN": ("Cholamandalam Investment", "Financial Services"),
    "SHRIRAMFIN": ("Shriram Finance Ltd", "Financial Services"),
    "MANAPPURAM": ("Manappuram Finance Ltd", "Financial Services"),
    "LICHSGFIN": ("LIC Housing Finance Ltd", "Financial Services"),
}


def _build_catalog() -> dict[str, dict]:
    """Build catalog from seed names. Enriches with yfinance in background if needed."""
    catalog: dict[str, dict] = {}
    # Load cached file first
    if os.path.exists(_CATALOG_FILE):
        try:
            with open(_CATALOG_FILE) as f:
                catalog = json.load(f)
        except Exception:
            pass

    # Fill any missing seeds from static names
    for sym in _SEED_SYMBOLS:
        if sym not in catalog:
            name, sector = _SEED_NAMES.get(sym, (sym, ""))
            catalog[sym] = {"symbol": sym, "name": name, "sector": sector}

    return catalog


def _save_catalog(catalog: dict) -> None:
    try:
        with open(_CATALOG_FILE, "w") as f:
            json.dump(catalog, f, indent=2)
    except Exception:
        pass


def _get_catalog() -> dict[str, dict]:
    with _catalog_lock:
        if not _CATALOG:
            built = _build_catalog()
            _CATALOG.update(built)
    return _CATALOG


@router.get("/nse/search")
async def search_nse_stocks(q: str):
    """Typeahead search for NSE-listed stocks. Returns up to 8 matches."""
    query = q.strip().upper()
    if len(query) < 2:
        return JSONResponse(content={"results": []})

    catalog = _get_catalog()
    results = []

    # Exact symbol prefix first
    for sym, info in catalog.items():
        if sym.startswith(query):
            results.append({**info, "match": "symbol"})

    # Then name substring (case-insensitive)
    query_lower = query.lower()
    for sym, info in catalog.items():
        if sym not in {r["symbol"] for r in results}:
            if query_lower in info.get("name", "").lower():
                results.append({**info, "match": "name"})

    # If fewer than 4 results, supplement with yfinance search
    if len(results) < 4:
        import yfinance as yf
        try:
            s = yf.Search(q.strip(), max_results=15)
            for r in s.quotes:
                sym_raw = r.get("symbol", "")
                ex = r.get("exchange", "")
                if r.get("quoteType") != "EQUITY":
                    continue
                if not (sym_raw.endswith(".NS") or ex == "NSI"):
                    continue
                base = sym_raw.replace(".NS", "")
                if base not in {r["symbol"] for r in results}:
                    entry = {
                        "symbol": base,
                        "name": r.get("shortname") or r.get("longname", base),
                        "sector": r.get("sectorDisp", ""),
                        "match": "search",
                    }
                    results.append(entry)
                    # Cache it
                    with _catalog_lock:
                        _CATALOG[base] = {"symbol": base, "name": entry["name"], "sector": entry["sector"]}
        except Exception:
            pass

    return JSONResponse(content={"results": results[:8]})
