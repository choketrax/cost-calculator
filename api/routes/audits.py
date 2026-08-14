"""Full API routes with real business logic — Audits, Upload, Ingest, Costs, Detect, Report."""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse

from ..auth import require_api_key
from ..schemas import CreateAuditRequest, IngestDataRequest

logger = logging.getLogger(__name__)

router = APIRouter(tags=["audits"], dependencies=[Depends(require_api_key)])


def _get_repo(request: Request):
    return request.app.state.repo


def _get_files(request: Request):
    return request.app.state.file_storage


def _get_registry(request: Request):
    return request.app.state.pricing_registry


# ---------------------------------------------------------------------------
# Audits CRUD
# ---------------------------------------------------------------------------

@router.post("/audits", status_code=201)
async def create_audit(body: CreateAuditRequest, request: Request):
    from core.models import Audit
    repo = _get_repo(request)
    import uuid
    audit_id = body.audit_id or str(uuid.uuid4())
    audit = Audit(
        audit_id=audit_id,
        customer_name=body.customer_name,
        period_start=body.period_start,
        period_end=body.period_end,
        notes=body.notes,
        status="ingesting",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    await repo.create_audit(audit)
    logger.info(f"Created audit: {audit_id}")
    return {"status": "ok", "data": {"audit_id": audit_id, "status": audit.status}}


@router.get("/audits")
async def list_audits(request: Request, limit: int = 50, offset: int = 0):
    repo = _get_repo(request)
    audits = await repo.list_audits(limit=limit, offset=offset)
    return {
        "status": "ok",
        "data": [a.model_dump(mode="json") for a in audits],
        "meta": {"limit": limit, "offset": offset, "count": len(audits)},
    }


@router.get("/audits/{audit_id}")
async def get_audit(audit_id: str, request: Request):
    repo = _get_repo(request)
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")
    return {"status": "ok", "data": audit.model_dump(mode="json")}


@router.delete("/audits/{audit_id}", status_code=200)
async def delete_audit(audit_id: str, request: Request):
    repo = _get_repo(request)
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")
    # Delete all associated data
    records_deleted = await repo.delete_records(audit_id)
    findings_deleted = await repo.delete_findings(audit_id)
    sims_deleted = await repo.delete_simulations(audit_id)
    await repo.delete_audit(audit_id)
    logger.info(f"Deleted audit {audit_id}: {records_deleted} records, {findings_deleted} findings, {sims_deleted} simulations")
    return {
        "status": "ok",
        "data": {
            "deleted": True,
            "records_deleted": records_deleted,
            "findings_deleted": findings_deleted,
            "simulations_deleted": sims_deleted,
        },
    }


# ---------------------------------------------------------------------------
# File Upload
# ---------------------------------------------------------------------------

@router.post("/audits/{audit_id}/upload")
async def upload_data(
    audit_id: str,
    request: Request,
    file: UploadFile = File(...),
    provider_hint: Optional[str] = Form(None),
    application: Optional[str] = Form("unknown"),
    workload: Optional[str] = Form("unknown"),
):
    repo = _get_repo(request)
    file_storage = _get_files(request)
    settings = request.app.state.settings

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    # Validate content type
    allowed_types = {"text/csv", "application/json", "application/octet-stream", "text/plain"}
    content_type = file.content_type or "application/octet-stream"
    filename = file.filename or "upload.csv"

    # Also check by extension as browsers often send wrong content types
    if not any(filename.endswith(ext) for ext in [".csv", ".json", ".txt"]):
        if content_type not in allowed_types:
            raise HTTPException(
                status_code=422,
                detail=f"Unsupported file type. Use CSV or JSON files.",
            )

    content = await file.read()
    size_bytes = len(content)

    if size_bytes > settings.max_upload_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size_bytes} bytes). Maximum is {settings.max_upload_size_bytes} bytes.",
        )

    file_hash = hashlib.sha256(content).hexdigest()
    file_key = f"audits/{audit_id}/uploads/{filename}"

    await file_storage.put(file_key, content, content_type)
    logger.info(f"Uploaded {filename} for audit {audit_id}: {size_bytes} bytes, hash={file_hash[:12]}...")

    return {
        "status": "ok",
        "data": {
            "file_key": file_key,
            "file_hash": file_hash,
            "filename": filename,
            "size_bytes": size_bytes,
            "provider_hint": provider_hint,
            "application": application,
            "workload": workload,
        },
    }


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

@router.post("/audits/{audit_id}/ingest")
async def ingest_data(audit_id: str, body: IngestDataRequest, request: Request):
    repo = _get_repo(request)
    file_storage = _get_files(request)
    registry = _get_registry(request)

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    # Load file from storage
    data = await file_storage.get(body.file_key)
    if data is None:
        raise HTTPException(status_code=404, detail=f"File not found: {body.file_key}")

    # Dispatch to correct importer
    from core.ingest.dispatcher import ImporterDispatcher
    dispatcher = ImporterDispatcher()

    filename = body.file_key.split("/")[-1]
    content_type = "text/csv" if filename.endswith(".csv") else "application/json"

    records, file_hash = dispatcher.import_file(
        data=data,
        filename=filename,
        content_type=content_type,
        audit_id=audit_id,
        provider_hint=body.provider_hint,
        application=body.application or "unknown",
        workload=body.workload or "unknown",
    )

    # Calculate costs for all records
    from core.pricing.calculator import CostCalculator
    calculator = CostCalculator(registry)
    records = calculator.calculate_batch(records)

    # Save records
    saved = await repo.save_records(records)

    # Update audit baseline cost
    total_cost = sum(r.cost for r in records)
    all_records = await repo.get_all_records(audit_id)
    all_total = sum(r.cost for r in all_records)

    audit.total_records = len(all_records)
    audit.baseline_monthly_cost = all_total
    audit.baseline_annual_cost = all_total * Decimal("12")
    audit.status = "analyzing"
    audit.updated_at = datetime.utcnow()
    await repo.update_audit(audit)

    logger.info(f"Ingested {saved} records for audit {audit_id}. Total cost: ${all_total:.2f}")

    return {
        "status": "ok",
        "data": {
            "records_imported": saved,
            "records_skipped": 0,
            "batch_cost": str(total_cost),
            "total_audit_cost": str(all_total),
            "file_hash": file_hash,
        },
    }


@router.get("/audits/{audit_id}/records")
async def get_records(audit_id: str, request: Request, limit: int = 100, offset: int = 0):
    repo = _get_repo(request)
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    records = await repo.get_records(audit_id, limit=limit, offset=offset)
    return {
        "status": "ok",
        "data": [r.model_dump(mode="json") for r in records],
        "meta": {"limit": limit, "offset": offset, "count": len(records)},
    }


# ---------------------------------------------------------------------------
# Cost Analysis
# ---------------------------------------------------------------------------

@router.get("/audits/{audit_id}/costs")
async def get_costs(audit_id: str, request: Request):
    repo = _get_repo(request)
    registry = _get_registry(request)

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    records = await repo.get_all_records(audit_id)
    if not records:
        raise HTTPException(status_code=422, detail="No records found. Ingest data first.")

    from core.pricing.calculator import CostCalculator
    calculator = CostCalculator(registry)
    breakdown = calculator.build_cost_breakdown(records)
    return {"status": "ok", "data": breakdown.model_dump(mode="json")}


# ---------------------------------------------------------------------------
# Waste Detection
# ---------------------------------------------------------------------------

@router.post("/audits/{audit_id}/detect")
async def detect_waste(audit_id: str, request: Request):
    repo = _get_repo(request)
    registry = _get_registry(request)

    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    records = await repo.get_all_records(audit_id)
    if not records:
        raise HTTPException(status_code=422, detail="No records found. Ingest data first.")

    from core.waste.runner import WasteDetectionRunner
    runner = WasteDetectionRunner(registry)
    findings = runner.detect_all(records, audit_id)

    # Save findings
    for finding in findings:
        await repo.save_finding(finding)

    logger.info(f"Detected {len(findings)} findings for audit {audit_id}")
    return {
        "status": "ok",
        "data": [f.model_dump(mode="json") for f in findings],
        "meta": {"count": len(findings)},
    }


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@router.get("/audits/{audit_id}/report", response_class=HTMLResponse)
async def get_report_html(audit_id: str, request: Request):
    repo = _get_repo(request)
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    records = await repo.get_all_records(audit_id)
    findings = await repo.get_findings(audit_id)
    simulations = await repo.list_simulations(audit_id)

    from core.report.generator import ReportGenerator
    registry = _get_registry(request)
    gen = ReportGenerator(registry)
    html = gen.generate_html(audit, records, findings, simulations)
    return HTMLResponse(content=html)


@router.get("/audits/{audit_id}/report.json")
async def get_report_json(audit_id: str, request: Request):
    repo = _get_repo(request)
    audit = await repo.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit '{audit_id}' not found")

    records = await repo.get_all_records(audit_id)
    findings = await repo.get_findings(audit_id)
    simulations = await repo.list_simulations(audit_id)

    from core.report.generator import ReportGenerator
    registry = _get_registry(request)
    gen = ReportGenerator(registry)
    report_data = gen.generate_json(audit, records, findings, simulations)
    return {"status": "ok", "data": report_data}
