"""Findings review routes."""
from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_api_key
from ..schemas import ReviewFindingRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["findings"], dependencies=[Depends(require_api_key)])


@router.get("/audits/{audit_id}/findings")
async def get_findings(audit_id: str, request: Request):
    repo = request.app.state.repo
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(404, f"Audit '{audit_id}' not found")
    findings = await repo.get_findings(audit_id)
    return {
        "status": "ok",
        "data": [f.model_dump(mode="json") for f in findings],
        "meta": {"count": len(findings)},
    }


@router.get("/audits/{audit_id}/findings/{finding_id}")
async def get_finding(audit_id: str, finding_id: str, request: Request):
    repo = request.app.state.repo
    finding = await repo.get_finding(finding_id)
    if not finding or finding.audit_id != audit_id:
        raise HTTPException(404, f"Finding '{finding_id}' not found")
    return {"status": "ok", "data": finding.model_dump(mode="json")}


@router.patch("/audits/{audit_id}/findings/{finding_id}/review")
async def review_finding(
    audit_id: str,
    finding_id: str,
    body: ReviewFindingRequest,
    request: Request,
):
    repo = request.app.state.repo
    finding = await repo.get_finding(finding_id)
    if not finding or finding.audit_id != audit_id:
        raise HTTPException(404, f"Finding '{finding_id}' not found")

    finding.review_status = body.review_status
    finding.reviewed_at = datetime.utcnow()
    finding.reviewer_notes = body.reviewer_notes

    # Promote validation status on approval
    if body.review_status == "APPROVED" and finding.validation_status == "SIMULATED":
        finding.validation_status = "VALIDATED"

    await repo.update_finding(finding)
    logger.info(f"Finding {finding_id} reviewed: {body.review_status}")
    return {"status": "ok", "data": finding.model_dump(mode="json")}
