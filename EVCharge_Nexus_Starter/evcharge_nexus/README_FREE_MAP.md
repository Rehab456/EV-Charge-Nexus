# EVCharge Nexus — Free Live Station Map Update

This is a **small update**, not a replacement for your entire project. Based on Milestone 4, it preserves your login, vehicle catalog, dashboard, and local SQLite database.

## Install

1. Stop Flask (`Ctrl+C`). Make a backup of your project folder.
2. Copy `templates/stations.html`, `static/stations.js`, `static/style.css` and `free_map.py` from this ZIP into your existing `evcharge_nexus` folder. **Do not replace your `app.py`, `evcharge.db`, `.venv`, or other customized pages.**
3. Open your existing `app.py`. Add the following two lines **immediately above the existing `init_db()` near the bottom**:

```python
from free_map import free_map_bp
app.register_blueprint(free_map_bp)
```

4. Run `.venv\Scripts\python.exe app.py` and open `http://127.0.0.1:5000/stations` while logged in.

## What it does

- Leaflet map using OpenStreetMap tiles.
- Live community-maintained charging-station records via the Overpass API (no Google billing and no API key).
- Eight Pakistan cities, 25-km search radius per city, 15-minute in-memory cache.
- Connector filtering only when connector tags are present; no verified availability or pricing.
- Directions links open Google Maps website without requiring a Google Maps API key.

**Important:** The Overpass public endpoint has rate limits and may be unavailable. This is appropriate for a university prototype, not a production SLA. If the live API fails, the UI reports an error instead of presenting fictional stations as real. Reservations are not yet implemented; they will apply only to operator-managed/participating stations. Data is subject to OpenStreetMap licensing and attribution. The browser must be online to load map tiles. This update uses `urllib` from Python's standard library and needs no additional pip dependencies.

If you previously installed the optional Google Maps update, these files replace only its station page and JS. The original Flask `station_map` route should remain in `app.py`.
