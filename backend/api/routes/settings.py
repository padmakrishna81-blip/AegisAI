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
    # Handle __CLEAR__ sentinel — explicitly wipe the key
    anthropic_val = settings.anthropic_api_key
    openai_val    = settings.openai_api_key

    if anthropic_val == "__CLEAR__":
        os.environ["ANTHROPIC_API_KEY"] = ""
        anthropic_val = ""
    if openai_val == "__CLEAR__":
        os.environ["OPENAI_API_KEY"] = ""
        openai_val = ""

    # Blank = "keep existing" unless we explicitly cleared above
    anthropic = anthropic_val if anthropic_val else None
    openai_k  = openai_val    if openai_val    else None

    update_settings(
        provider=settings.llm_provider,
        anthropic_key=anthropic or "",
        openai_key=openai_k or "",
        overwrite_keys=bool(anthropic is not None or openai_k is not None
                            or settings.anthropic_api_key == "__CLEAR__"
                            or settings.openai_api_key == "__CLEAR__"),
    )
    if settings.llm_provider:
        os.environ["LLM_PROVIDER"] = settings.llm_provider
    return {
        "message": "Settings saved",
        "llm_provider": get_provider(),
        "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "openai_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "llm_ready": is_configured(),
    }
