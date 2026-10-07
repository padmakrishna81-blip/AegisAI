"""Settings endpoints."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from ai.llm_client import update_settings, get_provider, is_configured
from api.routes.auth import get_current_user
import os

router = APIRouter()


class SettingsInput(BaseModel):
    llm_provider: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    groq_api_key: str = ""


@router.get("/settings")
async def get_settings():
    return {
        "llm_provider": get_provider(),
        "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "openai_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "groq_configured": bool(os.getenv("GROQ_API_KEY", "").strip()),
        "llm_ready": is_configured(),
    }


@router.post("/settings")
async def save_settings(body: SettingsInput):
    # For each key: None = don't touch, "" = clear, "value" = set new value
    def _resolve(raw: str) -> str | None:
        if raw == "__CLEAR__":
            return ""        # explicit clear
        return raw or None   # non-empty string or None (don't touch)

    update_settings(
        provider=body.llm_provider or "",
        anthropic_key=_resolve(body.anthropic_api_key),
        openai_key=_resolve(body.openai_api_key),
        groq_key=_resolve(body.groq_api_key),
    )
    if body.llm_provider:
        os.environ["LLM_PROVIDER"] = body.llm_provider

    return {
        "message": "Settings saved",
        "llm_provider": get_provider(),
        "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY", "").strip()),
        "openai_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "groq_configured": bool(os.getenv("GROQ_API_KEY", "").strip()),
        "llm_ready": is_configured(),
    }


@router.post("/settings/test-llm")
async def test_llm_connection(user=Depends(get_current_user)):
    """Send a minimal test prompt to verify the LLM key is working."""
    from ai.llm_client import call_llm
    if not is_configured():
        return {"ok": False, "error": f"No API key configured for provider '{get_provider()}'"}
    result = call_llm("Reply with exactly: OK", max_tokens=10)
    if result.startswith("[LLM"):
        return {"ok": False, "error": result}
    return {"ok": True, "provider": get_provider(), "response": result.strip()}
