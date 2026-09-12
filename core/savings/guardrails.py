from typing import Any
from ..catalog.models import ModelCatalog, ModelDefinition

class ValidationGuardrails:
    """Ensures rules don't make unsafe recommendations."""
    
    def __init__(self, catalog: ModelCatalog):
        self.catalog = catalog
        
    def check_model_switch_safety(self, current_model_id: str, proposed_model_id: str, provider_id: str = "openai") -> dict:
        """Validates if switching to a proposed model is safe based on capability classes."""
        current = self.catalog.get(provider_id, current_model_id)
        proposed = self.catalog.get(provider_id, proposed_model_id)
        
        if not current or not proposed:
            return {
                "safe": False,
                "risk": "high",
                "reason": "Model catalog missing definition for current or proposed model.",
                "validation_plan": "Manually benchmark quality before switching."
            }
            
        risk = "low"
        reasons = []
        
        # Capability class downgrades
        if current.capabilities.capability_class == "reasoning" and proposed.capabilities.capability_class != "reasoning":
            risk = "high"
            reasons.append("Downgrading from reasoning class to non-reasoning class.")
            
        if current.capabilities.supports_vision and not proposed.capabilities.supports_vision:
            risk = "high"
            reasons.append("Proposed model does not support vision, which may break multimodal workloads.")
            
        if current.capabilities.supports_tools and not proposed.capabilities.supports_tools:
            risk = "high"
            reasons.append("Proposed model does not support tool calling/functions.")
            
        if proposed.capabilities.max_context_window < current.capabilities.max_context_window:
            reasons.append(f"Context window reduction ({current.capabilities.max_context_window} -> {proposed.capabilities.max_context_window}).")
            if risk != "high":
                risk = "medium"
                
        # Default fallback
        if not reasons:
            reasons.append("Capabilities align.")
            
        validation_plan = "Review application logs."
        if risk == "high":
            validation_plan = "Requires extensive QA and regression testing on golden dataset. High risk of task failure."
        elif risk == "medium":
            validation_plan = "A/B test with 5% of traffic to ensure quality metrics hold."
            
        return {
            "safe": risk != "high",
            "risk": risk,
            "reason": " | ".join(reasons),
            "validation_plan": validation_plan
        }
