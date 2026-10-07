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
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from ai.llm_client import get_provider, is_configured

    if not is_configured():
        return {"ok": False, "error": f"No API key configured for provider '{get_provider()}'"}

    # Call the provider directly to get the raw error (not the friendly string)
    provider = get_provider()
    loop = asyncio.get_running_loop()

    def _raw_test():
        if provider == "groq":
            from ai.llm_client import _call_groq
            return _call_groq("Reply with exactly: OK", "", 10)
        elif provider == "claude":
            from ai.llm_client import _call_claude
            return _call_claude("Reply with exactly: OK", "", 10)
        elif provider == "openai":
            from ai.llm_client import _call_openai
            return _call_openai("Reply with exactly: OK", "", 10)
        return "[Unknown provider]"

    try:
        result = await loop.run_in_executor(ThreadPoolExecutor(max_workers=1), _raw_test)
        return {"ok": True, "provider": provider, "response": result.strip()}
    except Exception as e:
        return {"ok": False, "provider": provider, "error": str(e)}
