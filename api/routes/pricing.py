from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any
from ..auth import require_api_key

router = APIRouter(tags=["pricing"], dependencies=[Depends(require_api_key)])

class PricingEntry(BaseModel):
    service: str
    region: str
    instance_type: str
    hourly_rate: str

@router.get("/pricing")
async def list_pricing():
    return {"status": "ok", "data": []}

@router.post("/pricing", status_code=201)
async def add_pricing(req: PricingEntry):
    return {"status": "ok", "data": req.model_dump()}
