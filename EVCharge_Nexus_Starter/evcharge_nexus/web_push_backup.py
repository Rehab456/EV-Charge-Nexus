
import json
import os
import sqlite3

from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from flask import (
    Blueprint,
    current_app,
    jsonify,
    request,
    session
)

from pywebpush import webpush, WebPushException


web_push_bp = Blueprint("web_push", __name__)

BASE_DIR = Path(__file__).resolve().parent


# ==========================================
# DATABASE CONNECTION
# ==========================================

def get_db():
    db = sqlite3.connect(
        current_app.config["RESERVATIONS_DATABASE"],
        timeout=15
    )

    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=15000")

    return db


# ==========================================
# INITIALIZE WEB PUSH DATABASE
# ==========================================

def init_web_push_db(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            subscription_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_push_user
        ON push_subscriptions(user_id)
    """)

    db.commit()


# ==========================================
# HELPERS
# ==========================================

def error(message, status=400):
    return jsonify({
        "error": message
    }), status


def current_user():
    return session.get("user_id")


def valid_subscription(data):
    if not isinstance(data, dict):
        return False

    endpoint = data.get("endpoint")
    keys = data.get("keys")

    if not isinstance(endpoint, str):
        return False

    if len(endpoint) > 4096:
        return False

    parsed = urlparse(endpoint)

    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        return False

    if not isinstance(keys, dict):
        return False

    for key_name in ("p256dh", "auth"):
        value = keys.get(key_name)

        if (
            not isinstance(value, str)
            or not value
            or len(value) > 512
        ):
            return False

    return True


# ==========================================
# GET PUBLIC VAPID KEY
# ==========================================

@web_push_bp.get("/api/push/public-key")
def public_key():
    if not current_user():
        return error("Sign in required", 401)

    key = current_app.config.get(
        "VAPID_PUBLIC_KEY", ""
    )

    if not key:
        return error(
            "Push notifications are not configured",
            503
        )

    return jsonify({
        "public_key": key
    })


# ==========================================
# SUBSCRIBE DEVICE
# ==========================================

@web_push_bp.post("/api/push/subscribe")
def subscribe():
    user_id = current_user()

    if not user_id:
        return error("Sign in required", 401)

    data = request.get_json(silent=True)

    if not valid_subscription(data):
        return error(
            "Invalid push subscription",
            400
        )

    endpoint = data["endpoint"]

    subscription = {
        "endpoint": endpoint,
        "keys": {
            "p256dh": data["keys"]["p256dh"],
            "auth": data["keys"]["auth"]
        }
    }

    db = get_db()

    try:
        db.execute("""
            INSERT INTO push_subscriptions (
                user_id,
                endpoint,
                subscription_json,
                created_at
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                user_id = excluded.user_id,
                subscription_json = excluded.subscription_json,
                created_at = excluded.created_at
        """, (
            user_id,
            endpoint,
            json.dumps(subscription),
            datetime.now(
                timezone.utc
            ).isoformat()
        ))

        db.commit()

        return jsonify({
            "message": "Push notifications enabled"
        })

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Unable to save push subscription"
        )

        return error(
            "Unable to save push subscription",
            500
        )

    finally:
        db.close()


# ==========================================
# UNSUBSCRIBE DEVICE
# ==========================================

@web_push_bp.post("/api/push/unsubscribe")
def unsubscribe():
    user_id = current_user()

    if not user_id:
        return error("Sign in required", 401)

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return error("Invalid request", 400)

    endpoint = data.get("endpoint")

    if (
        not isinstance(endpoint, str)
        or not endpoint
    ):
        return error("Missing endpoint", 400)

    db = get_db()

    try:
        db.execute("""
            DELETE FROM push_subscriptions
            WHERE user_id = ?
              AND endpoint = ?
        """, (
            user_id,
            endpoint
        ))

        db.commit()

        return jsonify({
            "message": "Push notifications disabled"
        })

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Unable to remove push subscription"
        )

        return error(
            "Unable to disable push notifications",
            500
        )

    finally:
        db.close()


# ==========================================
# REMOVE EXPIRED SUBSCRIPTION
# ==========================================

def remove_expired_subscription(
    subscription_id,
    user_id
):
    db = get_db()

    try:
        db.execute("""
            DELETE FROM push_subscriptions
            WHERE id = ?
              AND user_id = ?
        """, (
            subscription_id,
            user_id
        ))

        db.commit()

    except sqlite3.Error:
        db.rollback()

        current_app.logger.exception(
            "Unable to remove expired subscription"
        )

    finally:
        db.close()


# ==========================================
# SEND WEB PUSH TO USER
# ==========================================

def send_push_to_user(
    user_id,
    title,
    message,
    url="/notifications"
):
    """
    Sends push notifications to devices registered
    by the specified user.

    Must be called after the reservation or
    notification database transaction commits.

    Returns the number of successful deliveries.
    """

    private_key = BASE_DIR / "vapid_private.pem"

    public_key = current_app.config.get(
        "VAPID_PUBLIC_KEY", ""
    )

    contact_email = os.environ.get(
        "VAPID_CONTACT_EMAIL", ""
    ).strip()

    if not private_key.is_file():
        current_app.logger.warning(
            "Web Push unavailable: VAPID private key missing"
        )
        return 0

    if not public_key:
        current_app.logger.warning(
            "Web Push unavailable: VAPID public key missing"
        )
        return 0

    if (
        not contact_email
        or "@" not in contact_email
    ):
        current_app.logger.warning(
            "Web Push unavailable: configure VAPID_CONTACT_EMAIL"
        )
        return 0

    # Only allow internal application destinations.
    if (
        not isinstance(url, str)
        or not url.startswith("/")
        or url.startswith("//")
    ):
        url = "/notifications"

    db = get_db()

    try:
        rows = db.execute("""
            SELECT
                id,
                subscription_json
            FROM push_subscriptions
            WHERE user_id = ?
        """, (
            user_id,
        )).fetchall()

    except sqlite3.Error:
        current_app.logger.exception(
            "Unable to retrieve push subscriptions"
        )
        return 0

    finally:
        db.close()

    if not rows:
        return 0

    payload = json.dumps({
        "title": str(title),
        "body": str(message),
        "url": url
    })

    successful = 0

    for row in rows:
        try:
            subscription = json.loads(
                row["subscription_json"]
            )

            webpush(
                subscription_info=subscription,
                data=payload,
                vapid_private_key=str(private_key),
                vapid_claims={
                    "sub": f"mailto:{contact_email}"
                },
                ttl=3600
            )

            successful += 1

        except WebPushException as exc:
            response = getattr(
                exc,
                "response",
                None
            )

            status = getattr(
                response,
                "status_code",
                None
            )

            current_app.logger.warning(
                "Push delivery failed with status %s",
                status
            )

            if status in (404, 410):
                remove_expired_subscription(
                    row["id"],
                    user_id
                )

        except Exception:
            current_app.logger.exception(
                "Unexpected Web Push delivery error"
            )

    return successful
