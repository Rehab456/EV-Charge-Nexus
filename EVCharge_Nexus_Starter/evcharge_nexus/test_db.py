from database import get_connection

db = get_connection()

try:
    result = db.execute(
        "SELECT ? AS message",
        ("Database adapter working!",)
    ).fetchone()

    print(result["message"])

finally:
    db.close()