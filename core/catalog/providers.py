from pydantic import BaseModel
from typing import Optional

class ProviderDefinition(BaseModel):
    provider_id: str
    display_name: str
    website: str
    status: str = "active"

class ProviderCatalog:
    def __init__(self):
        self._providers = {}
        self._seed_defaults()
        
    def _seed_defaults(self):
        self.add(ProviderDefinition(provider_id="openai", display_name="OpenAI", website="https://openai.com"))
        self.add(ProviderDefinition(provider_id="anthropic", display_name="Anthropic", website="https://anthropic.com"))
        
    def add(self, provider: ProviderDefinition):
        self._providers[provider.provider_id] = provider
        
    def get(self, provider_id: str) -> Optional[ProviderDefinition]:
        return self._providers.get(provider_id)
