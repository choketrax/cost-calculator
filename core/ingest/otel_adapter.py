# OTel GenAI semantic conventions → adapter → stable internal UsageRecord schema
#
# OpenTelemetry's GenAI semantic conventions continue to evolve: the original
# attributes registry marks several GenAI attributes as moved/deprecated in
# favor of the dedicated GenAI semantic-conventions working group.
# See: https://opentelemetry.io/docs/specs/semconv/gen-ai/
#
# This adapter is the SINGLE point of change. Raw OTel fields are never
# exposed directly to the rest of the application — they are normalized into
# the stable internal UsageRecord schema here. When GenAI attributes change,
# only this file needs updating.
from typing import Any, Dict, Tuple


class OpenTelemetryGenAIAdapter:
    """Normalize OpenTelemetry GenAI attributes into the AI Cost Auditor's
    internal UsageRecord schema.

    Supports current and legacy GenAI/LLM attribute names and preserves
    telemetry presence and provenance for auditability.

    Architecture: OTel spans → this adapter → UsageRecord (stable schema)
    Portkey, direct API calls, and other telemetry sources all flow through
    provider-specific importers that call into this adapter's normalization
    logic before returning a UsageRecord.
    """

    @staticmethod
    def extract_provider(
        attributes: Dict[str, Any],
        model: str
    ) -> Tuple[str, str, str]:
        """
        Returns:
            provider
            provider_source
            provider_attribute
        """

        if attributes.get("gen_ai.provider.name"):
            return (
                str(attributes["gen_ai.provider.name"]).lower(),
                "otel",
                "gen_ai.provider.name",
            )

        if attributes.get("gen_ai.system"):
            return (
                str(attributes["gen_ai.system"]).lower(),
                "legacy",
                "gen_ai.system",
            )

        if attributes.get("llm.provider"):
            return (
                str(attributes["llm.provider"]).lower(),
                "legacy",
                "llm.provider",
            )

        model_lower = str(model).lower()

        if "gpt" in model_lower or "text-embedding" in model_lower:
            return "openai", "inferred", "model_name"

        if "claude" in model_lower:
            return "anthropic", "inferred", "model_name"

        if "gemini" in model_lower:
            return "google", "inferred", "model_name"

        if "mistral" in model_lower or "codestral" in model_lower:
            return "mistral", "inferred", "model_name"

        return "unknown", "unknown", "none"

    @staticmethod
    def _extract_int(
        attributes: Dict[str, Any],
        *keys: str
    ) -> Tuple[int, str, str]:
        """
        Returns:
            normalized_value
            telemetry_status: "PRESENT_VALID", "MISSING", "PRESENT_INVALID"
            source_attribute
        """

        for key in keys:
            if key in attributes and attributes[key] is not None:
                try:
                    return int(attributes[key]), "PRESENT_VALID", key
                except (TypeError, ValueError):
                    return 0, "PRESENT_INVALID", key

        return 0, "MISSING", "none"

    @classmethod
    def extract(cls, attributes: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize OTel GenAI attributes into our internal representation."""

        # Models
        request_model_source = "none"

        for key in (
            "gen_ai.request.model",
            "gen_ai.model.name",
            "llm.model",
        ):
            value = attributes.get(key)
            if value:
                request_model = str(value)
                request_model_source = key
                break
        else:
            request_model = "unknown"

        response_model = attributes.get("gen_ai.response.model")

        if response_model:
            response_model = str(response_model)
            response_model_source = "gen_ai.response.model"
        else:
            response_model = request_model
            response_model_source = request_model_source

        # Provider
        provider, provider_source, provider_attribute = (
            cls.extract_provider(attributes, response_model)
        )

        # Tokens
        input_tokens, input_status, input_source = cls._extract_int(
            attributes,
            "gen_ai.usage.input_tokens",
            "llm.usage.prompt_tokens",
        )

        output_tokens, output_status, output_source = cls._extract_int(
            attributes,
            "gen_ai.usage.output_tokens",
            "llm.usage.completion_tokens",
        )

        cache_read_tokens, cache_read_status, cache_read_source = (
            cls._extract_int(
                attributes,
                "gen_ai.usage.cache_read.input_tokens",
            )
        )

        cache_creation_tokens, cache_creation_status, cache_creation_source = (
            cls._extract_int(
                attributes,
                "gen_ai.usage.cache_creation.input_tokens",
            )
        )

        reasoning_tokens, reasoning_status, reasoning_source = (
            cls._extract_int(
                attributes,
                "gen_ai.usage.reasoning.output_tokens",
            )
        )

        # Workflow / operation
        workflow = attributes.get("gen_ai.workflow.name")
        operation = attributes.get("gen_ai.operation.name")

        return {
            "provider": provider,
            "provider_source": provider_source,

            "request_model": request_model,
            "response_model": response_model,

            "workflow": workflow,
            "operation": operation,

            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read_tokens,
            "cache_creation_input_tokens": cache_creation_tokens,
            "reasoning_output_tokens": reasoning_tokens,

            "telemetry_presence": {
                "input_tokens": input_status,
                "output_tokens": output_status,
                "cache_read_input_tokens": cache_read_status,
                "cache_creation_input_tokens": cache_creation_status,
                "reasoning_output_tokens": reasoning_status,
                "workflow": "PRESENT_VALID" if workflow is not None else "MISSING",
                "operation": "PRESENT_VALID" if operation is not None else "MISSING",
            },

            "provenance": {
                "provider": provider_attribute,
                "request_model": request_model_source,
                "response_model": response_model_source,
                "input_tokens": input_source,
                "output_tokens": output_source,
                "cache_read_input_tokens": cache_read_source,
                "cache_creation_input_tokens": cache_creation_source,
                "reasoning_output_tokens": reasoning_source,
            },
        }
