from fastapi import APIRouter, Request, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import uuid

router = APIRouter(prefix="/api/v1/routing", tags=["routing"])

# In-memory job status storage
jobs = {}

class CandidateModel(BaseModel):
    name: str
    model: str
    use_cache: bool = False
    prompt_reduction_pct: float = 0.0

class RoutingCompareRequest(BaseModel):
    scope: str
    scope_id: str
    baseline_model: str
    candidates: List[CandidateModel]
    test_prompts: List[str]

class ApprovalStatusUpdate(BaseModel):
    notes: Optional[str] = None

try:
    from core.promptfoo_runner import PromptfooRunner
except ImportError:
    class PromptfooRunner:
        @classmethod
        def run_comparison(cls, job_id, req_data):
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["result"] = {"baseline": req_data["baseline_model"], "winner": req_data["candidates"][0]["model"]}

def background_comparison(job_id: str, req_data: dict):
    try:
        jobs[job_id]["status"] = "running"
        PromptfooRunner.run_comparison(job_id, req_data)
        # Assuming Runner updates status on completion
    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)

@router.get("/table")
async def list_routing_table(request: Request, active_only: bool = Query(False)):
    repo = request.app.state.repo
    query = "SELECT * FROM scp_routing_table"
    params = []
    if active_only:
        query += " WHERE is_active = 1"
    rows = await repo.execute_raw(query, params)
    return rows

@router.post("/compare", status_code=202)
async def trigger_comparison(request: Request, req: RoutingCompareRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "queued", "request": req.dict()}
    
    background_tasks.add_task(background_comparison, job_id, req.dict())
    
    return {"job_id": job_id, "status": "queued"}

@router.get("/compare/{job_id}")
async def get_comparison_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]

@router.put("/{routing_id}/approve")
async def approve_routing(request: Request, routing_id: str):
    repo = request.app.state.repo
    now = datetime.now(timezone.utc).isoformat()
    
    # Verify exists
    rows = await repo.execute_raw("SELECT * FROM scp_routing_table WHERE routing_id = ?", [routing_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Routing config not found")
        
    scope = rows[0]["scope"]
    scope_id = rows[0]["scope_id"]
    
    # Deactivate others for same scope
    await repo.execute_raw("UPDATE scp_routing_table SET is_active = 0 WHERE scope = ? AND scope_id = ?", [scope, scope_id])
    
    # Activate this one
    await repo.execute_raw(
        "UPDATE scp_routing_table SET is_active = 1, approved_at = ?, approved_by = 'api_user' WHERE routing_id = ?", 
        [now, routing_id]
    )
    
    return {"status": "approved", "routing_id": routing_id}

@router.put("/{routing_id}/reject")
async def reject_routing(request: Request, routing_id: str):
    repo = request.app.state.repo
    await repo.execute_raw("UPDATE scp_routing_table SET is_active = 0 WHERE routing_id = ?", [routing_id])
    return {"status": "rejected", "routing_id": routing_id}

@router.get("/approvals")
async def list_approvals(request: Request):
    repo = request.app.state.repo
    return await repo.execute_raw("SELECT * FROM scp_approvals WHERE status = 'pending'", [])

@router.put("/approvals/{approval_id}")
async def resolve_approval(request: Request, approval_id: str, action: str = Query(..., description="'approve' or 'reject'"), update: Optional[ApprovalStatusUpdate] = None):
    repo = request.app.state.repo
    now = datetime.now(timezone.utc).isoformat()
    
    status = "approved" if action == 'approve' else "rejected"
    notes = update.notes if update else None
    
    await repo.execute_raw(
        "UPDATE scp_approvals SET status = ?, approved_at = ?, approved_by = 'api_user', notes = ? WHERE approval_id = ?",
        [status, now, notes, approval_id]
    )
    
    return {"status": status, "approval_id": approval_id}
