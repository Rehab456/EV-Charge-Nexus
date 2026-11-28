
import os
import sqlite3
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask, flash, redirect, render_template,
    request, session, url_for, g,
    send_from_directory
)

from werkzeug.security import (
    generate_password_hash, check_password_hash
)

from free_map import free_map_bp

from reservations_backend import (
    reservations_bp, init_reservations_db
)

from notifications_backend import (
    notifications_bp,
    init_notifications_db,
    process_all_reminders
)

from web_push import (
    web_push_bp, init_web_push_db
)


# ==========================================
# APPLICATION CONFIGURATION
# ==========================================

BASE_DIR = Path(__file__).resolve().parent
DATABASE = BASE_DIR / "evcharge.db"

app = Flask(__name__)

app.config["SECRET_KEY"] = os.environ.get(
    "SECRET_KEY",
    "dev-only-change-before-deployment"
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    RESERVATIONS_DATABASE=str(DATABASE),

    VAPID_PUBLIC_KEY=os.environ.get(
        "VAPID_PUBLIC_KEY", ""
    )
)

app.register_blueprint(free_map_bp)
app.register_blueprint(reservations_bp)
app.register_blueprint(notifications_bp)
app.register_blueprint(web_push_bp)


# ==========================================
# SERVICE WORKER ROUTE
# ==========================================

@app.route("/sw.js")
def service_worker():
    response = send_from_directory(
        app.static_folder,
        "sw.js",
        mimetype="application/javascript"
    )

    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"

    return response


# ==========================================
# SAMPLE DASHBOARD STATIONS
# ==========================================

STATIONS = [
    {
        "name": "Nexus Central",
        "area": "Clifton",
        "connector": "CCS2",
        "power": 60,
        "price": 65,
        "available": True
    },
    {
        "name": "Nexus Express",
        "area": "DHA",
        "connector": "Type 2",
        "power": 22,
        "price": 45,
        "available": True
    },
    {
        "name": "Nexus City",
        "area": "Gulshan-e-Iqbal",
        "connector": "CCS2",
        "power": 50,
        "price": 55,
        "available": False
    }
]

CONNECTORS = (
    "CCS2",
    "Type 2",
    "CHAdeMO",
    "NACS",
    "GB/T"
)


# ==========================================
# DATABASE CONNECTION
# ==========================================

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(
            DATABASE,
            timeout=15
        )

        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA busy_timeout=15000")

    return g.db


@app.teardown_appcontext
def close_db(error=None):
    db = g.pop("db", None)

    if db is not None:
        db.close()


def init_db():
    with app.app_context():
        db = get_db()

        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS vehicles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                manufacturer TEXT NOT NULL,
                model TEXT NOT NULL,
                battery_kwh REAL NOT NULL
                    CHECK(battery_kwh > 0),
                connector TEXT NOT NULL,
                current_soc INTEGER NOT NULL
                    CHECK(current_soc BETWEEN 0 AND 100),
                target_soc INTEGER NOT NULL
                    CHECK(target_soc BETWEEN 0 AND 100),
                created_at TEXT NOT NULL
            )
        """)

        db.commit()


# ==========================================
# LOGIN REQUIRED
# ==========================================

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            flash(
                "Please sign in to continue.",
                "info"
            )

            return redirect(url_for("login"))

        return view(*args, **kwargs)

    return wrapped


@app.context_processor
def inject_user():
    return {
        "current_user_name": session.get("user_name")
    }


# ==========================================
# HOME
# ==========================================

@app.route("/")
def home():
    return render_template(
        "index.html",
        stations=STATIONS
    )


# ==========================================
# SIGNUP
# ==========================================

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        name = request.form.get(
            "full_name", ""
        ).strip()

        email = request.form.get(
            "email", ""
        ).strip().lower()

        password = request.form.get(
            "password", ""
        )

        confirm = request.form.get(
            "confirm_password", ""
        )

        if (
            not name
            or len(name) > 100
            or not email
            or len(email) > 254
            or "@" not in email
        ):
            flash(
                "Enter a valid name and email address.",
                "error"
            )

        elif len(password) < 8:
            flash(
                "Password must be at least 8 characters.",
                "error"
            )

        elif password != confirm:
            flash(
                "Passwords do not match.",
                "error"
            )

        else:
            try:
                db = get_db()

                db.execute("""
                    INSERT INTO users (
                        full_name,
                        email,
                        password_hash,
                        created_at
                    )
                    VALUES (?, ?, ?, ?)
                """, (
                    name,
                    email,
                    generate_password_hash(password),
                    datetime.now(
                        timezone.utc
                    ).isoformat()
                ))

                db.commit()

                flash(
                    "Account created successfully. "
                    "You can now sign in.",
                    "success"
                )

                return redirect(url_for("login"))

            except sqlite3.IntegrityError:
                flash(
                    "An account with this email "
                    "already exists.",
                    "error"
                )

    return render_template("signup.html")


# ==========================================
# LOGIN
# ==========================================

@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        email = request.form.get(
            "email", ""
        ).strip().lower()

        password = request.form.get(
            "password", ""
        )

        user = get_db().execute("""
            SELECT *
            FROM users
            WHERE email = ?
        """, (email,)).fetchone()

        if (
            user is None
            or not check_password_hash(
                user["password_hash"],
                password
            )
        ):
            flash(
                "Incorrect email or password.",
                "error"
            )

        else:
            session.clear()
            session["user_id"] = user["id"]
            session["user_name"] = user["full_name"]

            # NEW: Personalized welcome screen
            return redirect(url_for("login_welcome"))

    return render_template("login.html")


# ==========================================
# NEW: PERSONALIZED WELCOME ANIMATION
# ==========================================

@app.route("/login-welcome")
@login_required
def login_welcome():
    return render_template(
        "login_welcome.html",
        user_name=session.get("user_name", "User")
    )


# ==========================================
# DASHBOARD
# ==========================================

@app.route("/dashboard")
@login_required
def dashboard():
    db = get_db()

    vehicle_rows = db.execute("""
        SELECT
            id,
            manufacturer,
            model,
            battery_kwh,
            connector,
            current_soc,
            target_soc
        FROM vehicles
        WHERE user_id = ?
        ORDER BY id DESC
    """, (
        session["user_id"],
    )).fetchall()

    vehicles = [
        dict(vehicle)
        for vehicle in vehicle_rows
    ]

    return render_template(
        "dashboard.html",
        stations=STATIONS,
        vehicles=vehicles,
        vehicle_count=len(vehicles)
    )


# ==========================================
# LOGOUT
# ==========================================

@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()

    flash(
        "You have signed out successfully.",
        "success"
    )

    return redirect(url_for("home"))


# ==========================================
# EV GARAGE
# ==========================================

@app.route("/vehicles", methods=["GET", "POST"])
@login_required
def vehicles():
    db = get_db()

    if request.method == "POST":
        manufacturer = request.form.get(
            "manufacturer", ""
        ).strip()

        model = request.form.get(
            "model", ""
        ).strip()

        connector = request.form.get(
            "connector", ""
        )

        try:
            capacity = float(
                request.form.get("battery_kwh", "")
            )

            current = int(
                request.form.get("current_soc", "")
            )

            target = int(
                request.form.get("target_soc", "")
            )

        except (ValueError, TypeError):
            capacity = 0
            current = -1
            target = -1

        valid_vehicle = (
            1 <= len(manufacturer) <= 70
            and 1 <= len(model) <= 70
            and connector in CONNECTORS
            and 1 <= capacity <= 300
            and 0 <= current < target <= 100
        )

        if not valid_vehicle:
            flash(
                "Check your vehicle details. "
                "Target charge must exceed current charge.",
                "error"
            )

        else:
            db.execute("""
                INSERT INTO vehicles (
                    user_id,
                    manufacturer,
                    model,
                    battery_kwh,
                    connector,
                    current_soc,
                    target_soc,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session["user_id"],
                manufacturer,
                model,
                capacity,
                connector,
                current,
                target,
                datetime.now(
                    timezone.utc
                ).isoformat()
            ))

            db.commit()

            flash(
                "Vehicle added successfully.",
                "success"
            )

            return redirect(url_for("vehicles"))

    rows = db.execute("""
        SELECT *
        FROM vehicles
        WHERE user_id = ?
        ORDER BY id DESC
    """, (
        session["user_id"],
    )).fetchall()

    return render_template(
        "vehicles.html",
        vehicles=rows,
        connectors=CONNECTORS
    )


# ==========================================
# DELETE VEHICLE
# ==========================================

@app.route(
    "/vehicles/<int:vehicle_id>/delete",
    methods=["POST"]
)
@login_required
def delete_vehicle(vehicle_id):
    db = get_db()

    result = db.execute("""
        DELETE FROM vehicles
        WHERE id = ?
          AND user_id = ?
    """, (
        vehicle_id,
        session["user_id"]
    ))

    db.commit()

    if result.rowcount:
        flash(
            "Vehicle removed successfully.",
            "success"
        )
    else:
        flash(
            "Vehicle not found.",
            "error"
        )

    return redirect(url_for("vehicles"))


# ==========================================
# CHARGING STATION MAP
# ==========================================

@app.route("/stations")
@login_required
def station_map():
    vehicles = get_db().execute("""
        SELECT
            id,
            manufacturer,
            model,
            connector
        FROM vehicles
        WHERE user_id = ?
        ORDER BY id DESC
    """, (
        session["user_id"],
    )).fetchall()

    return render_template(
        "stations.html",
        vehicles=vehicles
    )


# ==========================================
# SMART RESERVATIONS
# ==========================================

@app.route("/reservations")
@login_required
def reservations():
    return render_template("reservations.html")


# ==========================================
# DATABASE INITIALIZATION
# ==========================================

init_db()

with app.app_context():
    db = get_db()

    init_reservations_db(db)
    init_notifications_db(db)
    init_web_push_db(db)


# ==========================================
# AUTOMATIC CHARGING REMINDER SCHEDULER
# ==========================================

REMINDER_CHECK_INTERVAL_SECONDS = 60

reminder_stop_event = threading.Event()


def reminder_worker():
    """
    Automatically check upcoming reservations
    every 60 seconds.

    Generates reminders through
    notifications_backend.py.
    """

    with app.app_context():
        while not reminder_stop_event.is_set():
            try:
                count = process_all_reminders()

                if count:
                    app.logger.info(
                        "Created %s charging reminder(s)",
                        count
                    )

            except Exception:
                app.logger.exception(
                    "Unexpected error in reminder scheduler"
                )

            reminder_stop_event.wait(
                REMINDER_CHECK_INTERVAL_SECONDS
            )


def start_reminder_scheduler():
    """
    Start the background reminder scheduler
    in a separate daemon thread.
    """

    worker = threading.Thread(
        target=reminder_worker,
        name="evcharge-reminder-scheduler",
        daemon=True
    )

    worker.start()

    app.logger.info(
        "Charging reminder scheduler started"
    )


# ==========================================
# START APPLICATION
# ==========================================

if __name__ == "__main__":

    # Flask debug mode starts two processes.
    # Start scheduler only in the serving process.

    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_reminder_scheduler()

    app.run(debug=True)
