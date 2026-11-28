# EVCharge Nexus — Milestone 2

Professional Flask starter with homepage, account registration, sign-in, logout and protected dashboard. Station listings are sample data.

## Windows / VS Code

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe app.py
```

Open http://127.0.0.1:5000

For existing Milestone 1 installations, replace your existing project files with these files but **do not delete your .venv folder**. Stop the running Flask server (Ctrl+C) and restart it. SQLite creates evcharge.db automatically.

## Security notes

This is a local-development prototype. Before public deployment: set a strong SECRET_KEY environment variable; turn off Flask debug mode; add CSRF protection, rate limiting, verified email/password reset, HTTPS and production session configuration. Do not commit the database or secret key.


## Milestone 3 — EV Garage
Sign in and visit /vehicles to add, view, and remove EV profiles. Vehicle data is stored in a new SQLite table in the existing evcharge.db; do not replace your existing database. Existing signup and login remain functional.

## Vehicle catalog update
The /vehicles form now includes searchable manufacturer and model suggestions from static/vehicle_catalog.json. Users can still type any manufacturer/model manually. Catalog entries are indicative model names, **not verified availability in Pakistan**. Battery and connector specifications are intentionally not auto-filled because they vary by variant and import region. No existing database needs replacement.
