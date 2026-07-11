"""News fetcher using yfinance news data."""

from datetime import datetime, timezone
from data.market_data import get_news, get_index_history


def fetch_stock_news(symbol: str) -> list[dict]:
    """Fetch and normalize stock news from yfinance."""
    raw = get_news(symbol)
    result = []
    cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400  # 30 days

    for item in raw:
        try:
            content = item.get("content", item)
            title = content.get("title", "") or item.get("title", "")
            summary = content.get("summary", "") or item.get("summary", "")
            pub_date = content.get("pubDate", "") or item.get("providerPublishTime", "")

            # Parse timestamp
            ts = None
            if isinstance(pub_date, (int, float)):
                ts = float(pub_date)
            elif isinstance(pub_date, str) and pub_date:
                try:
                    dt = datetime.fromisoformat(pub_date.replace("Z", "+00:00"))
                    ts = dt.timestamp()
                except ValueError:
                    pass

            if ts and ts < cutoff:
                continue

            result.append({
                "title": title,
                "summary": summary,
                "published_at": ts,
                "source": content.get("provider", {}).get("displayName", "Unknown")
                if isinstance(content.get("provider"), dict)
                else "Unknown",
                "url": content.get("canonicalUrl", {}).get("url", "")
                if isinstance(content.get("canonicalUrl"), dict)
                else "",
            })
        except Exception:
            continue

    return result[:20]  # cap at 20 items


def fetch_market_news() -> list[dict]:
    """Fetch broad market news via Nifty ticker."""
    return fetch_stock_news("^NSEI")


def extract_news_text(news_items: list[dict], max_chars: int = 2000) -> str:
    """Concatenate news titles and summaries for AI analysis."""
    parts = []
    total = 0
    for item in news_items:
        text = f"{item.get('title', '')}. {item.get('summary', '')}".strip()
        if total + len(text) > max_chars:
            break
        parts.append(text)
        total += len(text)
    return " | ".join(parts)
