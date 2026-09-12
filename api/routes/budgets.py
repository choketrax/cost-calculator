from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/v1/budgets", tags=["budgets"])

class BudgetEventCreate(BaseModel):
    scope: str
    scope_id: str
    cost_usd: str
    request_id: Optional[str] = None
    model: Optional[str] = None
    action_taken: Optional[str] = None
    avoided_cost_usd: Optional[str] = "0"

class BudgetSummary(BaseModel):
    scope: str
    scope_id: str
    period: str
    budget_usd: str
    spent_usd: str
    consumption_pct: float
    status: str
    avoided_spending_usd: str

class BudgetLedgerEntry(BaseModel):
    ledger_id: str
    policy_id: Optional[str]
    scope: str
    scope_id: str
    period: str
    cost_usd: str
    request_id: Optional[str]
    model: Optional[str]
    action_taken: Optional[str]
    avoided_cost_usd: str
    recorded_at: str

@router.get("", response_model=List[dict])
async def list_budgets(request: Request):
    repo = request.app.state.repo
    # Complex aggregation over scp_budget_ledger and joining with policies to get budget summary
    query = """
    SELECT l.scope, l.scope_id, l.period, 
           SUM(CAST(l.cost_usd AS REAL)) as spent, 
           SUM(CAST(l.avoided_cost_usd AS REAL)) as avoided,
           MAX(p.budget_usd) as budget
    FROM scp_budget_ledger l
    LEFT JOIN scp_policies p ON l.scope = p.scope AND l.scope_id = p.scope_id
    GROUP BY l.scope, l.scope_id, l.period
    """
    rows = await repo.execute_raw(query, [])
    
    results = []
    for row in rows:
        budget = float(row["budget"]) if row["budget"] else 0.0
        spent = float(row["spent"])
        pct = (spent / budget * 100) if budget > 0 else 0
        
        status = "ok"
        if pct >= 100:
            status = "exceeded"
        elif pct >= 90:
            status = "critical"
        elif pct >= 75:
            status = "warning"
            
        results.append({
            "scope": row["scope"],
            "scope_id": row["scope_id"],
            "period": row["period"],
            "budget_usd": str(budget),
            "spent_usd": str(spent),
            "consumption_pct": pct,
            "status": status,
            "avoided_spending_usd": str(row["avoided"] or "0")
        })
    return results

@router.get("/{scope}/{scope_id}", response_model=BudgetSummary)
async def get_budget(request: Request, scope: str, scope_id: str):
    repo = request.app.state.repo
    # Get current YYYY-MM
    current_period = datetime.now(timezone.utc).strftime("%Y-%m")
    
    query = """
    SELECT SUM(CAST(l.cost_usd AS REAL)) as spent, 
           SUM(CAST(l.avoided_cost_usd AS REAL)) as avoided
    FROM scp_budget_ledger l
    WHERE l.scope = ? AND l.scope_id = ? AND l.period = ?
    """
    rows = await repo.execute_raw(query, [scope, scope_id, current_period])
    spent = float(rows[0]["spent"]) if rows and rows[0]["spent"] else 0.0
    avoided = float(rows[0]["avoided"]) if rows and rows[0]["avoided"] else 0.0
    
    # Get policy
    p_query = "SELECT budget_usd, warning_percent, block_percent FROM scp_policies WHERE scope = ? AND scope_id = ?"
    p_rows = await repo.execute_raw(p_query, [scope, scope_id])
    
    budget = 0.0
    warning = 75.0
    block = 100.0
    if p_rows:
        budget = float(p_rows[0]["budget_usd"])
        warning = p_rows[0]["warning_percent"]
        block = p_rows[0]["block_percent"]
        
    pct = (spent / budget * 100) if budget > 0 else 0
    
    status = "ok"
    if pct >= block:
        status = "exceeded"
    elif pct >= warning + ((block - warning) / 2):
        status = "critical"
    elif pct >= warning:
        status = "warning"
        
    return BudgetSummary(
        scope=scope,
        scope_id=scope_id,
        period=current_period,
        budget_usd=str(budget),
        spent_usd=str(spent),
        consumption_pct=pct,
        status=status,
        avoided_spending_usd=str(avoided)
    )

@router.post("/ledger", response_model=BudgetLedgerEntry)
async def append_ledger(request: Request, event: BudgetEventCreate):
    repo = request.app.state.repo
    ledger_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    current_period = now.strftime("%Y-%m")
    recorded_at = now.isoformat()
    
    # get policy id if exists
    p_query = "SELECT policy_id FROM scp_policies WHERE scope = ? AND scope_id = ?"
    p_rows = await repo.execute_raw(p_query, [event.scope, event.scope_id])
    policy_id = p_rows[0]["policy_id"] if p_rows else None
    
    query = """
    INSERT INTO scp_budget_ledger (
        ledger_id, policy_id, scope, scope_id, period, cost_usd, 
        request_id, model, action_taken, avoided_cost_usd, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        ledger_id, policy_id, event.scope, event.scope_id, current_period, event.cost_usd,
        event.request_id, event.model, event.action_taken, event.avoided_cost_usd, recorded_at
    ]
    
    await repo.execute_raw(query, params)
    
    return BudgetLedgerEntry(
        ledger_id=ledger_id,
        policy_id=policy_id,
        scope=event.scope,
        scope_id=event.scope_id,
        period=current_period,
        cost_usd=event.cost_usd,
        request_id=event.request_id,
        model=event.model,
        action_taken=event.action_taken,
        avoided_cost_usd=event.avoided_cost_usd or "0",
        recorded_at=recorded_at
    )

@router.get("/{scope}/{scope_id}/history")
async def get_budget_history(request: Request, scope: str, scope_id: str):
    repo = request.app.state.repo
    # Get monthly spending history, last 6 periods
    query = """
    SELECT period, SUM(CAST(cost_usd AS REAL)) as spent
    FROM scp_budget_ledger
    WHERE scope = ? AND scope_id = ?
    GROUP BY period
    ORDER BY period DESC
    LIMIT 6
    """
    rows = await repo.execute_raw(query, [scope, scope_id])
    return rows

@router.get("/alerts")
async def get_budget_alerts(request: Request):
    # Retrieve budget entries currently at warning or above. 
    # For brevity, reuse list_budgets logic and filter.
    summaries = await list_budgets(request)
    return [s for s in summaries if s["status"] in ["warning", "critical", "exceeded"]]
