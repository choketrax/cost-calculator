from pydantic import BaseModel, Field
from typing import Literal

class ModelCapabilities(BaseModel):
    supports_caching: bool = False
    supports_vision: bool = False
    supports_tools: bool = False
    supports_structured_outputs: bool = False
    max_context_window: int = 4096
    max_output_tokens: int = 4096
    capability_class: Literal["reasoning", "general", "summarization", "embedding", "specialized"] = "general"
