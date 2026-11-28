import os
import threading
import psycopg2

from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from dotenv import load_dotenv

from flask import (
    Flask, flash, redirect, render_template,
    request, session, url_for, g,
    send_from_directory
)

from werkzeug.security import (
    generate_password_hash,
    check_password_hash
)

# Load environment variables before importing modules
load_dotenv()

from database import get_connection
from free_map import free_map_bp
from reservations_backend import reservations_bp

from notifications_backend import (
    notifications_bp,
    process_all_reminders
)

from web_push import web_push_bp


# ==========================================
# APPLICATION CONFIGURATION
# ==========================================

BASE_DIR = Path(__file__).resolve().parent

IS_VERCEL = os.environ.get("VERCEL") == "1"

app = Flask(__name__)

SECRET_KEY = os.environ.get("SECRET_KEY")

if IS_VERCEL and not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is missing")

app.config["SECRET_KEY"] = (
    SECRET_KEY or "dev-only-change-before-deployment"
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_VERCEL,

    DATABASE_URL=os.environ.get("DATABASE_URL"),

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
# POSTGRESQL DATABASE CONNECTION
# ==========================================

def get_db():

    if "db" not in g:
        g.db = get_connection()

    return g.db


@app.teardown_appcontext
def close_db(error=None):

    db = g.pop("db", None)

    if db is not None:
        db.close()


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

            db = get_db()

            try:

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

            except psycopg2.errors.UniqueViolation:

                db.rollback()

                flash(
                    "An account with this email "
                    "already exists.",
                    "error"
                )

            except psycopg2.Error:

                db.rollback()

                app.logger.exception(
                    "Database error during signup"
                )

                flash(
                    "Unable to create account. "
                    "Please try again.",
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

            return redirect(
                url_for("login_welcome")
            )

    return render_template("login.html")


# ==========================================
# PERSONALIZED WELCOME ANIMATION
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

            try:

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

            except psycopg2.Error:

                db.rollback()

                app.logger.exception(
                    "Database error while adding vehicle"
                )

                flash(
                    "Unable to add vehicle. Please try again.",
                    "error"
                )

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

    try:

        result = db.execute("""
            DELETE FROM vehicles
            WHERE id = ?
              AND user_id = ?
        """, (
            vehicle_id,
            session["user_id"]
        ))

        deleted = result.rowcount

        db.commit()

        if deleted:

            flash(
                "Vehicle removed successfully.",
                "success"
            )

        else:

            flash(
                "Vehicle not found.",
                "error"
            )

    except psycopg2.Error:

        db.rollback()

        app.logger.exception(
            "Database error while deleting vehicle"
        )

        flash(
            "Unable to remove vehicle.",
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

# PostgreSQL tables have already been created
# using init_postgres.py.
#
# No SQLite initialization is required here.
# Database connections are opened when needed.


# ==========================================
# AUTOMATIC CHARGING REMINDER SCHEDULER
# ==========================================

REMINDER_CHECK_INTERVAL_SECONDS = 60

reminder_stop_event = threading.Event()


def reminder_worker():

    """
    Automatically check upcoming reservations
    every 60 seconds during local development.
    """

    while not reminder_stop_event.is_set():

        try:

            with app.app_context():

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
    Start the local background reminder scheduler.
    Vercel requires a separate scheduled mechanism.
    """

    if IS_VERCEL:
        return

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

    if not IS_VERCEL:

        start_reminder_scheduler()

    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=False
    )