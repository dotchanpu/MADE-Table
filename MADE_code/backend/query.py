import json
import logging
import os
import time
from openai import OpenAI
import yaml
import requests
from pydantic import BaseModel
from agent.output_store import output_schema, role_description_text
from backend.logger import get_logger


# load global config
file_path = os.path.dirname(__file__)
project_path = os.path.dirname(file_path)
global_config = yaml.safe_load(open(os.path.join(project_path, "config/global.yaml"), "r"))

backend_config = global_config.get("backend") or {}
# Prefer environment variables so local/API credentials never need to be
# committed to global.yaml. The config values remain a backwards-compatible
# fallback for existing deployments.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY") or backend_config.get("openai_api_key")
KEY77_API_KEY = os.environ.get("KEY77_API_KEY") or backend_config.get("key77_api_key")
_configured_provider = str(backend_config.get("provider") or "custom").strip().lower()
LLM_PROVIDER = (
    os.environ.get("MADE_LLM_PROVIDER")
    or _configured_provider
).strip().lower()

_PROVIDER_DEFAULTS = {
    # DeepSeek's current OpenAI-compatible endpoint and model names.
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-flash",
        "api_key_env": "DEEPSEEK_API_KEY",
    },
    # DashScope's Beijing shared endpoint and a stable text model.
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "api_key_env": "DASHSCOPE_API_KEY",
    },
}

_provider_defaults = _PROVIDER_DEFAULTS.get(LLM_PROVIDER, {})
_provider_key_env = _provider_defaults.get("api_key_env")
_provider_key = os.environ.get(_provider_key_env) if _provider_key_env else None
_provider_base_env = {
    "deepseek": "DEEPSEEK_BASE_URL",
    "qwen": "DASHSCOPE_BASE_URL",
}.get(LLM_PROVIDER)
_provider_model_env = {
    "deepseek": "DEEPSEEK_MODEL",
    "qwen": "QWEN_MODEL",
}.get(LLM_PROVIDER)

if LLM_PROVIDER in _PROVIDER_DEFAULTS:
    _configured_provider_key = (
        backend_config.get(f"{LLM_PROVIDER}_api_key")
        or backend_config.get("api_key")
    )
    _configured_provider_base = backend_config.get("base_url")
    _configured_provider_model = (
        backend_config.get(f"{LLM_PROVIDER}_model")
        or (backend_config.get("model") if LLM_PROVIDER == _configured_provider else None)
    )
else:
    _configured_provider_key = backend_config.get("gr_api_key")
    _configured_provider_base = backend_config.get("gr_base_url")
    _configured_provider_model = backend_config.get("gr_model") or backend_config.get("model")

# The `gr` backend is retained as the generic OpenAI-compatible route used by
# the rest of MADE. `provider` selects the concrete service behind that route.
GR_API_KEY = (
    _provider_key
    or os.environ.get("MADE_LLM_API_KEY")
    or os.environ.get("MADE_GR_API_KEY")
    or os.environ.get("GR_API_KEY")
    or _configured_provider_key
)
GR_BASE_URL = (
    (os.environ.get(_provider_base_env) if _provider_base_env else None)
    or os.environ.get("MADE_LLM_BASE_URL")
    or os.environ.get("MADE_GR_BASE_URL")
    or _configured_provider_base
    or _provider_defaults.get("base_url")
    or "https://api.openai.com/v1"
)
GR_MODEL = (
    (os.environ.get(_provider_model_env) if _provider_model_env else None)
    or os.environ.get("MADE_LLM_MODEL")
    or _configured_provider_model
    or _provider_defaults.get("model")
    or "gpt-5.2"
)
OPENAI_MODEL = os.environ.get("OPENAI_MODEL") or backend_config.get("openai_model") or "gpt-5.2"

# Number of top logprobs to request for the EM action call. 0 (default) means
# the parameter is NOT sent -> identical to prior behavior (zero risk if the
# endpoint doesn't support it). Set backend.em_top_logprobs > 0 to populate
# response logprobs so the `uncertainty` intervention policy can compute an
# EM-action uncertainty (offline from the log, or online once wired).
EM_TOP_LOGPROBS = int(global_config.get("backend", {}).get("em_top_logprobs", 0) or 0)


def _extract_usage(response) -> dict:
    """Extract token usage from an OpenAI response object.

    chat.completions.create -> CompletionUsage(prompt_tokens=22, completion_tokens=6, total_tokens=28)
    responses.parse         -> ResponseUsage(input_tokens=None, output_tokens=None, total_tokens=1141)
    """
    usage = response.usage
    if usage is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    prompt = getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", None) or 0
    completion = getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", None) or 0
    total = getattr(usage, "total_tokens", None) or 0
    # responses.parse may only return total_tokens; leave prompt/completion as 0
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    }


def _extract_logprobs(response) -> list:
    """Extract logprobs from a chat.completions.create response.

    response.choices[0].logprobs = ChoiceLogprobs(
        content=[ChatCompletionTokenLogprob(token='Paris', logprob=-0.2014, ...), ...])
    """
    try:
        lp = response.choices[0].logprobs
        if lp is not None and lp.content:
            return [t.logprob for t in lp.content]
    except Exception:
        pass
    return []


def _extract_logprobs_parsed(response) -> list:
    """Extract logprobs from a responses.parse response.

    response.output[0].content[0].logprobs = [LogProb(token=..., logprob=...), ...]
    Note: returns empty list [] by default; need top_logprobs > 0 to get values.
    """
    try:
        for item in response.output:
            for part in item.content:
                if part.logprobs:
                    return [t.logprob for t in part.logprobs]
    except Exception:
        pass
    return []


def _retry_on_rate_limit(func, max_retries=5, base_delay=10):
    """Wrapper that retries on rate-limit (429) errors with exponential backoff."""
    def wrapper(*args, **kwargs):
        for attempt in range(max_retries):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                err_str = str(e).lower()
                if "rate limit" in err_str or "too many requests" in err_str or "429" in err_str:
                    if attempt < max_retries - 1:
                        delay = base_delay * (2 ** attempt)
                        print(f"[query] rate limited, retrying in {delay}s (attempt {attempt + 1}/{max_retries})")
                        time.sleep(delay)
                        continue
                raise
    return wrapper


def _log(call_type, role, backend, model, prompt, response_text, usage, logprobs, duration):
    """Send a record to the pipeline logger if initialized."""
    logger = get_logger()
    if logger is None:
        return
    logger.log_llm_call(
        call_type=call_type,
        role=role,
        backend=backend,
        model=model,
        prompt=prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False, default=str),
        response_text=response_text if isinstance(response_text, str) else json.dumps(response_text, ensure_ascii=False, default=str),
        prompt_tokens=usage.get("prompt_tokens", 0),
        completion_tokens=usage.get("completion_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
        logprobs=logprobs or None,
        duration_s=duration,
    )


# =====================================================================
# Plain text query
# =====================================================================

def query_func(backend: str):
    backend_mapping = {
        "openai": query_openai,
        "gr": query_gr,
    }
    return backend_mapping[backend]

def query(prompt, backend: str) -> str:
    query_function = query_func(backend)
    response = _retry_on_rate_limit(query_function)(prompt)
    return response

def query_openai(prompt):
    client = OpenAI(api_key=OPENAI_API_KEY)
    t0 = time.time()
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": prompt},
        ]
    )
    duration = time.time() - t0
    text = response.choices[0].message.content
    _log("query", "general", "openai", OPENAI_MODEL, prompt, text,
         _extract_usage(response), _extract_logprobs(response), duration)
    return text

def query_gr(prompt):
    client = OpenAI(
        api_key=GR_API_KEY,
        base_url=GR_BASE_URL
    )
    t0 = time.time()
    response = client.chat.completions.create(
        model=GR_MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": prompt},
        ]
    )
    duration = time.time() - t0
    text = response.choices[0].message.content
    _log("query", "general", LLM_PROVIDER, GR_MODEL, prompt, text,
         _extract_usage(response), _extract_logprobs(response), duration)
    return text


# =====================================================================
# JSON structured query
# =====================================================================

def _logprobs_kwargs(role: str) -> dict:
    """top_logprobs kwargs for responses.parse, only for the EM action call.

    Returns {} unless backend.em_top_logprobs > 0 AND this is the EM action
    ("em") -- so by default nothing changes and no unsupported parameter is ever
    sent. Restricted to role=="em" because only the EM action feeds the
    uncertainty policy; PM/summarizer calls need no logprobs.
    """
    if EM_TOP_LOGPROBS > 0 and role == "em":
        return {"top_logprobs": EM_TOP_LOGPROBS}
    return {}


def json_query_func(backend: str):
    backend_mapping = {
        "openai": json_query_openai,
        "gr": json_query_gr,
    }
    return backend_mapping[backend]

def json_query(prompt, role, backend: str) -> str:
    query_function = json_query_func(backend)
    response = _retry_on_rate_limit(query_function)(prompt, role)
    return response


def _structured_chat(client, model, prompt, role):
    """Call the broadly supported Chat Completions JSON mode.

    DeepSeek and DashScope both expose OpenAI-compatible Chat Completions, but
    provider support for OpenAI's Responses `parse()` helper is not uniform.
    JSON mode plus Pydantic validation keeps the same structured contract while
    working across both providers.
    """
    role_schema = output_schema(role)
    role_description = role_description_text(role)
    schema_json = json.dumps(role_schema.model_json_schema(), ensure_ascii=False)
    system_prompt = (
        f"{role_description}\n"
        "Return exactly one valid JSON object and no Markdown or extra text. "
        "The JSON must conform to this schema:\n"
        f"{schema_json}"
    )
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
    )
    content = response.choices[0].message.content or ""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{role} returned invalid JSON: {content[:500]}") from exc

    # DeepSeek sometimes emits the EM tool arguments as a plain object
    # (``{"container_id": "..."}``) even though the project schema describes
    # them as a list of ``{"key": ..., "value": ...}`` pairs.  Both forms
    # carry the same information; normalize the provider variant before
    # validating so a valid tool decision is not discarded by Pydantic.
    if role == "em" and isinstance(parsed, dict) and isinstance(parsed.get("arguments"), dict):
        parsed["arguments"] = [
            {"key": key, "value": value}
            for key, value in parsed["arguments"].items()
        ]
    return role_schema.model_validate(parsed), response

def json_query_openai(prompt, role):
    client = OpenAI(api_key=OPENAI_API_KEY)
    t0 = time.time()
    parsed, response = _structured_chat(client, OPENAI_MODEL, prompt, role)
    duration = time.time() - t0
    response_json = parsed.model_dump()
    _log("json_query", role, "openai", OPENAI_MODEL, prompt, response_json,
         _extract_usage(response), _extract_logprobs(response), duration)
    return response_json

def json_query_gr(prompt, role):
    client = OpenAI(
        api_key=GR_API_KEY,
        base_url=GR_BASE_URL
    )
    t0 = time.time()
    parsed, response = _structured_chat(client, GR_MODEL, prompt, role)
    duration = time.time() - t0
    response_json = parsed.model_dump()
    _log("json_query", role, LLM_PROVIDER, GR_MODEL, prompt, response_json,
         _extract_usage(response), _extract_logprobs(response), duration)
    return response_json


# =====================================================================
# Code generation query
# =====================================================================

def code_query(prompt, role, backend: str):
    backend_mapping = {
        "openai": code_query_openai,
        "gr": code_query_gr,
    }
    query_function = backend_mapping[backend]
    response = _retry_on_rate_limit(query_function)(prompt, role)
    return response

def code_query_openai(prompt, role):
    client = OpenAI(api_key=OPENAI_API_KEY)
    t0 = time.time()
    parsed, response = _structured_chat(client, OPENAI_MODEL, prompt, role)
    duration = time.time() - t0
    response_json = parsed.model_dump()
    _log("code_query", role, "openai", OPENAI_MODEL, prompt, response_json,
         _extract_usage(response), _extract_logprobs(response), duration)
    return response_json

def code_query_gr(prompt, role):
    client = OpenAI(
        api_key=GR_API_KEY,
        base_url=GR_BASE_URL
    )
    t0 = time.time()
    parsed, response = _structured_chat(client, GR_MODEL, prompt, role)
    duration = time.time() - t0
    response_json = parsed.model_dump()
    _log("code_query", role, LLM_PROVIDER, GR_MODEL, prompt, response_json,
         _extract_usage(response), _extract_logprobs(response), duration)
    return response_json
