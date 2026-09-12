from fastapi import APIRouter, Request, HTTPException, Query
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, timezone
import uuid
import json

router = APIRouter(prefix="/api/v1/policies", tags=["policies"])

class ScpPolicyBase(BaseModel):
    scope: str = Field(..., description="'agent','project','customer','global'")
    scope_id: str
    period: str = Field(..., description="'daily','monthly'")
    budget_usd: str
    warning_percent: float = 75.0
    block_percent: float = 100.0
    max_retries: int = 3
    fallback_model: Optional[str] = None
    max_context_tokens: int = 100000
    min_success_rate: float = 0.85
    min_cache_pct: float = 0.10
    max_review_minutes: float = 30.0
    allowed_hours_start: Optional[int] = None
    allowed_hours_end: Optional[int] = None
    expensive_models: List[str] = ["gpt-4o", "claude-opus-4-5"]
    enforcement_mode: str = "observe"
    enabled_rules: List[str] = []

class ScpPolicyCreate(ScpPolicyBase):
    pass

class ScpPolicyUpdate(BaseModel):
    budget_usd: Optional[str] = None
    warning_percent: Optional[float] = None
    block_percent: Optional[float] = None
    max_retries: Optional[int] = None
    fallback_model: Optional[str] = None
    max_context_tokens: Optional[int] = None
    min_success_rate: Optional[float] = None
    min_cache_pct: Optional[float] = None
    max_review_minutes: Optional[float] = None
    allowed_hours_start: Optional[int] = None
    allowed_hours_end: Optional[int] = None
    expensive_models: Optional[List[str]] = None
    enforcement_mode: Optional[str] = None
    enabled_rules: Optional[List[str]] = None

class ScpPolicy(ScpPolicyBase):
    policy_id: str
    created_at: str
    updated_at: str

@router.get("", response_model=List[ScpPolicy])
async def list_policies(request: Request, scope: Optional[str] = None, scope_id: Optional[str] = None):
    repo = request.app.state.repo
    query = "SELECT * FROM scp_policies"
    params = []
    if scope and scope_id:
        query += " WHERE scope = ? AND scope_id = ?"
        params.extend([scope, scope_id])
    
    rows = await repo.execute_raw(query, params)
    
    results = []
    for row in rows:
        results.append(ScpPolicy(
            policy_id=row["policy_id"],
            scope=row["scope"],
            scope_id=row["scope_id"],
            period=row["period"],
            budget_usd=row["budget_usd"],
            warning_percent=row["warning_percent"],
            block_percent=row["block_percent"],
            max_retries=row["max_retries"],
            fallback_model=row["fallback_model"],
            max_context_tokens=row["max_context_tokens"],
            min_success_rate=row["min_success_rate"],
            min_cache_pct=row["min_cache_pct"],
            max_review_minutes=row["max_review_minutes"],
            allowed_hours_start=row["allowed_hours_start"],
            allowed_hours_end=row["allowed_hours_end"],
            expensive_models=json.loads(row["expensive_models"]),
            enforcement_mode=row["enforcement_mode"],
            enabled_rules=json.loads(row["enabled_rules"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"]
        ))
    return results

@router.post("", response_model=ScpPolicy)
async def create_policy(request: Request, policy: ScpPolicyCreate):
    repo = request.app.state.repo
    policy_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    
    expensive_models_json = json.dumps(policy.expensive_models)
    enabled_rules_json = json.dumps(policy.enabled_rules)
    
    query = """
    INSERT INTO scp_policies (
        policy_id, scope, scope_id, period, budget_usd, warning_percent, block_percent,
        max_retries, fallback_model, max_context_tokens, min_success_rate, min_cache_pct,
        max_review_minutes, allowed_hours_start, allowed_hours_end, expensive_models,
        enforcement_mode, enabled_rules, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        policy_id, policy.scope, policy.scope_id, policy.period, policy.budget_usd,
        policy.warning_percent, policy.block_percent, policy.max_retries, policy.fallback_model,
        policy.max_context_tokens, policy.min_success_rate, policy.min_cache_pct,
        policy.max_review_minutes, policy.allowed_hours_start, policy.allowed_hours_end,
        expensive_models_json, policy.enforcement_mode, enabled_rules_json, now, now
    ]
    
    await repo.execute_raw(query, params)
    
    return ScpPolicy(
        policy_id=policy_id,
        **policy.dict(),
        created_at=now,
        updated_at=now
    )

@router.get("/{policy_id}", response_model=ScpPolicy)
async def get_policy(request: Request, policy_id: str):
    repo = request.app.state.repo
    query = "SELECT * FROM scp_policies WHERE policy_id = ?"
    rows = await repo.execute_raw(query, [policy_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Policy not found")
    
    row = rows[0]
    return ScpPolicy(
        policy_id=row["policy_id"],
        scope=row["scope"],
        scope_id=row["scope_id"],
        period=row["period"],
        budget_usd=row["budget_usd"],
        warning_percent=row["warning_percent"],
        block_percent=row["block_percent"],
        max_retries=row["max_retries"],
        fallback_model=row["fallback_model"],
        max_context_tokens=row["max_context_tokens"],
        min_success_rate=row["min_success_rate"],
        min_cache_pct=row["min_cache_pct"],
        max_review_minutes=row["max_review_minutes"],
        allowed_hours_start=row["allowed_hours_start"],
        allowed_hours_end=row["allowed_hours_end"],
        expensive_models=json.loads(row["expensive_models"]),
        enforcement_mode=row["enforcement_mode"],
        enabled_rules=json.loads(row["enabled_rules"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"]
    )

@router.put("/{policy_id}", response_model=ScpPolicy)
async def update_policy(request: Request, policy_id: str, updates: ScpPolicyUpdate):
    repo = request.app.state.repo
    
    # Verify exists
    existing = await repo.execute_raw("SELECT * FROM scp_policies WHERE policy_id = ?", [policy_id])
    if not existing:
        raise HTTPException(status_code=404, detail="Policy not found")
        
    now = datetime.now(timezone.utc).isoformat()
    update_data = updates.dict(exclude_unset=True)
    update_data["updated_at"] = now
    
    if "expensive_models" in update_data:
        update_data["expensive_models"] = json.dumps(update_data["expensive_models"])
    if "enabled_rules" in update_data:
        update_data["enabled_rules"] = json.dumps(update_data["enabled_rules"])
        
    set_clauses = ", ".join([f"{k} = ?" for k in update_data.keys()])
    params = list(update_data.values()) + [policy_id]
    
    query = f"UPDATE scp_policies SET {set_clauses} WHERE policy_id = ?"
    await repo.execute_raw(query, params)
    
    return await get_policy(request, policy_id)

@router.delete("/{policy_id}")
async def delete_policy(request: Request, policy_id: str):
    repo = request.app.state.repo
    query = "DELETE FROM scp_policies WHERE policy_id = ?"
    await repo.execute_raw(query, [policy_id])
    return {"status": "deleted"}

@router.post("/{policy_id}/enforce")
async def enforce_policy(request: Request, policy_id: str):
    repo = request.app.state.repo
    now = datetime.now(timezone.utc).isoformat()
    query = "UPDATE scp_policies SET enforcement_mode = 'enforce', updated_at = ? WHERE policy_id = ?"
    await repo.execute_raw(query, [now, policy_id])
    return await get_policy(request, policy_id)

@router.post("/{policy_id}/observe")
async def observe_policy(request: Request, policy_id: str):
    repo = request.app.state.repo
    now = datetime.now(timezone.utc).isoformat()
    query = "UPDATE scp_policies SET enforcement_mode = 'observe', updated_at = ? WHERE policy_id = ?"
    await repo.execute_raw(query, [now, policy_id])
    return await get_policy(request, policy_id)
