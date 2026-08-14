"""Pricing registry management routes."""
from __future__ import annotations

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_api_key
from ..schemas import AddPricingRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["pricing"], dependencies=[Depends(require_api_key)])


@router.get("/pricing")
async def list_pricing(
    request: Request,
    include_superseded: bool = False,
):
    registry = request.app.state.pricing_registry
    entries = registry.list_entries(include_superseded=include_superseded)
    return {
        "status": "ok",
        "data": [e.model_dump(mode="json") for e in entries],
        "meta": {
            "count": len(entries),
            "registry_version": registry.current_version(),
        },
    }


@router.get("/pricing/{provider}/{model}")
async def get_pricing(
    provider: str,
    model: str,
    request: Request,
    as_of: str = None,
):
    registry = request.app.state.pricing_registry
    as_of_date = date.fromisoformat(as_of) if as_of else None
    entry = registry.get_price(provider, model, as_of=as_of_date)
    if not entry:
        raise HTTPException(
            404,
            f"No pricing found for {provider}/{model}"
            + (f" as of {as_of}" if as_of else ""),
        )
    return {"status": "ok", "data": entry.model_dump(mode="json")}


@router.post("/pricing", status_code=201)
async def add_pricing(body: AddPricingRequest, request: Request):
    registry = request.app.state.pricing_registry

    from core.models import PricingEntry
    import uuid
    from datetime import datetime

    entry = PricingEntry(
        pricing_id=f"price-{body.provider}-{body.model.replace('/', '-')}-{uuid.uuid4().hex[:8]}",
        provider=body.provider,
        model=body.model,
        input_token_price=body.input_token_price,
        output_token_price=body.output_token_price,
        cached_input_price=body.cached_input_price,
        cached_output_price=body.cached_output_price,
        request_price=body.request_price,
        effective_from=body.effective_from,
        effective_to=None,
        source=body.source,
        version=1,
        created_at=datetime.utcnow(),
        is_superseded=False,
    )
    saved = registry.add_entry(entry)
    logger.info(f"Added pricing: {body.provider}/{body.model}")
    return {"status": "ok", "data": saved.model_dump(mode="json")}
