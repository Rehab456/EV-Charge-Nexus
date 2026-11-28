from database import get_connection
from free_map import init_station_cache

db = get_connection()

try:

    init_station_cache(db)

    print("Station cache table created successfully!")

finally:

    db.close()