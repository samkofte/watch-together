import sys
import json
from curl_cffi import requests

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No url provided"}))
        sys.exit(1)
        
    url = sys.argv[1]
    try:
        r = requests.get(url, impersonate="chrome124", timeout=12)
        print(json.dumps({
            "status": r.status_code,
            "text": r.text,
            "content_type": r.headers.get("content-type", "text/html")
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
