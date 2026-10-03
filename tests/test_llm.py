import asyncio

from google.genai import errors

from app.llm import _generate


class _Response:
    def __init__(self, text: str):
        self.text = text


class _Models:
    def __init__(self, results: dict):
        self.results = results
        self.calls: list[str] = []

    async def generate_content(self, model, contents, config):
        self.calls.append(model)
        result = self.results[model]
        if isinstance(result, Exception):
            raise result
        return result


class _Client:
    def __init__(self, models):
        self.aio = self
        self.models = models


def _unavailable(model: str) -> errors.APIError:
    return errors.APIError(503, {"error": {"message": f"{model} high demand", "status": "UNAVAILABLE"}})


def test_generate_falls_back_when_model_is_overloaded(monkeypatch):
    models = _Models(
        {
            "gemini-3.8-flash": _unavailable("gemini-3.8-flash"),
            "gemini-3.7-flash": _Response('{"ok": true}'),
        }
    )
    monkeypatch.setattr("app.llm.get_client", lambda: _Client(models))

    text = asyncio.run(_generate("gemini-3.8-flash", "prompt", config=_config()))

    assert text == '{"ok": true}'
    assert models.calls == ["gemini-3.8-flash", "gemini-3.7-flash"]


def _config():
    from google.genai import types

    return types.GenerateContentConfig()
