"""Unified LLM client supporting Claude (Anthropic), OpenAI, and Groq."""

import hashlib
import os
import re
import time
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

_response_cache: dict[str, dict] = {}
LLM_CACHE_TTL = 3600  # 1 hour


def _strip_thinking(text: str) -> str:
    """Remove <think>...</think> blocks produced by reasoning models (Qwen 3, etc.)."""
    return re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()


def _cache_key(prompt: str, provider: str) -> str:
    return hashlib.md5(f"{provider}:{prompt}".encode()).hexdigest()


def _get_cached_response(key: str) -> str | None:
    entry = _response_cache.get(key)
    if entry and (time.time() - entry["ts"]) < LLM_CACHE_TTL:
        return entry["data"]
    return None


def _set_cached_response(key: str, data: str) -> None:
    _response_cache[key] = {"data": data, "ts": time.time()}


def get_provider() -> str:
    return os.getenv("LLM_PROVIDER", "claude").lower()


def is_configured() -> bool:
    provider = get_provider()
    if provider == "claude":
        return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())
    elif provider == "openai":
        return bool(os.getenv("OPENAI_API_KEY", "").strip())
    elif provider == "groq":
        return bool(os.getenv("GROQ_API_KEY", "").strip())
    return False


def call_llm(prompt: str, system: str = "", max_tokens: int = 1024) -> str:
    """Unified LLM call. Returns plain text response."""
    provider = get_provider()
    key = _cache_key(prompt + system, provider)
    cached = _get_cached_response(key)
    if cached is not None:
        return cached

    try:
        if provider == "claude":
            result = _call_claude(prompt, system, max_tokens)
        elif provider == "openai":
            result = _call_openai(prompt, system, max_tokens)
        elif provider == "groq":
            result = _call_groq(prompt, system, max_tokens)
        else:
            result = f"[LLM not configured: unknown provider '{provider}']"
    except Exception as e:
        err = str(e)
        if "429" in err or "quota" in err.lower() or "billing" in err.lower() or "rate_limit" in err.lower():
            result = f"[LLM quota exceeded: Your {provider.upper()} account has run out of credits or hit rate limits.]"
        elif "401" in err or "invalid" in err.lower() or "authentication" in err.lower():
            result = f"[LLM auth failed: API key is invalid or expired. Re-enter your {provider.upper()} key in Settings.]"
        else:
            result = f"[LLM error: {str(e)[:200]}]"

    _set_cached_response(key, result)
    return result


def _call_claude(prompt: str, system: str, max_tokens: int) -> str:
    import anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "[Claude API key not configured]"
    client = anthropic.Anthropic(api_key=api_key)
    kwargs = {
        "model": "claude-sonnet-4-5",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system
    msg = client.messages.create(**kwargs)
    return _strip_thinking(msg.content[0].text if msg.content else "")


def _call_openai(prompt: str, system: str, max_tokens: int) -> str:
    import openai as oai
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        return "[OpenAI API key not configured]"
    client = oai.OpenAI(api_key=api_key)
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=max_tokens,
        messages=messages,
    )
    return _strip_thinking(resp.choices[0].message.content or "")


def _call_groq(prompt: str, system: str, max_tokens: int) -> str:
    """Call Groq API (OpenAI-compatible). Uses llama-3.3-70b-versatile by default."""
    import openai as oai
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        return "[Groq API key not configured]"
    client = oai.OpenAI(
        api_key=api_key,
        base_url="https://api.groq.com/openai/v1",
    )
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    model = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    resp = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=messages,
    )
    return _strip_thinking(resp.choices[0].message.content or "")


def classify_sentiment(text: str) -> str:
    """Returns POSITIVE, NEUTRAL, or NEGATIVE."""
    if not text or not is_configured():
        return "NEUTRAL"
    prompt = (
        f"Classify the sentiment of this financial news as POSITIVE, NEUTRAL, or NEGATIVE. "
        f"Reply with one word only.\n\nNews: {text[:500]}"
    )
    result = call_llm(prompt, max_tokens=10)
    result = result.strip().upper()
    if "POSITIVE" in result:
        return "POSITIVE"
    elif "NEGATIVE" in result:
        return "NEGATIVE"
    return "NEUTRAL"


def update_settings(provider: str, anthropic_key: str = "", openai_key: str = "", groq_key: str = "", overwrite_keys: bool = False) -> None:
    """Update .env and os.environ. Only overwrites keys when overwrite_keys=True."""
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")

    existing = {}
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    existing[k.strip()] = v.strip()
    except FileNotFoundError:
        pass

    if provider:
        existing["LLM_PROVIDER"] = provider
        os.environ["LLM_PROVIDER"] = provider

    if overwrite_keys:
        existing["ANTHROPIC_API_KEY"] = anthropic_key
        os.environ["ANTHROPIC_API_KEY"] = anthropic_key
        existing["OPENAI_API_KEY"] = openai_key
        os.environ["OPENAI_API_KEY"] = openai_key
        existing["GROQ_API_KEY"] = groq_key
        os.environ["GROQ_API_KEY"] = groq_key
    else:
        if anthropic_key:
            existing["ANTHROPIC_API_KEY"] = anthropic_key
            os.environ["ANTHROPIC_API_KEY"] = anthropic_key
        if openai_key:
            existing["OPENAI_API_KEY"] = openai_key
            os.environ["OPENAI_API_KEY"] = openai_key
        if groq_key:
            existing["GROQ_API_KEY"] = groq_key
            os.environ["GROQ_API_KEY"] = groq_key

    with open(env_path, "w") as f:
        for k, v in existing.items():
            f.write(f"{k}={v}\n")
