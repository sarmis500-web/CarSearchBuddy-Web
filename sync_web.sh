#!/bin/bash
# sync_web.sh — Copies latest scraped inventory to the web dashboard
# Run this after each scraper run to update the live site data.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$PROJECT_ROOT/scraper/data/michigan/inventory.json"
DEST="$SCRIPT_DIR/data.json"

if [ ! -f "$SRC" ]; then
    echo "❌ No inventory file found at: $SRC"
    echo "   Run the scraper first: cd scraper && source venv/bin/activate && python scrape_inventory.py"
    exit 1
fi

cp "$SRC" "$DEST"
VEHICLE_COUNT=$(python3 -c "import json; print(len(json.load(open('$DEST')).get('vehicles', [])))" 2>/dev/null || echo "?")
echo "✅ Synced $VEHICLE_COUNT vehicles to web/data.json"
