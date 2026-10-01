"""Broker abstraction layer — Angel One SmartAPI + Kotak Neo."""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


class BrokerClient(ABC):
    """Unified interface for all broker integrations."""

    @abstractmethod
    def connect(self, creds: dict) -> dict:
        """Authenticate and return session info dict."""
        ...

    @abstractmethod
    def get_holdings(self) -> list[dict]:
        """Return list of current holdings/positions."""
        ...

    @abstractmethod
    def get_funds(self) -> dict:
        """Return available cash and margin info."""
        ...

    @abstractmethod
    def place_order(self, params: dict) -> dict:
        """Place an order. Returns {order_id, status, message}."""
        ...

    @abstractmethod
    def get_orders(self) -> list[dict]:
        """Return today's order book."""
        ...

    @abstractmethod
    def get_positions(self) -> list[dict]:
        """Return open intraday / F&O positions."""
        ...

    @abstractmethod
    def disconnect(self) -> None:
        """Logout and invalidate session."""
        ...


def get_broker(name: str, session: dict, cache_key: str = "") -> BrokerClient:
    """Factory: return a BrokerClient. cache_key keeps the live object across requests."""
    from brokers.angel_one import AngelOneClient
    from brokers.kotak_neo import KotakNeoClient
    if name == "angelone":
        return AngelOneClient(session, cache_key)
    if name == "kotak":
        return KotakNeoClient(session, cache_key)
    raise ValueError(f"Unknown broker: {name!r}")
