"""NSE index constituents mapped to Yahoo Finance .NS symbols."""

NIFTY50 = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
    "BHARTIARTL.NS", "KOTAKBANK.NS", "SBIN.NS", "ITC.NS", "LT.NS",
    "BAJFINANCE.NS", "AXISBANK.NS", "MARUTI.NS", "SUNPHARMA.NS", "TITAN.NS",
    "HCLTECH.NS", "WIPRO.NS", "ULTRACEMCO.NS", "POWERGRID.NS", "NTPC.NS",
    "BAJAJFINSV.NS", "ONGC.NS", "TECHM.NS", "DIVISLAB.NS", "ADANIPORTS.NS",
    "CIPLA.NS", "DRREDDY.NS", "HEROMOTOCO.NS", "TATAMOTORS.NS", "TATASTEEL.NS",
    "COALINDIA.NS", "JSWSTEEL.NS", "BRITANNIA.NS", "HINDALCO.NS", "BPCL.NS",
    "EICHERMOT.NS", "GRASIM.NS", "APOLLOHOSP.NS", "ADANIENT.NS", "INDUSINDBK.NS",
    "M&M.NS", "BAJAJ-AUTO.NS", "TATACONSUM.NS", "SBILIFE.NS", "HDFCLIFE.NS",
    "NESTLEIND.NS", "ASIANPAINT.NS", "HINDUNILVR.NS", "ETERNAL.NS", "BEL.NS",
]

NIFTY_BANK = [
    "HDFCBANK.NS", "ICICIBANK.NS", "KOTAKBANK.NS", "SBIN.NS", "AXISBANK.NS",
    "INDUSINDBK.NS", "BANDHANBNK.NS", "FEDERALBNK.NS", "IDFCFIRSTB.NS",
    "AUBANK.NS", "PNB.NS", "BANKBARODA.NS",
]

NIFTY_IT = [
    "TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS",
    "MPHASIS.NS", "COFORGE.NS", "PERSISTENT.NS", "OFSS.NS",
]

NIFTY_PHARMA = [
    "SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS", "BIOCON.NS",
    "AUROPHARMA.NS", "LUPIN.NS", "TORNTPHARM.NS", "ALKEM.NS", "IPCALAB.NS",
]

NIFTY_AUTO = [
    "MARUTI.NS", "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "HEROMOTOCO.NS", "EICHERMOT.NS",
    "M&M.NS", "TVSMOTOR.NS", "BHARATFORG.NS", "MOTHERSON.NS", "BALKRISIND.NS",
]

NIFTY_FMCG = [
    "HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "TATACONSUM.NS",
    "DABUR.NS", "GODREJCP.NS", "MARICO.NS", "COLPAL.NS", "EMAMILTD.NS",
]

NIFTY_METAL = [
    "TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "COALINDIA.NS", "VEDL.NS",
    "NMDC.NS", "SAIL.NS", "WELCORP.NS", "APLAPOLLO.NS", "NATIONALUM.NS",
]

NIFTY_ENERGY = [
    "RELIANCE.NS", "ONGC.NS", "BPCL.NS", "POWERGRID.NS", "NTPC.NS",
    "ADANIGREEN.NS", "TATAPOWER.NS", "ADANIPOWER.NS", "CESC.NS", "TORNTPOWER.NS",
]

NIFTY_MIDCAP_SELECTION = [
    "PERSISTENT.NS", "COFORGE.NS", "MPHASIS.NS", "PIDILITIND.NS",
    "HAVELLS.NS", "VOLTAS.NS", "AMBUJACEM.NS", "ACC.NS", "SHREECEM.NS",
    "INDIGO.NS", "SPICEJET.NS", "BANDHANBNK.NS", "AUBANK.NS", "IDFCFIRSTB.NS",
    "POLICYBZR.NS", "NYKAA.NS", "DELHIVERY.NS", "ETERNAL.NS", "PAYTM.NS",
    "IRCTC.NS", "HAL.NS", "BEL.NS", "BHEL.NS", "COCHINSHIP.NS",
    "VEDL.NS", "NMDC.NS", "SAIL.NS", "ASHOKLEY.NS", "ESCORTS.NS",
    "UPL.NS", "DMART.NS", "TRENT.NS", "BHARTIARTL.NS",
]

NIFTY_FIN_SERVICES = [
    "HDFCBANK.NS", "ICICIBANK.NS", "KOTAKBANK.NS", "AXISBANK.NS", "SBIN.NS",
    "BAJFINANCE.NS", "BAJAJFINSV.NS", "SBILIFE.NS", "HDFCLIFE.NS", "ICICIGI.NS",
    "ICICIPRULI.NS", "HDFCAMC.NS", "CHOLAFIN.NS", "MUTHOOTFIN.NS", "SHRIRAMFIN.NS",
    "MANAPPURAM.NS", "LICHSGFIN.NS", "RECLTD.NS", "PFC.NS", "IRFC.NS",
    "SBICARD.NS", "ANGELONE.NS", "CDSL.NS", "MCX.NS",
]

NIFTY_SMALLCAP = [
    "IREDA.NS", "HUDCO.NS", "SJVN.NS", "NHPC.NS", "RAILTEL.NS",
    "RVNL.NS", "IRCON.NS", "NBCC.NS", "RITES.NS", "MMTC.NS",
    "TATAELXSI.NS", "TANLA.NS", "ROUTE.NS", "KPITTECH.NS", "LTTS.NS",
    "HAPPSTMNDS.NS", "MASTEK.NS", "CYIENT.NS", "ZENSAR.NS", "NIITLTD.NS",
    "LALPATHLAB.NS", "METROPOLIS.NS", "THYROCARE.NS", "VIJAYABANK.NS",
    "CANBK.NS", "UNIONBANK.NS", "BANKBARODA.NS", "PNB.NS", "IOB.NS",
    "CENTRALBK.NS", "MAHABANK.NS", "ANDHRABANK.NS",
]

# Sector index tickers (Yahoo Finance)
SECTOR_INDEX_MAP = {
    "IT":                  "^CNXIT",
    "Banking":             "^NSEBANK",
    "Pharma":              "^CNXPHARMA",
    "Auto":                "^CNXAUTO",
    "FMCG":                "^CNXFMCG",
    "Metal":               "^CNXMETAL",
    "Energy":              "^CNXENERGY",
    "Realty":              "^CNXREALTY",
    "Financial Services":  "^CNXFIN",
    "Media":               "^CNXMEDIA",
    "Infrastructure":      "^CNXINFRA",
    "Consumer":            "HINDUNILVR.NS",   # proxy: largest FMCG/consumer stock
    "Defence":             "HAL.NS",          # proxy: largest defence PSU
    "Healthcare":          "APOLLOHOSP.NS",   # proxy: largest private hospital
    "Cement":              "ULTRACEMCO.NS",   # proxy: largest cement company
}

# Map stock symbol → sector
STOCK_SECTOR_MAP = {
    # IT
    "TCS.NS": "IT", "INFY.NS": "IT", "WIPRO.NS": "IT", "HCLTECH.NS": "IT",
    "TECHM.NS": "IT", "MPHASIS.NS": "IT", "COFORGE.NS": "IT",
    "PERSISTENT.NS": "IT", "OFSS.NS": "IT",
    # Banking
    "HDFCBANK.NS": "Banking", "ICICIBANK.NS": "Banking", "KOTAKBANK.NS": "Banking",
    "SBIN.NS": "Banking", "AXISBANK.NS": "Banking", "INDUSINDBK.NS": "Banking",
    "BANDHANBNK.NS": "Banking", "FEDERALBNK.NS": "Banking", "PNB.NS": "Banking",
    "BANKBARODA.NS": "Banking", "IDFCFIRSTB.NS": "Banking", "AUBANK.NS": "Banking",
    "UNIONBANK.NS": "Banking", "CANBK.NS": "Banking",
    # Financial Services
    "BAJFINANCE.NS": "Financial Services", "BAJAJFINSV.NS": "Financial Services",
    "SBILIFE.NS": "Financial Services", "HDFCLIFE.NS": "Financial Services",
    "POLICYBZR.NS": "Financial Services",
    # Pharma
    "SUNPHARMA.NS": "Pharma", "DRREDDY.NS": "Pharma", "CIPLA.NS": "Pharma",
    "DIVISLAB.NS": "Pharma", "BIOCON.NS": "Pharma", "AUROPHARMA.NS": "Pharma",
    "LUPIN.NS": "Pharma", "TORNTPHARM.NS": "Pharma",
    # Auto
    "MARUTI.NS": "Auto", "TATAMOTORS.NS": "Auto", "BAJAJ-AUTO.NS": "Auto",
    "HEROMOTOCO.NS": "Auto", "EICHERMOT.NS": "Auto", "M&M.NS": "Auto",
    "TVSMOTOR.NS": "Auto", "BHARATFORG.NS": "Auto", "ASHOKLEY.NS": "Auto",
    # FMCG
    "HINDUNILVR.NS": "FMCG", "ITC.NS": "FMCG", "NESTLEIND.NS": "FMCG",
    "BRITANNIA.NS": "FMCG", "TATACONSUM.NS": "FMCG", "DABUR.NS": "FMCG",
    "GODREJCP.NS": "FMCG", "MARICO.NS": "FMCG", "COLPAL.NS": "FMCG",
    # Metal
    "TATASTEEL.NS": "Metal", "JSWSTEEL.NS": "Metal", "HINDALCO.NS": "Metal",
    "COALINDIA.NS": "Metal", "VEDL.NS": "Metal", "NMDC.NS": "Metal", "SAIL.NS": "Metal",
    # Energy
    "RELIANCE.NS": "Energy", "ONGC.NS": "Energy", "BPCL.NS": "Energy",
    "POWERGRID.NS": "Energy", "NTPC.NS": "Energy", "ADANIGREEN.NS": "Energy",
    "TATAPOWER.NS": "Energy", "ADANIPOWER.NS": "Energy",
    # Conglomerate / Infra
    "LT.NS": "Infrastructure", "ADANIPORTS.NS": "Infrastructure",
    "ADANIENT.NS": "Infrastructure", "BHEL.NS": "Infrastructure",
    "HAL.NS": "Defence", "BEL.NS": "Defence", "COCHINSHIP.NS": "Defence",
    # Consumer / Lifestyle / Retail
    "ASIANPAINT.NS": "Consumer", "TITAN.NS": "Consumer",
    "HAVELLS.NS": "Consumer", "VOLTAS.NS": "Consumer", "PIDILITIND.NS": "Consumer",
    "DMART.NS": "Consumer", "TRENT.NS": "Consumer", "ETERNAL.NS": "Consumer",
    # Cement
    "ULTRACEMCO.NS": "Cement", "AMBUJACEM.NS": "Cement", "ACC.NS": "Cement",
    "SHREECEM.NS": "Cement", "GRASIM.NS": "Cement",
    # Healthcare
    "APOLLOHOSP.NS": "Healthcare",
    # Telecom
    "BHARTIARTL.NS": "Telecom",
    # Agro / Chemicals
    "UPL.NS": "Agro Chemicals",
}

INDEX_GROUPS = {
    "nifty50":        NIFTY50,
    "nifty_bank":     NIFTY_BANK,
    "nifty_it":       NIFTY_IT,
    "nifty_pharma":   NIFTY_PHARMA,
    "nifty_auto":     NIFTY_AUTO,
    "nifty_fmcg":     NIFTY_FMCG,
    "nifty_metal":    NIFTY_METAL,
    "nifty_energy":   NIFTY_ENERGY,
    "nifty_midcap":   NIFTY_MIDCAP_SELECTION,
    "nifty_fin":      NIFTY_FIN_SERVICES,
    "nifty_smallcap": NIFTY_SMALLCAP,
}


def normalize_symbol(symbol: str) -> str:
    """Ensure symbol has .NS suffix for NSE stocks."""
    s = symbol.strip().upper()
    if s.startswith("^") or "." in s:
        return s
    return s + ".NS"


def get_sector(symbol: str) -> str:
    """Return sector name for a symbol, defaulting to 'Diversified'."""
    s = normalize_symbol(symbol)
    return STOCK_SECTOR_MAP.get(s, "Diversified")
