import requests
import json

# Test start monitor (without webhook to avoid spam)
cluster = [
    {"wallet": "0x00d78daf782921b27a6b407d34f19842c10a4a6b", "profit": 717000, "pnl": 24.8},
]

# Save cluster first
requests.post(
    "http://localhost:8000/api/cluster/save",
    json={"cluster": cluster},
    headers={"Content-Type": "application/json"}
)

# Start monitor
response = requests.post(
    "http://localhost:8000/api/monitor/start",
    json={"webhook": "https://httpbin.org/post"},
    headers={"Content-Type": "application/json"}
)

print(f"Status: {response.status_code}")
print(json.dumps(response.json(), indent=2))
