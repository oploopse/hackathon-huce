import asyncio
import logging
from typing import TypeVar

from google import genai
from google.genai import errors, types
from pydantic import BaseModel, ValidationError

from .config import settings

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_RETRYABLE_CODES = {429, 500, 502, 503, 504}
# 429/503 là quá tải hoặc hết quota của đúng model đó; gọi lại cùng model thường vẫn lỗi.
_IMMEDIATE_FAILOVER = {429, 503}
_MAX_ATTEMPTS = 2
# Dùng khi model đang chọn không phản hồi. Thứ tự gần chất lượng của model não nhất.
_FALLBACK_MODELS = (
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
)

_client: genai.Client | None = None


class LLMNotConfigured(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not settings.gemini_api_key:
            raise LLMNotConfigured(
                "Chưa có GEMINI_API_KEY. Hãy tạo file .env từ .env.example và điền key lấy từ Google AI Studio."
            )
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


def _build_config(
    system: str, thinking_level: str | None, schema: type[BaseModel] | None
) -> types.GenerateContentConfig:
    kwargs: dict = {"system_instruction": system}
    if thinking_level:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=thinking_level)
    if schema is not None:
        kwargs["response_mime_type"] = "application/json"
        kwargs["response_json_schema"] = schema.model_json_schema()
    return types.GenerateContentConfig(**kwargs)


def _model_chain(model: str) -> list[str]:
    chain = [model]
    for candidate in _FALLBACK_MODELS:
        if candidate not in chain:
            chain.append(candidate)
    return chain


async def _generate(model: str, prompt: str, config: types.GenerateContentConfig) -> str:
    last_error: LLMError | None = None
    chain = _model_chain(model)
    for index, current in enumerate(chain):
        delay = 2.0
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                response = await get_client().aio.models.generate_content(
                    model=current, contents=prompt, config=config
                )
            except errors.APIError as exc:
                # Một số model (ví dụ dòng 2.x) không nhận thinking_level; thử lại không kèm cấu hình thinking.
                if exc.code == 400 and config.thinking_config and "think" in str(exc.message).lower():
                    config = config.model_copy(update={"thinking_config": None})
                    continue
                last_error = LLMError(f"Gemini API lỗi {exc.code}: {exc.message}")
                overloaded = exc.code in _IMMEDIATE_FAILOVER
                if exc.code in _RETRYABLE_CODES and not overloaded and attempt < _MAX_ATTEMPTS:
                    log.warning("Gemini %s trả lỗi %s, thử lại sau %.0fs", current, exc.code, delay)
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                if exc.code in _RETRYABLE_CODES and index < len(chain) - 1:
                    log.warning(
                        "Gemini %s lỗi %s, chuyển sang %s", current, exc.code, chain[index + 1]
                    )
                    break
                raise last_error from exc
            if not response.text:
                last_error = LLMError(f"Model {current} trả về nội dung rỗng")
                if index < len(chain) - 1:
                    log.warning("%s, chuyển sang %s", last_error, chain[index + 1])
                    break
                raise last_error
            if current != model:
                log.info("Dùng model dự phòng %s thay cho %s", current, model)
            return response.text
    raise last_error or LLMError(f"Gemini {model} không phản hồi")


async def generate_json(
    model: str, system: str, prompt: str, schema: type[T], thinking_level: str | None = "low"
) -> T:
    text = await _generate(model, prompt, _build_config(system, thinking_level, schema))
    try:
        return schema.model_validate_json(text)
    except ValidationError as exc:
        raise LLMError(f"Model {model} trả về JSON không đúng schema {schema.__name__}: {exc}") from exc


async def generate_text(
    model: str, system: str, prompt: str, thinking_level: str | None = "minimal"
) -> str:
    text = await _generate(model, prompt, _build_config(system, thinking_level, None))
    return text.strip()
