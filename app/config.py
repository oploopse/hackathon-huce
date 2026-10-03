from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    gemini_api_key: str = ""
    app_access_token: str = ""
    brain_model: str = "gemini-3.8-flash"
    fast_model: str = "gemini-3.5-flash-lite"
    live_model: str = "gemini-3.8-live"
    live_voice: str = "Kore"
    vad_silence_ms: int = 1800
    vad_prefix_padding_ms: int = 100

    interview_minutes: int = 15
    max_concepts_per_session: int = 6
    max_answers_per_concept: int = 4
    max_hints_per_concept: int = 1

    max_upload_mb: int = 20
    max_document_chars: int = 200_000
    data_dir: Path = ROOT_DIR / "data"
    web_dir: Path = ROOT_DIR / "web"


settings = Settings()
