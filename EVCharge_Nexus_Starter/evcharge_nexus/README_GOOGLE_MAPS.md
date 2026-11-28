# EVCharge Nexus — Google Maps Update

This update replaces the Leaflet station discovery screen with Google Maps and Google Places Nearby Search (New). It does not implement bookings or live charger availability.

## Setup on Windows (VS Code PowerShell)
1. In Google Cloud Console create/select a project and attach billing.
2. Enable **Maps JavaScript API** and **Places API (New)**.
3. Create a browser API key, restrict it to **Websites** (HTTP referrers), allowing `http://127.0.0.1:5000/*` and `http://localhost:5000/*`, and restrict APIs to **Maps JavaScript API** and **Places API (New)**.
4. In the VS Code terminal, set your key locally (do not share it in chat):

   `$env:GOOGLE_MAPS_API_KEY="YOUR_KEY_HERE"`

5. Start Flask in the same terminal: `.venv\Scripts\python.exe app.py`
6. Visit `http://127.0.0.1:5000/stations` and refresh.

The key is delivered to the browser as required for Google Maps JavaScript API; **browser referrer and API restrictions are essential**. For deployment, use environment configuration and allowed production domain referrers. Google Maps requests can incur charges. Set quotas/budget alerts.

## Existing project upgrade
Copy the updated `app.py`, `templates/stations.html`, and `static/google_stations.js` into the matching locations of your existing project. Do **not** replace your database (`evcharge.db`), virtual environment (`.venv`), or your other customized templates/styles.

## Limitations
Google Places returns station listings but does not guarantee availability, connector compatibility, price or operator authorization. Only operator-connected stations should be bookable. Nearby Search returns a limited set of results within a 25 km radius, not an exhaustive national database. Map display and Places search require internet access and an appropriately configured Google Cloud account.
