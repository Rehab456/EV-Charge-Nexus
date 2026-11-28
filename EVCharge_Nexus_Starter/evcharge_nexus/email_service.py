import os
import smtplib
import psycopg2
import ssl

from email.message import EmailMessage
from flask import current_app
from database import get_connection


# ==========================================
# EMAIL CONFIGURATION
# ==========================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


# ==========================================
# GET REGISTERED USER EMAIL
# ==========================================

def get_user_email(user_id):

    """
    Retrieve the registered user's email
    from the Neon PostgreSQL database.
    """

    db = None

    try:

        db = get_connection()

        user = db.execute("""
            SELECT email
            FROM users
            WHERE id = ?
        """, (user_id,)).fetchone()

        if not user:
            return None

        return user["email"]

    except psycopg2.Error:

        current_app.logger.exception(
            "Unable to retrieve user email"
        )

        return None

    finally:

        if db is not None:
            db.close()


# ==========================================
# SEND EMAIL
# ==========================================

def send_email(to_email, subject, message):

    """
    Send an email using Gmail SMTP.

    SMTP credentials are read from environment
    variables, not hardcoded into the project.
    """

    sender_email = os.environ.get(
        "SMTP_EMAIL", ""
    ).strip()

    app_password = os.environ.get(
        "SMTP_APP_PASSWORD", ""
    ).replace(" ", "").strip()

    if not sender_email or not app_password:

        current_app.logger.warning(
            "Email service is not configured."
        )

        return False

    if not to_email:
        return False

    try:

        email = EmailMessage()

        email["From"] = sender_email
        email["To"] = to_email
        email["Subject"] = subject

        email.set_content(message)

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            context=context,
            timeout=15
        ) as server:

            server.login(
                sender_email,
                app_password
            )

            server.send_message(email)

        current_app.logger.info(
            "Email successfully sent."
        )

        return True

    except (
        smtplib.SMTPException,
        OSError,
        ValueError
    ):

        current_app.logger.exception(
            "Unable to send email"
        )

        return False


# ==========================================
# SEND EMAIL TO REGISTERED USER
# ==========================================

def send_email_to_user(
    user_id,
    subject,
    message
):

    """
    Find the user's registered email address
    and send the notification.
    """

    recipient = get_user_email(user_id)

    if not recipient:

        current_app.logger.warning(
            "No registered email found for user."
        )

        return False

    return send_email(
        to_email=recipient,
        subject=subject,
        message=message
    )