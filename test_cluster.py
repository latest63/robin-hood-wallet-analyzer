import json
import os

DATA_FILE = "data/cluster.json"

# Load existing cluster
if os.path.exists(DATA_FILE):
    with open(DATA_FILE, "r") as f:
        cluster_data = json.load(f)
else:
    cluster_data = []

# Save cluster with 10 traders (just for testing)
with open(DATA_FILE, "w") as f:
    json.dump(cluster_data, f, indent=2)
    
print(f"Saved {len(cluster_data)} wallets")
