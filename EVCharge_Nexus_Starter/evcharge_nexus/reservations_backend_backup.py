
import math
import secrets
import sqlite3

from datetime import datetime, timedelta, timezone

from flask import (
    Blueprint, current_app, jsonify, render_template,
    request, session, redirect, url_for
)

from free_map import CITIES, charging_stations
from notifications_backend import add_booking_notification
from web_push import send_push_to_user
from email_service import send_email_to_user


reservations_bp = Blueprint(
    "reservations_backend",
    __name__
)

PKT = timezone(timedelta(hours=5))
DEMO_PORTS_PER_STATION = 1
MAX_DAYS_AHEAD = 14


# ==========================================
# DATABASE
# ==========================================

def init_reservations_db(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reference TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            vehicle_id INTEGER NOT NULL,
            station_key TEXT NOT NULL,
            station_name TEXT NOT NULL,
            station_city TEXT NOT NULL,
            station_address TEXT NOT NULL,
            station_lat REAL,
            station_lng REAL,
            connector TEXT NOT NULL,
            start_at TEXT NOT NULL,
            end_at TEXT NOT NULL,
            current_soc INTEGER NOT NULL,
            target_soc INTEGER NOT NULL,
            energy_kwh REAL NOT NULL,
            estimated_cost REAL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            created_at TEXT NOT NULL
        )
    """)

    columns = {
        row[1]
        for row in db.execute(
            "PRAGMA table_info(reservations)"
        ).fetchall()
    }

    for column in ("station_lat", "station_lng"):
        if column not in columns:
            db.execute(
                f"ALTER TABLE reservations "
                f"ADD COLUMN {column} REAL"
            )

    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_reservation_slots
        ON reservations (
            station_key, status, start_at, end_at
        )
    """)

    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_reservation_user
        ON reservations (user_id, start_at)
    """)

    db.commit()


# ==========================================
# HELPERS
# ==========================================

def error(message, status=400, **extra):
    return jsonify({
        "error": message,
        **extra
    }), status


def login_check():
    return session.get("user_id")


def db_connection():
    db = sqlite3.connect(
        current_app.config["RESERVATIONS_DATABASE"],
        timeout=15
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=15000")
    return db


def find_station(city, station_id):
    with current_app.test_request_context(
        "/api/charging-stations",
        query_string={"city": city}
    ):
        response = charging_stations()

    if isinstance(response, tuple):
        response, status = response[0], response[1]

        if status != 200:
            return None

    payload = response.get_json()

    if not isinstance(payload, dict):
        return None

    return next(
        (
            station
            for station in payload.get("stations", [])
            if str(station.get("id")) == str(station_id)
        ),
        None
    )


def normalized(value):
    text = "".join(
        character
        for character in str(value or "").lower()
        if character.isalnum()
    )

    if "ccs" in text or "combo" in text:
        return "ccs2"

    if "chademo" in text:
        return "chademo"

    if "type2" in text or "mennekes" in text:
        return "type2"

    if "nacs" in text or "tesla" in text:
        return "nacs"

    if "gbt" in text:
        return "gbt"

    return text


def verified_coordinates(station):
    try:
        lat = float(station["lat"])
        lng = float(station["lng"])

    except (KeyError, TypeError, ValueError):
        return None

    if not (
        math.isfinite(lat)
        and math.isfinite(lng)
        and -90 <= lat <= 90
        and -180 <= lng <= 180
    ):
        return None

    return lat, lng


def station_key(city, station):
    return (
        f"{city.lower()}:"
        f"{float(station['lat']):.4f}:"
        f"{float(station['lng']):.4f}"
    )


def overlapping(db, key, start, end):
    row = db.execute("""
        SELECT COUNT(*) AS n
        FROM reservations
        WHERE station_key = ?
          AND status = 'confirmed'
          AND start_at < ?
          AND end_at > ?
    """, (
        key, end, start
    )).fetchone()

    return row["n"]


def alternatives(db, key, start, duration):
    suggestions = []
    now = datetime.now(PKT)
    limit = now + timedelta(days=MAX_DAYS_AHEAD)
    cursor = start + timedelta(minutes=30)

    while len(suggestions) < 3 and cursor <= limit:
        end = cursor + duration

        if (
            cursor > now
            and end <= limit
            and overlapping(
                db,
                key,
                cursor.isoformat(),
                end.isoformat()
            ) < DEMO_PORTS_PER_STATION
        ):
            suggestions.append(cursor.isoformat())

        cursor += timedelta(minutes=30)

    return suggestions


# ==========================================
# SAFE WEB PUSH HELPER
# ==========================================

def notify_phone(user_id, title, message):
    """
    Send Web Push after successful reservation commit.

    Push errors must never cancel a confirmed booking.
    """
    try:
        send_push_to_user(
            user_id=user_id,
            title=title,
            message=message,
            url="/my-reservations"
        )

    except Exception:
        current_app.logger.exception(
            "Unable to deliver Web Push notification"
        )


# ==========================================
# UPDATED EMAIL HELPER WITH LOGGING
# ==========================================

def notify_email(user_id, subject, message):
    """
    Send email after commit.

    Logs whether email delivery was attempted,
    accepted, or failed without cancelling booking.
    """

    current_app.logger.warning(
        "BOOKING EMAIL ATTEMPT: user_id=%s",
        user_id
    )

    try:
        delivered = send_email_to_user(
            user_id=user_id,
            subject=subject,
            message=message
        )

        if delivered:
            current_app.logger.warning(
                "BOOKING EMAIL SUCCESS: user_id=%s",
                user_id
            )
        else:
            current_app.logger.warning(
                "BOOKING EMAIL FAILED: user_id=%s",
                user_id
            )

    except Exception:
        current_app.logger.exception(
            "Unexpected booking email delivery error "
            "for user %s",
            user_id
        )


# ==========================================
# SLOT AVAILABILITY API
# ==========================================

@reservations_bp.get("/api/reservations/availability")
def charging_slot_availability():
    if not login_check():
        return error("Please sign in.", 401)

    city = request.args.get("city", "").strip()
    station_id = request.args.get(
        "station_id", ""
    ).strip()
    date_text = request.args.get(
        "date", ""
    ).strip()

    if city not in CITIES:
        return error("Choose a supported city.")

    if not station_id:
        return error("Choose a charging station.")

    try:
        duration_minutes = int(
            request.args.get("duration_minutes", "")
        )

        selected_date = datetime.strptime(
            date_text,
            "%Y-%m-%d"
        ).date()

    except (TypeError, ValueError):
        return error(
            "Provide a valid date and charging duration."
        )

    if not (
        15 <= duration_minutes <= 360
        and duration_minutes % 15 == 0
    ):
        return error(
            "Duration must be between 15 and 360 minutes "
            "in 15-minute steps."
        )

    now = datetime.now(PKT)
    deadline = now + timedelta(
        days=MAX_DAYS_AHEAD
    )

    if not (
        now.date() <= selected_date <= deadline.date()
    ):
        return error(
            "Choose a date within the next 14 days."
        )

    try:
        station = find_station(city, station_id)

    except Exception:
        current_app.logger.exception(
            "Unable to retrieve charging station data"
        )
        return error(
            "Charging station data is unavailable.",
            503
        )

    if (
        station is None
        or verified_coordinates(station) is None
    ):
        return error(
            "Charging station could not be verified.",
            503
        )

    key = station_key(city, station)
    slots = []
    db = db_connection()

    try:
        db.execute("BEGIN")

        for minute_of_day in range(0, 1440, 15):
            hour, minute = divmod(
                minute_of_day, 60
            )

            start = datetime(
                selected_date.year,
                selected_date.month,
                selected_date.day,
                hour,
                minute,
                tzinfo=PKT
            )

            end = start + timedelta(
                minutes=duration_minutes
            )

            if (
                start <= now
                or end > deadline
                or end.date() != selected_date
            ):
                slot_status = "unavailable"

            elif overlapping(
                db,
                key,
                start.isoformat(),
                end.isoformat()
            ) >= DEMO_PORTS_PER_STATION:
                slot_status = "booked"

            else:
                slot_status = "available"

            slots.append({
                "time": start.strftime("%H:%M"),
                "start_at": start.isoformat(),
                "end_at": end.isoformat(),
                "status": slot_status
            })

        db.commit()

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Charging availability database error"
        )

        return error(
            "Unable to check charging slots.",
            500
        )

    finally:
        db.close()

    return jsonify({
        "city": city,
        "station_id": station_id,
        "station_name": station.get("name")
            or "Charging station",
        "date": date_text,
        "duration_minutes": duration_minutes,
        "capacity_type": "simulated",
        "ports_per_station": DEMO_PORTS_PER_STATION,
        "slots": slots,
        "notice": (
            "Availability is based on EVCharge Nexus "
            "prototype reservations only. "
            "No real charging operator is connected."
        )
    })


# ==========================================
# CREATE RESERVATION
# ==========================================

@reservations_bp.post("/api/reservations")
def create_reservation():
    user_id = login_check()

    if not user_id:
        return error("Please sign in.", 401)

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return error("Invalid booking details.")

    city = str(data.get("city", "")).strip()
    station_id = str(
        data.get("station_id", "")
    ).strip()

    if city not in CITIES:
        return error("Choose a supported city.")

    if not station_id:
        return error("Choose a charging station.")

    try:
        vehicle_id = int(data.get("vehicle_id"))
        current_soc = int(data.get("current_soc"))
        target_soc = int(data.get("target_soc"))

        start = datetime.fromisoformat(
            str(data.get("start_at", ""))
        )

        if start.tzinfo is None:
            start = start.replace(tzinfo=PKT)

        start = start.astimezone(PKT)

    except (TypeError, ValueError, OverflowError):
        return error(
            "Invalid vehicle, battery, or date/time."
        )

    now = datetime.now(PKT)
    deadline = now + timedelta(
        days=MAX_DAYS_AHEAD
    )

    if not 0 <= current_soc < target_soc <= 100:
        return error(
            "Target battery must exceed current battery."
        )

    if not now < start <= deadline:
        return error(
            "Choose a future slot within 14 days."
        )

    if (
        start.minute % 15 != 0
        or start.second != 0
        or start.microsecond != 0
    ):
        return error(
            "Start time must be on a 15-minute boundary."
        )

    db = db_connection()

    try:
        vehicle = db.execute("""
            SELECT *
            FROM vehicles
            WHERE id = ?
              AND user_id = ?
        """, (
            vehicle_id, user_id
        )).fetchone()

        if vehicle is None:
            return error(
                "Saved vehicle not found.", 404
            )

        station = find_station(city, station_id)

        if station is None:
            return error(
                "Station could not be verified. "
                "Refresh station data and retry.",
                503
            )

        coordinates = verified_coordinates(
            station
        )

        if coordinates is None:
            return error(
                "Station coordinates are unavailable.",
                503
            )

        station_lat, station_lng = coordinates

        connectors = station.get(
            "connectors"
        ) or []

        if not any(
            normalized(connector)
            == normalized(vehicle["connector"])
            for connector in connectors
        ):
            return error(
                "Your vehicle connector is not "
                "listed at this station."
            )

        try:
            power = float(station["power_kw"])
            battery = float(vehicle["battery_kwh"])

        except (TypeError, ValueError, KeyError):
            return error(
                "Station charging power is unknown."
            )

        if not (
            math.isfinite(power)
            and power > 0
            and math.isfinite(battery)
            and battery > 0
        ):
            return error(
                "Invalid battery capacity or station power."
            )

        energy = (
            battery
            * (target_soc - current_soc)
            / 100
        )

        grid_energy = energy / 0.90

        minutes = max(
            15,
            math.ceil(
                (grid_energy / power * 60 * 1.25)
                / 15
            ) * 15
        )

        if minutes > 360:
            return error(
                "Estimated session exceeds six hours."
            )

        duration = timedelta(minutes=minutes)
        end = start + duration

        if end > deadline:
            return error(
                "Session must finish within 14 days."
            )

        if end.date() != start.date():
            return error(
                "Choose a slot that finishes "
                "on the same day."
            )

        raw_price = station.get(
            "price_per_kwh"
        )

        try:
            price = (
                float(raw_price)
                if raw_price is not None
                and raw_price != ""
                else None
            )
        except (TypeError, ValueError):
            price = None

        cost = (
            round(grid_energy * price, 2)
            if price is not None
            and math.isfinite(price)
            and price >= 0
            else None
        )

        key = station_key(city, station)

        # Atomic overlap protection
        db.execute("BEGIN IMMEDIATE")

        booked = overlapping(
            db,
            key,
            start.isoformat(),
            end.isoformat()
        )

        if booked >= DEMO_PORTS_PER_STATION:
            choices = alternatives(
                db, key, start, duration
            )

            db.rollback()

            return error(
                "This prototype slot is already booked.",
                409,
                alternatives=choices
            )

        reference = (
            "NX-" + secrets.token_hex(5).upper()
        )

        station_name = str(
            station.get("name")
            or "Charging station"
        )

        station_address = str(
            station.get("address")
            or city
        )

        db.execute("""
            INSERT INTO reservations (
                reference,
                user_id,
                vehicle_id,
                station_key,
                station_name,
                station_city,
                station_address,
                station_lat,
                station_lng,
                connector,
                start_at,
                end_at,
                current_soc,
                target_soc,
                energy_kwh,
                estimated_cost,
                status,
                created_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
        """, (
            reference,
            user_id,
            vehicle_id,
            key,
            station_name,
            city,
            station_address,
            station_lat,
            station_lng,
            vehicle["connector"],
            start.isoformat(),
            end.isoformat(),
            current_soc,
            target_soc,
            round(energy, 2),
            cost,
            "confirmed",
            datetime.now(
                timezone.utc
            ).isoformat()
        ))

        # Existing in-app booking notification
        confirmation_message = (
            f"Your prototype reservation at "
            f"{station_name} on "
            f"{start.strftime('%d %b %Y at %I:%M %p')} "
            f"(Pakistan time) has been confirmed."
        )

        add_booking_notification(
            db,
            user_id,
            reference,
            "confirmed",
            "Booking Confirmed",
            confirmation_message
        )

        # Save booking and in-app notification first.
        db.commit()

        current_app.logger.warning(
            "BOOKING SAVED: reference=%s, user_id=%s",
            reference,
            user_id
        )

        # Send browser push after successful commit.
        notify_phone(
            user_id,
            "Booking Confirmed - EVCharge Nexus",
            confirmation_message
        )

        # Send confirmation email after successful commit.
        confirmation_email = (
            "EVCharge Nexus - Booking Confirmation\n\n"
            "Your EV charging reservation has been confirmed.\n\n"
            f"Booking Reference: {reference}\n"
            f"Station: {station_name}\n"
            f"Address: {station_address}\n"
            f"City: {city}\n"
            f"Date: {start.strftime('%d %b %Y')}\n"
            f"Start Time: {start.strftime('%I:%M %p')} (PKT)\n"
            f"End Time: {end.strftime('%I:%M %p')} (PKT)\n"
            f"Connector: {vehicle['connector']}\n"
            f"Estimated Energy: {round(energy, 2)} kWh\n"
            f"Estimated Cost: "
            f"{'PKR ' + format(cost, '.2f') if cost is not None else 'Not available'}\n\n"
            "This is an academic prototype reservation. "
            "No real charging operator has been notified.\n\n"
            "Thank you for using EVCharge Nexus."
        )

        notify_email(
            user_id,
            "Booking Confirmed - EVCharge Nexus",
            confirmation_email
        )

        return jsonify({
            "message": "Prototype reservation confirmed",
            "reference": reference,
            "station_name": station_name,
            "station_address": station_address,
            "station_lat": station_lat,
            "station_lng": station_lng,
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "energy_kwh": round(energy, 2),
            "estimated_cost": cost,
            "notice": (
                "Academic prototype only. "
                "No real charging operator has been notified."
            )
        }), 201

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Reservation database error"
        )

        return error(
            "Unable to save reservation. Please retry.",
            500
        )

    finally:
        db.close()


# ==========================================
# GET RESERVATION HISTORY
# ==========================================

@reservations_bp.get("/api/reservations")
def list_reservations():
    user_id = login_check()

    if not user_id:
        return error("Please sign in.", 401)

    db = db_connection()

    try:
        rows = db.execute("""
            SELECT
                r.*,
                v.manufacturer,
                v.model
            FROM reservations r
            LEFT JOIN vehicles v
                ON v.id = r.vehicle_id
            WHERE r.user_id = ?
            ORDER BY r.start_at DESC
        """, (
            user_id,
        )).fetchall()

        return jsonify({
            "reservations": [
                dict(row)
                for row in rows
            ]
        })

    finally:
        db.close()


# ==========================================
# CANCEL RESERVATION
# ==========================================

@reservations_bp.post(
    "/api/reservations/<reference>/cancel"
)
def cancel_reservation(reference):
    user_id = login_check()

    if not user_id:
        return error("Please sign in.", 401)

    db = db_connection()

    try:
        db.execute("BEGIN IMMEDIATE")

        result = db.execute("""
            UPDATE reservations
            SET status = 'cancelled'
            WHERE reference = ?
              AND user_id = ?
              AND status = 'confirmed'
              AND start_at > ?
        """, (
            reference,
            user_id,
            datetime.now(PKT).isoformat()
        ))

        if not result.rowcount:
            db.rollback()
            return error(
                "Reservation not found, already "
                "cancelled, or already started.",
                409
            )

        cancellation_message = (
            f"Your prototype reservation "
            f"{reference} has been cancelled."
        )

        # Existing in-app cancellation notification
        add_booking_notification(
            db,
            user_id,
            reference,
            "cancelled",
            "Booking Cancelled",
            cancellation_message
        )

        # Remove reminders for cancelled booking.
        db.execute("""
            DELETE FROM notifications
            WHERE user_id = ?
              AND reservation_reference = ?
              AND kind = 'reminder'
        """, (
            user_id,
            reference
        ))

        db.commit()

        current_app.logger.warning(
            "BOOKING CANCELLED: reference=%s, user_id=%s",
            reference,
            user_id
        )

        # Send browser push after successful commit.
        notify_phone(
            user_id,
            "Booking Cancelled - EVCharge Nexus",
            cancellation_message
        )

        # Send cancellation email after successful commit.
        cancellation_email = (
            "EVCharge Nexus - Booking Cancellation\n\n"
            "Your EV charging reservation has been cancelled.\n\n"
            f"Booking Reference: {reference}\n"
            "Status: Cancelled\n\n"
            "You can create a new reservation through "
            "the EVCharge Nexus website.\n\n"
            "Thank you for using EVCharge Nexus."
        )

        notify_email(
            user_id,
            "Booking Cancelled - EVCharge Nexus",
            cancellation_email
        )

        return jsonify({
            "message": "Prototype reservation cancelled."
        })

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Reservation cancellation failed"
        )

        return error(
            "Unable to cancel reservation.",
            500
        )

    finally:
        db.close()


# ==========================================
# MY RESERVATIONS PAGE
# ==========================================

@reservations_bp.get("/my-reservations")
def my_reservations_page():
    if not login_check():
        return redirect(url_for("login"))

    return render_template(
        "my_reservations.html"
    )
