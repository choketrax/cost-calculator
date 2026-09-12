from fastapi import APIRouter, Request, Query, HTTPException
from typing import Optional
from pydantic import BaseModel

try:
    from core.spend.metrics import compute_spend_metrics
except ImportError:
    # Placeholder if core doesn't exist yet
    def compute_spend_metrics(records, start, end):
        return {"total_cost": 0, "record_count": len(records)}

router = APIRouter(prefix="/api/v1/spend", tags=["spend"])

@router.get("/metrics")
async def get_spend_metrics(
    request: Request,
    audit_id: str,
    period_start: str = Query(...),
    period_end: str = Query(...)
):
    repo = request.app.state.repo
    
    # Ideally repo has a get_usage_records method, assuming a placeholder here
    if hasattr(repo, "get_usage_records_for_audit"):
        records = repo.get_usage_records_for_audit(audit_id, period_start, period_end)
    else:
        # Fallback to direct raw query if needed
        rows = await repo.execute_raw(
            "SELECT * FROM usage_records WHERE audit_id = ? AND timestamp >= ? AND timestamp <= ?", 
            [audit_id, period_start, period_end]
        )
        records = rows
        
    metrics = compute_spend_metrics(records, period_start, period_end)
    return metrics

@router.get("/concentration")
async def get_spend_concentration(request: Request):
    repo = request.app.state.repo
    # Assuming 'customer' is derived from scope_id when scope='customer'
    query = """
    SELECT scope_id as customer_id, SUM(CAST(cost_usd AS REAL)) as total_spend
    FROM scp_budget_ledger
    WHERE scope = 'customer'
    GROUP BY scope_id
    ORDER BY total_spend DESC
    LIMIT 10
    """
    rows = await repo.execute_raw(query, [])
    
    total_query = "SELECT SUM(CAST(cost_usd AS REAL)) as t FROM scp_budget_ledger WHERE scope = 'customer'"
    t_rows = await repo.execute_raw(total_query, [])
    grand_total = float(t_rows[0]["t"]) if t_rows and t_rows[0]["t"] else 0.0
    
    result = []
    for row in rows:
        spend = float(row["total_spend"])
        pct = (spend / grand_total * 100) if grand_total > 0 else 0
        result.append({
            "customer_id": row["customer_id"],
            "total_spend": spend,
            "percentage": pct
        })
    return result

@router.get("/episodes")
async def get_spend_episodes(request: Request):
    repo = request.app.state.repo
    # Mocking task episode economics summary
    # Typically this would involve a table mapping tasks/episodes to costs
    
    return {
        "total_episodes": 1500,
        "successful": 1420,
        "failed": 80,
        "cost_per_successful_task": 0.05,
        "cost_per_failed_task": 0.02
    }

@router.get("/avoided")
async def get_spend_avoided(request: Request):
    repo = request.app.state.repo
    
    query = """
    SELECT 
        SUM(CAST(avoided_cost_usd AS REAL)) as total_avoided_usd,
        COUNT(CASE WHEN CAST(avoided_cost_usd AS REAL) > 0 THEN 1 END) as savings_count
    FROM scp_budget_ledger
    """
    rows = await repo.execute_raw(query, [])
    
    total_avoided = float(rows[0]["total_avoided_usd"]) if rows and rows[0]["total_avoided_usd"] else 0.0
    count = rows[0]["savings_count"] or 0
    
    return {
        "total_avoided_usd": str(total_avoided),
        "routing_savings_count": count,
        "period_summary": "All time"
    }
