import sqlite3
from database import get_connection

local = sqlite3.connect("evcharge.db")
cloud = get_connection()
cursor = cloud.cursor()

tables = [
    "users",
    "vehicles",
    "reservations",
    "notifications",
    "push_subscriptions"
]

for table in tables:
    local_columns = {
        row[1]
        for row in local.execute(
            f"PRAGMA table_info({table})"
        )
    }

    cursor.execute("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = %s
    """, (table,))

    cloud_columns = {
        row["column_name"]
        for row in cursor.fetchall()
    }

    missing = local_columns - cloud_columns

    if missing:
        print(table, "- Missing:", missing)
    else:
        print(table, "- OK")

cursor.close()
cloud.close()
local.close()