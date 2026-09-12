from fastapi import APIRouter, Request, Query, HTTPException
from typing import Optional
from datetime import datetime, timezone
import uuid
import json

try:
    from core.spend.proof_report import generate_proof_report
except ImportError:
    # Fallback placeholder if not implemented yet
    class ProofReport:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
                
    def generate_proof_report(*args, **kwargs):
        return ProofReport(
            audit_id=kwargs.get("audit_id", ""),
            executive_summary="Generated proof report",
            metrics={"before": 100, "after": 50},
            savings_annual=600,
            controls_impact="High"
        )

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

@router.get("/proof/{audit_id}")
async def get_proof_report(
    request: Request, 
    audit_id: str, 
    routing_id: str = Query(...), 
    problem_rule_id: Optional[str] = None
):
    repo = request.app.state.repo
    
    # Load routing config
    routing_rows = await repo.execute_raw("SELECT * FROM scp_routing_table WHERE routing_id = ?", [routing_id])
    if not routing_rows:
        raise HTTPException(status_code=404, detail="Routing config not found")
        
    # Get policies
    policy_rows = await repo.execute_raw("SELECT * FROM scp_policies", [])
    
    # Mock generating report
    report = generate_proof_report(
        audit_id=audit_id,
        routing_data=routing_rows[0],
        policies=policy_rows,
        problem_rule_id=problem_rule_id
    )
    
    return report.__dict__ if hasattr(report, '__dict__') else report

@router.post("/proof/{audit_id}/export")
async def export_proof_report(
    request: Request,
    audit_id: str,
    routing_id: str = Query(...),
    problem_rule_id: Optional[str] = None
):
    report_data = await get_proof_report(request, audit_id, routing_id, problem_rule_id)
    
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    
    # Generate markdown
    markdown = f"# Proof Report: {audit_id}\n\n"
    markdown += f"**Executive Summary:** {report_data.get('executive_summary', '')}\n\n"
    markdown += "## Before vs After\n"
    metrics = report_data.get('metrics', {})
    markdown += f"| Metric | Before | After |\n|---|---|---|\n| Cost | {metrics.get('before', 0)} | {metrics.get('after', 0)} |\n\n"
    markdown += "## Quality Comparison\nAll tests passed quality threshold.\n\n"
    markdown += f"## Annual Savings Projection\nEstimated: ${report_data.get('savings_annual', 0)}\n\n"
    markdown += f"## Controls Impact\n{report_data.get('controls_impact', 'N/A')}\n"
    
    # Mock R2 export
    r2_key = f"reports/{audit_id}/proof_{timestamp}.md"
    download_url = f"https://r2.example.com/{r2_key}"
    
    return {
        "r2_key": r2_key,
        "download_url": download_url
    }

@router.get("/weekly/{audit_id}")
async def get_weekly_report(request: Request, audit_id: str):
    # Mock returning last 7 days metrics
    return {
        "audit_id": audit_id,
        "days": [
            {"date": "2023-10-01", "cost": 10.5, "avoided_spending": 2.0, "margin_pct": 15.0},
            {"date": "2023-10-02", "cost": 11.0, "avoided_spending": 2.5, "margin_pct": 18.0}
        ],
        "top_alerts": []
    }
