import os
import re
import json
import time
import math
import psycopg2
import urllib.parse
import urllib.request

from concurrent.futures import ThreadPoolExecutor
from flask import Blueprint, jsonify, request, session, current_app
from database import get_connection


free_map_bp = Blueprint("free_map", __name__)


# ==========================================
# SUPPORTED CITIES
# ==========================================

CITIES = {
    "Karachi": (24.8607, 67.0011),
    "Lahore": (31.5204, 74.3587),
    "Islamabad": (33.6844, 73.0479),
    "Rawalpindi": (33.5651, 73.0169),
    "Faisalabad": (31.4504, 73.1350),
    "Multan": (30.1575, 71.5249),
    "Peshawar": (34.0151, 71.5249),
    "Quetta": (30.1798, 66.9750),
    "Hyderabad": (25.3960, 68.3578),
}

SEARCH_RADIUS_KM = 100
CACHE_SECONDS = 900
PARTIAL_CACHE_SECONDS = 60
STALE_CACHE_SECONDS = 86400

CACHE = {}
SOURCE_CACHE = {}


# ==========================================
# KARACHI CHARGING DIRECTORY
# ==========================================

KARACHI_DIRECTORY = [
    {
        "aliases": [
            "go libra",
            "libra autos",
            "libra civil lines",
            "go petroleum libra",
        ],
        "power_kw": 160,
        "price_per_kwh": 110,
        "connectors": ["CCS2"],
        "source_url": (
            "https://paknev.com/charging/station/"
            "go-libra-civil-lines-saddar-area-karachi"
        ),
    },
    {
        "aliases": [
            "caltex estate avenue",
            "caltex estate",
        ],
        "power_kw": 120,
        "price_per_kwh": 110,
        "connectors": ["CCS2"],
        "source_url": "https://paknev.com/charging/karachi",
    },
    {
        "aliases": [
            "hubco green charging station",
            "hubco pso q-star",
            "hubco q star",
        ],
        "power_kw": 60,
        "price_per_kwh": 120,
        "connectors": ["CCS2"],
        "source_url": "https://paknev.com/charging/karachi",
    },
    {
        "aliases": [
            "inverex charging station",
            "inverex shahra",
        ],
        "power_kw": 60,
        "price_per_kwh": 115,
        "connectors": ["CCS2"],
        "source_url": "https://paknev.com/charging/karachi",
    },
    {
        "aliases": [
            "shell recharge askari 4",
            "shell askari 4",
        ],
        "power_kw": 50,
        "price_per_kwh": 130,
        "connectors": ["CCS2", "CHAdeMO"],
        "source_url": "https://paknev.com/charging/karachi",
    },
    {
        "aliases": [
            "shell recharge dha phase 5",
            "shell dha phase 5",
        ],
        "power_kw": 50,
        "price_per_kwh": 105,
        "connectors": ["CCS2"],
        "source_url": "https://paknev.com/charging/karachi",
    },
    {
        "aliases": [
            "ocean mall",
            "ocean towers",
        ],
        "power_kw": 30,
        "price_per_kwh": 130,
        "connectors": ["CCS2"],
        "source_url": "https://paknev.com/charging/karachi",
    },
]


# ==========================================
# PERSISTENT POSTGRESQL CACHE
# ==========================================

def init_station_cache(db):

    db.execute("""
        CREATE TABLE IF NOT EXISTS station_cache (
            city TEXT NOT NULL,
            source TEXT NOT NULL,
            data_json TEXT NOT NULL,
            updated_at DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (city, source)
        )
    """)

    db.commit()


def read_source_cache(city, source):

    db = None

    try:

        db = get_connection()

        row = db.execute("""
            SELECT data_json, updated_at
            FROM station_cache
            WHERE city = ?
              AND source = ?
        """, (
            city,
            source
        )).fetchone()

        if row is None:
            return None

        return {
            "records": json.loads(row["data_json"]),
            "time": float(row["updated_at"])
        }

    except Exception:

        current_app.logger.warning(
            "Unable to read station cache"
        )

        return None

    finally:

        if db is not None:
            db.close()


def save_source_cache(city, source, records):

    db = None

    try:

        db = get_connection()

        db.execute("""
            INSERT INTO station_cache (
                city,
                source,
                data_json,
                updated_at
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT (city, source)
            DO UPDATE SET
                data_json = EXCLUDED.data_json,
                updated_at = EXCLUDED.updated_at
        """, (
            city,
            source,
            json.dumps(records),
            time.time()
        ))

        db.commit()

    except Exception:

        if db is not None:
            db.rollback()

        current_app.logger.warning(
            "Unable to save station cache"
        )

    finally:

        if db is not None:
            db.close()


# ==========================================
# HTTP HELPER
# ==========================================

def fetch_json(url, headers=None, timeout=10):

    request_headers = {
        "User-Agent": "EVChargeNexus/1.0",
        "Accept": "application/json",
    }

    if headers:
        request_headers.update(headers)

    req = urllib.request.Request(
        url,
        headers=request_headers
    )

    with urllib.request.urlopen(
        req,
        timeout=timeout
    ) as response:

        return json.load(response)


# ==========================================
# GENERAL HELPERS
# ==========================================

def normalize_text(value):

    return re.sub(
        r"[^a-z0-9]+",
        " ",
        str(value or "").lower()
    ).strip()


def distance_km(lat1, lon1, lat2, lon2):

    radius = 6371.0

    p1 = math.radians(float(lat1))
    p2 = math.radians(float(lat2))

    dp = math.radians(
        float(lat2) - float(lat1)
    )

    dl = math.radians(
        float(lon2) - float(lon1)
    )

    a = (
        math.sin(dp / 2) ** 2
        + math.cos(p1)
        * math.cos(p2)
        * math.sin(dl / 2) ** 2
    )

    return (
        2 * radius
        * math.asin(min(1, math.sqrt(a)))
    )


def normalize_connector(name):

    value = str(name or "").lower()

    if "ccs" in value or "combo" in value:
        return "CCS2"

    if "chademo" in value:
        return "CHAdeMO"

    if (
        "type 2" in value
        or "type2" in value
        or "mennekes" in value
    ):
        return "Type 2"

    if (
        "type 1" in value
        or "type1" in value
        or "j1772" in value
    ):
        return "Type 1"

    if (
        "gb/t" in value
        or "gbt" in value
        or "gb ac" in value
        or "gb dc" in value
    ):
        return "GB/T"

    if "tesla" in value or "nacs" in value:
        return "NACS"

    return str(name or "Unknown")


def parse_power_kw(value):

    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):

        number = float(value)

        if math.isfinite(number) and 0 < number < 10000:
            return round(number, 2)

        return None

    match = re.search(
        r"(\d+(?:[.,]\d+)?)\s*(kw|mw|w)?\b",
        str(value).lower()
    )

    if not match:
        return None

    number = float(
        match.group(1).replace(",", ".")
    )

    unit = match.group(2) or "kw"

    if unit == "mw":
        number *= 1000

    elif unit == "w":
        number /= 1000

    if 0 < number < 10000:
        return round(number, 2)

    return None


def max_power(values):

    powers = [
        parse_power_kw(value)
        for value in values
    ]

    return max(
        (
            value
            for value in powers
            if value is not None
        ),
        default=None
    )


def parse_price(value):

    if not value:
        return None

    text = str(value).lower()

    if re.search(
        r"\bfree\b|no charge|complimentary",
        text
    ):
        return 0.0

    patterns = [
        r"(?:rs\.?|pkr)\s*(\d+(?:\.\d+)?)"
        r"\s*(?:/|per)\s*(?:kwh|kw\s*h|unit)",

        r"(\d+(?:\.\d+)?)\s*(?:rs\.?|pkr)"
        r"\s*(?:/|per)\s*(?:kwh|unit)",

        r"(\d+(?:\.\d+)?)\s*(?:/|per)"
        r"\s*(?:kwh|unit)",
    ]

    for pattern in patterns:

        match = re.search(pattern, text)

        if match:

            price = float(match.group(1))

            if 0 <= price <= 1000:
                return round(price, 2)

    return None


def base_station():

    return {
        "price_per_kwh": None,
        "price_currency": "PKR",
        "price_type": "unknown",
        "price_source": None,
        "price_source_url": None,
        "price_last_checked": None,
        "power_source": None,
        "available": None,
        "availability_type": "unverified",
    }


# ==========================================
# OPENSTREETMAP
# ==========================================

def get_osm_stations(lat, lon, city):

    radius_meters = SEARCH_RADIUS_KM * 1000

    query = f"""
    [out:json][timeout:8];
    nwr(around:{radius_meters},{lat},{lon})
    ["amenity"="charging_station"];
    out center;
    """

    servers = [
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass-api.de/api/interpreter",
    ]

    data = None

    for server in servers:

        try:

            url = (
                server
                + "?"
                + urllib.parse.urlencode({
                    "data": query
                })
            )

            candidate = fetch_json(
                url,
                timeout=10
            )

            if not isinstance(
                candidate.get("elements"),
                list
            ):
                raise ValueError(
                    "Invalid Overpass response"
                )

            data = candidate
            break

        except Exception:

            print(
                "Overpass server failed",
                flush=True
            )

    if data is None:

        raise RuntimeError(
            "All Overpass servers failed"
        )

    stations = []

    connector_tags = [
        ("socket:type2", "Type 2"),
        ("socket:type2_combo", "CCS2"),
        ("socket:chademo", "CHAdeMO"),
        ("socket:type1", "Type 1"),
        ("socket:gb_ac", "GB/T"),
        ("socket:gb_dc", "GB/T"),
        ("socket:tesla_supercharger", "NACS"),
    ]

    for item in data.get("elements", []):

        tags = item.get("tags") or {}

        center = item.get("center") or item

        station_lat = center.get("lat")
        station_lon = center.get("lon")

        if station_lat is None or station_lon is None:
            continue

        connectors = []

        for key, label in connector_tags:

            value = str(
                tags.get(key, "")
            ).lower()

            if value and value not in ("no", "0"):
                connectors.append(label)

        power_values = [
            tags.get("maxpower"),
            tags.get("charging_station:output"),
        ]

        power_values.extend(
            value
            for key, value in tags.items()
            if (
                key.startswith("socket:")
                and key.endswith(":output")
            )
        )

        power = max_power(power_values)

        raw_price = (
            tags.get("charge")
            or tags.get("fee:amount")
            or tags.get("payment:price")
        )

        price = parse_price(raw_price)

        address = ", ".join(
            str(value)
            for value in [
                tags.get("addr:street"),
                tags.get("addr:suburb"),
                tags.get("addr:city"),
            ]
            if value
        )

        station = base_station()

        station.update({
            "id": (
                f"osm-{item.get('type')}-"
                f"{item.get('id')}"
            ),

            "name": (
                tags.get("name")
                or tags.get("operator")
                or "EV Charging Station"
            ),

            "address": address or city,
            "city": city,
            "lat": float(station_lat),
            "lng": float(station_lon),

            "connectors": list(
                dict.fromkeys(connectors)
            ),

            "operator": tags.get("operator", ""),
            "capacity": tags.get("capacity"),

            "opening_hours": tags.get(
                "opening_hours", ""
            ),

            "power_kw": power,

            "power_source": (
                "OpenStreetMap"
                if power is not None
                else None
            ),

            "phone": (
                tags.get("contact:phone")
                or tags.get("phone")
                or ""
            ),

            "website": (
                tags.get("contact:website")
                or tags.get("website")
                or ""
            ),

            "source": "OpenStreetMap",
            "price_per_kwh": price,

            "price_type": (
                "community_recorded"
                if price is not None
                else "unknown"
            ),

            "price_source": (
                "OpenStreetMap"
                if price is not None
                else None
            ),
        })

        stations.append(station)

    return stations


# ==========================================
# OPENCHARGEMAP
# ==========================================

def get_ocm_stations(lat, lon, city):

    api_key = os.environ.get(
        "OPENCHARGEMAP_API_KEY",
        ""
    ).strip()

    if not api_key:

        raise RuntimeError(
            "OPENCHARGEMAP_API_KEY is missing"
        )

    params = urllib.parse.urlencode({
        "output": "json",
        "countrycode": "PK",
        "latitude": lat,
        "longitude": lon,
        "distance": SEARCH_RADIUS_KM,
        "distanceunit": "KM",
        "maxresults": 100,
    })

    url = (
        "https://api.openchargemap.io/v3/poi/?"
        + params
    )

    data = fetch_json(
        url,
        headers={
            "X-API-Key": api_key
        },
        timeout=12
    )

    if not isinstance(data, list):

        raise ValueError(
            "Unexpected OpenChargeMap response"
        )

    stations = []

    for item in data:

        address_info = (
            item.get("AddressInfo") or {}
        )

        station_lat = address_info.get("Latitude")
        station_lon = address_info.get("Longitude")

        if station_lat is None or station_lon is None:
            continue

        connections = (
            item.get("Connections") or []
        )

        connectors = []
        powers = []

        for connection in connections:

            if not isinstance(connection, dict):
                continue

            connection_type = (
                connection.get("ConnectionType") or {}
            )

            connector = normalize_connector(
                connection_type.get("Title")
                or connection_type.get("FormalName")
            )

            if (
                connector != "Unknown"
                and connector not in connectors
            ):
                connectors.append(connector)

            powers.append(
                connection.get("PowerKW")
            )

        power = max_power(powers)

        operator = (
            item.get("OperatorInfo") or {}
        )

        address = ", ".join(
            str(value)
            for value in [
                address_info.get("AddressLine1"),
                address_info.get("Town"),
                address_info.get("StateOrProvince"),
            ]
            if value
        )

        price = parse_price(
            item.get("UsageCost")
        )

        station = base_station()

        station.update({
            "id": f"ocm-{item.get('ID')}",

            "name": (
                address_info.get("Title")
                or "EV Charging Station"
            ),

            "address": address or city,
            "city": city,
            "lat": float(station_lat),
            "lng": float(station_lon),
            "connectors": connectors,
            "operator": operator.get("Title", ""),
            "capacity": item.get("NumberOfPoints"),

            "opening_hours": (
                "24/7"
                if item.get("IsOpen24Hours") is True
                else ""
            ),

            "power_kw": power,

            "power_source": (
                "OpenChargeMap"
                if power is not None
                else None
            ),

            "phone": (
                address_info.get("ContactTelephone1")
                or ""
            ),

            "website": (
                operator.get("WebsiteURL")
                or address_info.get("RelatedURL")
                or ""
            ),

            "source": "OpenChargeMap",
            "price_per_kwh": price,

            "price_type": (
                "community_recorded"
                if price is not None
                else "unknown"
            ),

            "price_source": (
                "OpenChargeMap"
                if price is not None
                else None
            ),

            "price_source_url": (
                "https://openchargemap.org/site/poi/details/"
                + str(item.get("ID"))
                if item.get("ID") is not None
                else None
            ),
        })

        stations.append(station)

    return stations


# ==========================================
# MERGE STATIONS
# ==========================================

def merge_stations(osm_stations, ocm_stations):

    merged = [
        dict(station)
        for station in osm_stations
    ]

    for station in ocm_stations:

        duplicate = None

        for existing in merged:

            distance = distance_km(
                station["lat"],
                station["lng"],
                existing["lat"],
                existing["lng"]
            )

            if distance < 0.08:

                duplicate = existing
                break

        if duplicate is None:

            merged.append(dict(station))
            continue

        duplicate["connectors"] = list(
            dict.fromkeys(
                duplicate.get("connectors", [])
                + station.get("connectors", [])
            )
        )

        for field in (
            "operator",
            "capacity",
            "opening_hours",
            "phone",
            "website",
        ):

            if (
                not duplicate.get(field)
                and station.get(field)
            ):

                duplicate[field] = station[field]

        incoming_power = station.get("power_kw")

        existing_power = duplicate.get("power_kw")

        if (
            incoming_power is not None
            and (
                existing_power is None
                or incoming_power > existing_power
            )
        ):

            duplicate["power_kw"] = incoming_power

            duplicate["power_source"] = (
                station.get("power_source")
            )

        if (
            duplicate.get("price_per_kwh") is None
            and station.get("price_per_kwh") is not None
        ):

            for field in (
                "price_per_kwh",
                "price_type",
                "price_source",
                "price_source_url",
            ):

                duplicate[field] = station.get(field)

        if duplicate["source"] != station["source"]:

            duplicate["source"] = (
                "OpenStreetMap + OpenChargeMap"
            )

    return merged


# ==========================================
# ENRICH KARACHI STATIONS
# ==========================================

def enrich_station(station, city):

    if city != "Karachi":
        return station

    name = normalize_text(
        station.get("name")
    )

    address = normalize_text(
        station.get("address")
    )

    combined = f"{name} {address}"

    for entry in KARACHI_DIRECTORY:

        matched = any(
            normalize_text(alias) in combined
            for alias in entry["aliases"]
        )

        if not matched:
            continue

        name_match = any(
            normalize_text(alias) in name
            for alias in entry["aliases"]
        )

        if not name_match:
            continue

        station["power_kw"] = entry["power_kw"]

        station["power_source"] = (
            "PakNEV published station listing"
        )

        station["price_per_kwh"] = (
            entry["price_per_kwh"]
        )

        station["price_currency"] = "PKR"

        station["price_type"] = "published_directory"

        station["price_source"] = "PakNEV"

        station["price_source_url"] = (
            entry["source_url"]
        )

        station["price_last_checked"] = (
            "2026-11-08"
        )

        station["connectors"] = list(
            dict.fromkeys(
                station.get("connectors", [])
                + entry["connectors"]
            )
        )

        station["directory_notice"] = (
            "Published directory tariff. "
            "Confirm with the operator before charging."
        )

        break

    return station


# ==========================================
# SAVED VEHICLES API
# ==========================================

@free_map_bp.route("/api/my-vehicles")
def my_vehicles():

    user_id = session.get("user_id")

    if not user_id:

        return jsonify({
            "error": "Login required",
            "vehicles": [],
        }), 401

    db = None

    try:

        db = get_connection()

        rows = db.execute("""
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
            user_id,
        )).fetchall()

        return jsonify({
            "vehicles": [
                dict(row)
                for row in rows
            ]
        })

    except psycopg2.Error:

        current_app.logger.exception(
            "Unable to load saved vehicles"
        )

        return jsonify({
            "error": "Unable to load vehicles",
            "vehicles": [],
        }), 500

    finally:

        if db is not None:
            db.close()


# ==========================================
# CHARGING STATIONS API
# ==========================================

@free_map_bp.route("/api/charging-stations")
def charging_stations():

    requested_city = request.args.get(
        "city",
        "Karachi"
    ).strip()

    city = next(
        (
            name
            for name in CITIES
            if name.lower() == requested_city.lower()
        ),
        "Karachi"
    )

    refresh = (
        request.args.get("refresh", "0") == "1"
    )

    now = time.time()

    # First check local memory cache.

    if not refresh and city in CACHE:

        entry = CACHE[city]

        max_age = (
            PARTIAL_CACHE_SECONDS
            if entry["data"]["failed_sources"]
            else CACHE_SECONDS
        )

        if now - entry["time"] < max_age:

            result = dict(entry["data"])

            result["cached"] = True

            return jsonify(result)

    lat, lon = CITIES[city]

    errors = []
    stale_sources = []
    source_stations = {}
    cached_sources = []
    previous_records = {}

    sources = (
        ("OpenStreetMap", get_osm_stations),
        ("OpenChargeMap", get_ocm_stations),
    )

    pending_sources = []

    # Check persistent Neon cache.

    for source, fetcher in sources:

        previous = SOURCE_CACHE.get(
            (city, source)
        )

        if (
            previous is None
            or now - previous["time"] >= CACHE_SECONDS
        ):

            persistent = read_source_cache(
                city,
                source
            )

            if persistent is not None:

                if (
                    previous is None
                    or persistent["time"] > previous["time"]
                ):

                    previous = persistent

        previous_records[source] = previous

        if (
            not refresh
            and previous is not None
            and now - previous["time"] < CACHE_SECONDS
        ):

            source_stations[source] = (
                previous["records"]
            )

            cached_sources.append(source)

        else:

            pending_sources.append(
                (source, fetcher)
            )

    # Fetch both external APIs concurrently.

    if pending_sources:

        with ThreadPoolExecutor(
            max_workers=2
        ) as executor:

            futures = {
                source: executor.submit(
                    fetcher,
                    lat,
                    lon,
                    city
                )
                for source, fetcher in pending_sources
            }

            for source, future in futures.items():

                try:

                    records = future.result()

                    source_stations[source] = records

                    SOURCE_CACHE[(city, source)] = {
                        "records": records,
                        "time": time.time()
                    }

                    save_source_cache(
                        city,
                        source,
                        records
                    )

                except Exception:

                    current_app.logger.warning(
                        "%s charging station API failed",
                        source
                    )

                    errors.append(source)

                    previous = previous_records.get(
                        source
                    )

                    if (
                        previous is not None
                        and now - previous["time"]
                        <= STALE_CACHE_SECONDS
                    ):

                        source_stations[source] = (
                            previous["records"]
                        )

                        stale_sources.append(source)

                    else:

                        source_stations[source] = []

    osm_stations = source_stations.get(
        "OpenStreetMap",
        []
    )

    ocm_stations = source_stations.get(
        "OpenChargeMap",
        []
    )

    stations = merge_stations(
        osm_stations,
        ocm_stations
    )

    stations = [
        enrich_station(station, city)
        for station in stations
    ]

    result = {
        "stations": stations,
        "city": city,
        "count": len(stations),
        "search_radius_km": SEARCH_RADIUS_KM,

        "source": (
            "OpenStreetMap + OpenChargeMap"
        ),

        "cached": len(cached_sources) == 2,

        "source_counts": {
            "OpenStreetMap": len(osm_stations),
            "OpenChargeMap": len(ocm_stations),
        },

        "failed_sources": errors,
        "stale_sources": stale_sources,

        "pricing_notice": (
            "Published tariffs are advisory. "
            "Prices can change without notice."
        ),
    }

    if len(errors) == 2 and not stations:

        result["error"] = (
            "Both charging station services failed."
        )

        return jsonify(result), 503

    if stations:

        CACHE[city] = {
            "time": time.time(),
            "data": result,
        }

    return jsonify(result)