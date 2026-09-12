from pydantic import BaseModel, Field
from typing import Optional
from datetime import date
from .capabilities import ModelCapabilities

class ModelDefinition(BaseModel):
    provider_id: str
    model_id: str
    display_name: str
    capabilities: ModelCapabilities
    deprecation_date: Optional[date] = None
    replacement_model_id: Optional[str] = None
    
class ModelCatalog:
    """In-memory or DB-backed registry of model capabilities and lifecycle."""
    def __init__(self):
        # We can seed this with standard models.
        self._models: dict[str, ModelDefinition] = {}
        self._seed_defaults()
        
    def _seed_defaults(self):
        # OpenAI
        self.add(ModelDefinition(
            provider_id="openai",
            model_id="gpt-4o",
            display_name="GPT-4o",
            capabilities=ModelCapabilities(
                supports_caching=True,
                supports_vision=True,
                supports_tools=True,
                max_context_window=128000,
                max_output_tokens=4096,
                capability_class="general"
            )
        ))
        self.add(ModelDefinition(
            provider_id="openai",
            model_id="gpt-4o-mini",
            display_name="GPT-4o Mini",
            capabilities=ModelCapabilities(
                supports_caching=True,
                supports_vision=True,
                supports_tools=True,
                max_context_window=128000,
                max_output_tokens=16384,
                capability_class="summarization"
            )
        ))
        # Anthropic
        self.add(ModelDefinition(
            provider_id="anthropic",
            model_id="claude-3-5-sonnet-20241022",
            display_name="Claude 3.5 Sonnet",
            capabilities=ModelCapabilities(
                supports_caching=True,
                supports_vision=True,
                supports_tools=True,
                max_context_window=200000,
                max_output_tokens=8192,
                capability_class="general"
            )
        ))
        
    def add(self, model: ModelDefinition):
        key = f"{model.provider_id}/{model.model_id}"
        self._models[key] = model
        
    def get(self, provider_id: str, model_id: str) -> Optional[ModelDefinition]:
        return self._models.get(f"{provider_id}/{model_id}")
