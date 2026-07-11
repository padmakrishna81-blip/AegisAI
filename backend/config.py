"""Application configuration."""

import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))


class Settings:
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "claude")
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    CACHE_TTL_SECONDS: int = 900
    MAX_SCAN_STOCKS: int = 50
    PORTFOLIO_FILE: str = os.path.join(os.path.dirname(__file__), "portfolio_data.json")


settings = Settings()
