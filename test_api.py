import asyncio
import httpx

API_BASE = "https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1"
API_KEY = "container-internal"

async def test_flow():
    headers = {"X-API-Key": API_KEY}
    
    # 1. Create audit
    print("1. Creating audit...")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{API_BASE}/audits",
            headers=headers,
            json={"customer_name": "test", "period_start": "2024-01-01", "period_end": "2024-12-31"}
        )
        print(resp.status_code, resp.text)
        if resp.status_code != 201:
            return
        audit_id = resp.json()["data"]["audit_id"]
        
    # 2. Upload file
    print(f"2. Uploading file for audit {audit_id}...")
    file_content = b"date,model,input_tokens,output_tokens,cached_tokens,requests,organization_id\n2024-10-01,gpt-4o,1250000,450000,0,3500,org-test\n"
    files = {"file": ("test.csv", file_content, "text/csv")}
    data = {"application": "test-app", "workload": "test-wl"}
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{API_BASE}/audits/{audit_id}/upload",
            headers=headers,
            data=data,
            files=files
        )
        print(resp.status_code, resp.text)
        if resp.status_code != 200:
            return
        file_key = resp.json()["data"]["file_key"]
        
    # 3. Ingest data
    print("3. Ingesting data...")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{API_BASE}/audits/{audit_id}/ingest",
            headers=headers,
            json={"file_key": file_key, "application": "test-app", "workload": "test-wl"}
        )
        print(resp.status_code, resp.text)

if __name__ == "__main__":
    asyncio.run(test_flow())
