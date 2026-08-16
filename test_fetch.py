import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1/audits"
req = urllib.request.Request(url, headers={"X-API-Key": "container-internal", "User-Agent": "Mozilla/5.0"})

try:
    with urllib.request.urlopen(req, context=ctx) as response:
        data = json.loads(response.read().decode())
        audits = data.get("data", [])
        if audits:
            latest = audits[0]
            print(f"LATEST AUDIT: {latest['audit_id']} | Cost: {latest['baseline_monthly_cost']} | Records: {latest['total_records']} | Created: {latest['created_at']}")
            
            # Fetch costs
            url2 = f"https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1/audits/{latest['audit_id']}/costs"
            req2 = urllib.request.Request(url2, headers={"X-API-Key": "container-internal", "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req2, context=ctx) as response2:
                costs_data = json.loads(response2.read().decode())
                print("COSTS:", json.dumps(costs_data.get("data", {}), indent=2))
except Exception as e:
    print(f"Error: {e}")
