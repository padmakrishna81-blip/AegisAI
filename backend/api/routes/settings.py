"""Settings endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel
from ai.llm_client import update_settings, get_provider, is_configured
import os

router = APIRouter()


class SettingsInput(BaseModel):
    llm_provider: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""


@router.get("/settings")
async def get_settings():
    return {
        "llm_provider": get_provider(),
        "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "openai_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "llm_ready": is_configured(),
    }


@router.post("/settings")
async def save_settings(settings: SettingsInput):
    update_settings(
        provider=settings.llm_provider,
        anthropic_key=settings.anthropic_api_key,
        openai_key=settings.openai_api_key,
    )
    return {
        "message": "Settings saved",
        "llm_provider": get_provider(),
        "llm_ready": is_configured(),
    }
