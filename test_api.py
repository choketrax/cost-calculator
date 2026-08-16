import urllib.request
import json
import urllib.error

url = "https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1/health"
try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as response:
        print("HEALTH:", response.read().decode())
except urllib.error.URLError as e:
    print(e.reason)

url_audits = "https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1/audits"
req = urllib.request.Request(url_audits, headers={"X-API-Key": "container-internal"})
try:
    with urllib.request.urlopen(req) as response:
        print("AUDITS:", response.read().decode())
except urllib.error.URLError as e:
    print(e.reason)
