"""Kotak Neo broker client — implemented directly over REST (no pip package available)."""

from __future__ import annotations
import hashlib
import logging
import base64
from datetime import datetime, timezone, timedelta

import requests

from brokers import BrokerClient

logger = logging.getLogger(__name__)

_BASE = "https://gw-napi.kotaksecurities.com"
_TRADE_BASE = "https://gw-napi.kotaksecurities.com/trade/api/v2"


def _basic_auth(consumer_key: str, consumer_secret: str) -> str:
    token = base64.b64encode(f"{consumer_key}:{consumer_secret}".encode()).decode()
    return f"Basic {token}"


class KotakNeoClient(BrokerClient):
    """
    Kotak Neo REST API wrapper.

    Auth flow:
    1. POST /oauth2/token with consumer_key/secret → access_token (10-min)
    2. POST /trade/api/v2/login/2fa with mobile+password → sends OTP
       OR POST /trade/api/v2/login/2fa with MPIN (no OTP needed — recommended for automation)
    3. Session valid until end of trading day.

    creds keys:
      consumer_key, consumer_secret, mobile_number, password, mpin
    """

    def __init__(self, session: dict, cache_key: str = ""):
        self._session = session
        self._headers: dict = {}
        if session.get("access_token"):
            self._headers = {
                "Authorization": f"Bearer {session['access_token']}",
                "Sid":           session.get("sid", ""),
                "Auth":          session.get("auth", ""),
                "neo-fin-key":   "neotradeapi",
                "Content-Type":  "application/json",
            }

    def connect(self, creds: dict) -> dict:
        # Step 1 — OAuth2 token
        resp = requests.post(
            f"{_BASE}/oauth2/token",
            data={
                "grant_type":    "client_credentials",
                "consumer_key":  creds["consumer_key"],
                "consumer_secret": creds["consumer_secret"],
            },
            headers={"Authorization": _basic_auth(creds["consumer_key"], creds["consumer_secret"])},
            timeout=15,
        )
        resp.raise_for_status()
        token_data = resp.json()
        access_token = token_data["access_token"]

        # Step 2 — Login with MPIN (for automation; avoids OTP delivery dependency)
        login_resp = requests.post(
            f"{_TRADE_BASE}/login/2fa",
            json={
                "mobileNumber": creds["mobile_number"],
                "password":     creds["password"],
                "mpin":         creds["mpin"],
            },
            headers={
                "Authorization": f"Bearer {access_token}",
                "neo-fin-key":   "neotradeapi",
                "Content-Type":  "application/json",
            },
            timeout=15,
        )
        login_resp.raise_for_status()
        login_data = login_resp.json().get("data", {})

        sid  = login_data.get("sid", "")
        auth = login_data.get("auth", "")
        expiry = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()

        session = {
            "consumer_key":  creds["consumer_key"],
            "consumer_secret": creds["consumer_secret"],
            "access_token":  access_token,
            "sid":           sid,
            "auth":          auth,
            "expires_at":    expiry,
        }
        self._session = session
        self._headers = {
            "Authorization": f"Bearer {access_token}",
            "Sid":           sid,
            "Auth":          auth,
            "neo-fin-key":   "neotradeapi",
            "Content-Type":  "application/json",
        }
        return session

    def _get(self, path: str, params: dict | None = None) -> dict:
        r = requests.get(f"{_TRADE_BASE}{path}", headers=self._headers, params=params, timeout=15)
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict) -> dict:
        r = requests.post(f"{_TRADE_BASE}{path}", headers=self._headers, json=body, timeout=15)
        r.raise_for_status()
        return r.json()

    def get_holdings(self) -> list[dict]:
        data = self._get("/portfolio/holdings")
        raw = data.get("data") or []
        return [
            {
                "broker":      "Kotak Neo",
                "symbol":      h.get("trdSym", ""),
                "token":       h.get("tok", ""),
                "exchange":    h.get("exSeg", ""),
                "qty":         int(float(h.get("qty", 0))),
                "avg_price":   float(h.get("avgPrc", 0)),
                "ltp":         float(h.get("mktPrc", 0)),
                "pnl":         float(h.get("unRealisedPnl", 0)),
                "pnl_pct":     float(h.get("unRealisedPnlPerc", 0)),
                "product":     h.get("prod", ""),
                "isin":        h.get("isin", ""),
            }
            for h in raw
        ]

    def get_funds(self) -> dict:
        data = self._get("/limits")
        d = data.get("data") or {}
        return {
            "broker":         "Kotak Neo",
            "available_cash": float(d.get("cashAvailable", 0)),
            "used_margin":    float(d.get("mgnUsed", 0)),
            "net":            float(d.get("netAvailableMargin", 0)),
            "total_margin":   float(d.get("totalMargin", 0)),
        }

    def place_order(self, params: dict) -> dict:
        """
        params: symbol, token, exchange, side (BUY/SELL), qty, price,
                order_type (MIS/CNC/NRML), product (INTRADAY/DELIVERY)
        """
        body = {
            "am":  "NO",
            "dq":  "0",
            "es":  params.get("exchange", "nse_cm"),
            "mp":  "0",
            "pc":  "CNC" if params.get("product", "DELIVERY") == "DELIVERY" else "MIS",
            "pf":  "N",
            "pr":  str(params.get("price", "0")),
            "pt":  "MKT" if params.get("order_type", "MARKET") == "MARKET" else "L",
            "qt":  str(int(params["qty"])),
            "rt":  "DAY",
            "tp":  "0",
            "ts":  params["symbol"],
            "tt":  "B" if params["side"].upper() == "BUY" else "S",
        }
        resp = self._post("/orders", body)
        order_id = resp.get("data", {}).get("nOrdNo", resp.get("nOrdNo", ""))
        return {
            "order_id": order_id,
            "broker":   "Kotak Neo",
            "status":   "placed",
            "message":  resp.get("message", "Order placed"),
        }

    def get_orders(self) -> list[dict]:
        data = self._get("/orders")
        raw = data.get("data") or []
        return [
            {
                "order_id":   o.get("nOrdNo", ""),
                "broker":     "Kotak Neo",
                "symbol":     o.get("trdSym", ""),
                "exchange":   o.get("exSeg", ""),
                "side":       "BUY" if o.get("trnsTp") == "B" else "SELL",
                "qty":        int(float(o.get("qty", 0))),
                "price":      float(o.get("prc", 0)),
                "order_type": o.get("ordTyp", ""),
                "status":     o.get("ordSt", ""),
                "time":       o.get("hsUpTm", ""),
            }
            for o in raw
        ]

    def get_positions(self) -> list[dict]:
        # Kotak Neo positions endpoint (F&O / intraday)
        try:
            data = self._get("/positions")
            raw = data.get("data") or []
        except Exception:
            return []
        positions = []
        for p in raw:
            net_qty = int(float(p.get("netQty", 0)))
            if net_qty == 0:
                continue
            positions.append({
                "broker":      "Kotak Neo",
                "symbol":      p.get("trdSym", ""),
                "token":       p.get("tok", ""),
                "exchange":    p.get("exSeg", "NFO"),
                "instrument":  p.get("instType", ""),
                "strike":      p.get("stkPrc", ""),
                "option_type": p.get("optType", ""),
                "expiry":      p.get("expDt", ""),
                "lot_size":    int(float(p.get("lotSz", 1))),
                "net_qty":     net_qty,
                "avg_price":   float(p.get("avgPrc", 0)),
                "ltp":         float(p.get("ltp", 0)),
                "unrealised":  float(p.get("unRlzdPnL", 0)),
                "realised":    float(p.get("rlzdPnL", 0)),
                "product":     p.get("prd", ""),
                "side":        "LONG" if net_qty > 0 else "SHORT",
                "close_side":  "SELL" if net_qty > 0 else "BUY",
                "close_qty":   abs(net_qty),
            })
        return positions

    def disconnect(self) -> None:
        try:
            requests.delete(
                f"{_TRADE_BASE}/session",
                headers=self._headers,
                timeout=10,
            )
        except Exception:
            pass
        self._session = {}
        self._headers = {}
