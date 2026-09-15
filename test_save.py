import requests
import json

# Test save cluster
cluster = [
    {"wallet": "0x00d78daf782921b27a6b407d34f19842c10a4a6b", "profit": 717000, "pnl": 24.8},
    {"wallet": "0x8a494ed488c5bc157e0fb2983fdfb90e2d63b691", "profit": 699000, "pnl": 32.2}
]

response = requests.post(
    "http://localhost:8000/api/cluster/save",
    json={"cluster": cluster},
    headers={"Content-Type": "application/json"}
)

print(f"Status: {response.status_code}")
print(json.dumps(response.json(), indent=2))
