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
    anthropic_val = body.anthropic_api_key
    openai_val    = body.openai_api_key
    groq_val      = body.groq_api_key

    # __CLEAR__ sentinel — explicitly wipe the key
    if anthropic_val == "__CLEAR__":
        os.environ["ANTHROPIC_API_KEY"] = ""
        anthropic_val = ""
    if openai_val == "__CLEAR__":
        os.environ["OPENAI_API_KEY"] = ""
        openai_val = ""
    if groq_val == "__CLEAR__":
        os.environ["GROQ_API_KEY"] = ""
        groq_val = ""

    any_explicit = bool(
        body.anthropic_api_key == "__CLEAR__" or
        body.openai_api_key    == "__CLEAR__" or
        body.groq_api_key      == "__CLEAR__" or
        anthropic_val or openai_val or groq_val
    )

    update_settings(
        provider=body.llm_provider,
        anthropic_key=anthropic_val,
        openai_key=openai_val,
        groq_key=groq_val,
        overwrite_keys=any_explicit,
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
