
/*
=====================================================
EVCHARGE NEXUS
MODULE 4 - SMART CHARGING RECOMMENDATIONS
=====================================================

Features:
1. Best Overall
2. Lowest Charging Cost
3. Fastest Charging
4. Nearest Charging Station
5. Automatic priority updates
6. Saved electric vehicles
7. Location-based distance
8. Charging cost and time estimates
9. Show on Map
10. Responsive dashboard

=====================================================
*/

(() => {
    "use strict";

    document.addEventListener("DOMContentLoaded", init);

    function init() {

        if (document.getElementById("nexus-planner")) {
            return;
        }

        const citySelect = document.getElementById("city");
        const mapShell = document.querySelector(".map-shell");

        if (!citySelect || !mapShell) {
            console.warn("EVCharge station page not found.");
            return;
        }

        const $ = id => document.getElementById(id);

        const state = {
            vehicles: [],
            stations: [],
            location: null,
            loading: false,
            pending: false,
            results: [],
            request: 0,
            hasResults: false
        };

        // ==========================================
        // HELPERS
        // ==========================================

        function make(tag, content, className) {
            const el = document.createElement(tag);

            if (content !== undefined && content !== null) {
                el.textContent = String(content);
            }

            if (className) {
                el.className = className;
            }

            return el;
        }

        function num(value) {
            if (
                value === null ||
                value === undefined ||
                String(value).trim() === ""
            ) {
                return null;
            }

            const n = Number(value);

            return Number.isFinite(n) ? n : null;
        }

        function positive(value) {
            const n = num(value);
            return n !== null && n > 0 ? n : null;
        }

        function normalize(value) {
            return String(value || "")
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
        }

        function money(value) {
            return "Rs. " +
                Math.round(value).toLocaleString("en-PK");
        }

        function validCoordinates(station) {
            const lat = num(station.lat);
            const lng = num(station.lng);

            return lat !== null &&
                lng !== null &&
                Math.abs(lat) <= 90 &&
                Math.abs(lng) <= 180;
        }

        function distanceKm(lat1, lng1, lat2, lng2) {
            const rad = x => x * Math.PI / 180;

            const dLat = rad(lat2 - lat1);
            const dLng = rad(lng2 - lng1);

            const a =
                Math.sin(dLat / 2) ** 2 +
                Math.cos(rad(lat1)) *
                Math.cos(rad(lat2)) *
                Math.sin(dLng / 2) ** 2;

            return 6371 * 2 * Math.asin(
                Math.min(1, Math.sqrt(a))
            );
        }

        function connectors(station) {
            if (Array.isArray(station.connectors)) {
                return station.connectors.filter(Boolean);
            }

            if (typeof station.connectors === "string") {
                return station.connectors
                    .split(/[,;|]/)
                    .map(x => x.trim())
                    .filter(Boolean);
            }

            return [];
        }

        function selectedVehicle() {
            const id = $("nrx-vehicle").value;

            return state.vehicles.find(
                v => String(v.id) === id
            ) || null;
        }

        function setStatus(message, type = "normal") {
            const el = $("nrx-status");

            el.textContent = message;
            el.dataset.type = type;
        }

        function priorityLabel() {
            const labels = {
                overall: "Best Overall",
                cheapest: "Lowest Charging Cost",
                fastest: "Fastest Charging",
                nearest: "Nearest Charging Station"
            };

            return labels[$("nrx-priority").value] ||
                "Best Overall";
        }

        // ==========================================
        // DASHBOARD CSS
        // ==========================================

        const style = document.createElement("style");

        style.textContent = `
            #nexus-planner {
                --green: #21d497;
                --dark: #0b1d2a;
                --panel: #132d3b;
                --border: #2b4b59;
                --muted: #a9c0cb;

                width: 100%;
                box-sizing: border-box;
                margin: 28px 0;
                padding: clamp(20px, 3vw, 36px);
                border-radius: 22px;
                border: 1px solid #31505e;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(33,212,151,.12),
                        transparent 38%
                    ),
                    var(--dark);
                color: #f5fafc;
                font-family: inherit;
            }

            #nexus-planner * {
                box-sizing: border-box;
            }

            .nrx-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 20px;
                margin-bottom: 28px;
            }

            .nrx-eyebrow {
                font-size: 11px;
                font-weight: 800;
                letter-spacing: 1.8px;
                color: var(--green);
                margin-bottom: 10px;
            }

            .nrx-header h2 {
                margin: 0 0 12px;
                color: white;
                font-size: clamp(26px,3vw,36px);
                line-height: 1.2;
            }

            .nrx-header p {
                margin: 0;
                max-width: 620px;
                color: var(--muted);
                font-size: 14px;
                line-height: 1.7;
            }

            .nrx-icon {
                width: 62px;
                height: 62px;
                flex-shrink: 0;
                display: grid;
                place-items: center;
                border-radius: 18px;
                border: 1px solid #397e6d;
                background: #164b41;
                font-size: 30px;
            }

            .nrx-panel {
                padding: 24px;
                border: 1px solid var(--border);
                border-radius: 17px;
                background: var(--panel);
            }

            .nrx-panel-heading {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 22px;
            }

            .nrx-panel-heading strong {
                color: white;
                font-size: 16px;
            }

            .nrx-panel-heading span {
                color: var(--muted);
                font-size: 12px;
            }

            .nrx-controls {
                display: grid;
                grid-template-columns:
                    1.5fr 1.2fr .8fr .8fr;
                gap: 16px;
            }

            .nrx-field label {
                display: block;
                margin-bottom: 9px;
                color: #bed2dc;
                font-size: 11px;
                font-weight: 800;
            }

            .nrx-field select,
            .nrx-field input {
                width: 100%;
                min-width: 0;
                height: 48px;
                padding: 0 13px;
                border-radius: 10px;
                border: 1px solid #3b5b69;
                background: #0c2431;
                color: white;
                font-size: 13px;
                font-family: inherit;
                outline: none;
            }

            .nrx-field select option {
                background: #0c2431;
                color: white;
            }

            .nrx-field select:focus,
            .nrx-field input:focus {
                border-color: var(--green);
                box-shadow: 0 0 0 3px #21d49720;
            }

            .nrx-actions {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 22px;
            }

            .nrx-button {
                min-height: 46px;
                padding: 12px 20px;
                border-radius: 10px;
                font-family: inherit;
                font-size: 12px;
                font-weight: 800;
                cursor: pointer;
                transition: .2s ease;
            }

            .nrx-button:hover:not(:disabled) {
                transform: translateY(-2px);
            }

            .nrx-button:disabled {
                opacity: .6;
                cursor: wait;
            }

            .nrx-primary {
                background: var(--green);
                border: 1px solid var(--green);
                color: #063026;
            }

            .nrx-secondary {
                background: #1b3c4a;
                border: 1px solid #426774;
                color: white;
            }

            .nrx-location-label {
                margin-left: auto;
                color: var(--muted);
                font-size: 12px;
            }

            .nrx-status {
                min-height: 20px;
                margin-top: 17px;
                color: var(--muted);
                font-size: 12px;
                line-height: 1.6;
            }

            .nrx-status[data-type="success"] {
                color: #7ce7b7;
            }

            .nrx-status[data-type="error"] {
                color: #ffb4b4;
            }

            .nrx-results-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 15px;
                margin: 30px 0 19px;
            }

            .nrx-results-header h3 {
                margin: 0 0 6px;
                color: white;
                font-size: 22px;
            }

            .nrx-results-header p {
                margin: 0;
                color: var(--muted);
                font-size: 12px;
            }

            .nrx-count {
                flex-shrink: 0;
                padding: 9px 14px;
                border-radius: 30px;
                background: #16483e;
                color: #6cf0b5;
                font-size: 11px;
                font-weight: 800;
            }

            .nrx-results {
                display: grid;
                grid-template-columns:
                    repeat(3,minmax(0,1fr));
                gap: 18px;
            }

            .nrx-card {
                display: flex;
                flex-direction: column;
                min-width: 0;
                padding: 22px;
                border: 1px solid var(--border);
                border-radius: 17px;
                background: var(--panel);
                transition: .2s ease;
            }

            .nrx-card:hover {
                transform: translateY(-3px);
                border-color: #4d807d;
            }

            .nrx-card:first-child {
                border-color: var(--green);
                background:
                    linear-gradient(
                        145deg,
                        #16483e,
                        #132d3b 55%
                    );
            }

            .nrx-card-top {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 18px;
            }

            .nrx-rank {
                color: #a9c4d0;
                font-size: 10px;
                font-weight: 800;
                letter-spacing: .7px;
            }

            .nrx-card:first-child .nrx-rank {
                color: #6ff0b8;
            }

            .nrx-number {
                color: #527483;
                font-size: 27px;
                font-weight: 800;
            }

            .nrx-card:first-child .nrx-number {
                color: #55e5a7;
            }

            .nrx-card h4 {
                margin: 0 0 9px;
                color: white;
                font-size: 19px;
                line-height: 1.35;
                overflow-wrap: anywhere;
            }

            .nrx-address {
                min-height: 42px;
                margin: 0;
                color: var(--muted);
                font-size: 12px;
                line-height: 1.65;
                overflow-wrap: anywhere;
            }

            .nrx-stats {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin: 22px 0;
            }

            .nrx-stat {
                min-width: 0;
                padding: 13px;
                border-radius: 10px;
                border: 1px solid #2c4d5b;
                background: #0c2634;
            }

            .nrx-stat-label {
                display: block;
                margin-bottom: 8px;
                color: #a1bac5;
                font-size: 10px;
                font-weight: 700;
            }

            .nrx-stat-value {
                display: block;
                color: white;
                font-size: 15px;
                font-weight: 800;
                overflow-wrap: anywhere;
            }

            .nrx-stat-value[data-accent="true"] {
                color: #5ee8ac;
            }

            .nrx-reason {
                padding: 13px;
                margin-bottom: 14px;
                border: 1px solid #2b6956;
                border-radius: 10px;
                background: #144638;
                color: #a5f3ce;
                font-size: 12px;
                line-height: 1.6;
            }

            .nrx-notes {
                margin-bottom: 20px;
                color: var(--muted);
                font-size: 11px;
                line-height: 1.65;
            }

            .nrx-card-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin-top: auto;
            }

            .nrx-card-actions a,
            .nrx-card-actions button {
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 43px;
                padding: 10px;
                border-radius: 9px;
                border: 1px solid #426775;
                background: #214453;
                color: white;
                font-family: inherit;
                font-size: 12px;
                font-weight: 800;
                text-decoration: none;
                text-align: center;
                cursor: pointer;
            }

            .nrx-card-actions a {
                background: var(--green);
                border-color: var(--green);
                color: #063026;
            }

            .nrx-empty {
                grid-column: 1/-1;
                padding: 40px 20px;
                border: 1px dashed #426775;
                border-radius: 15px;
                background: #132d3b;
                color: #bed2dc;
                text-align: center;
                font-size: 14px;
            }

            .nrx-disclaimer {
                padding-top: 18px;
                margin-top: 26px;
                border-top: 1px solid #294956;
                color: #a1b9c4;
                font-size: 11px;
                line-height: 1.8;
            }

            @media(max-width:1100px) {
                .nrx-controls {
                    grid-template-columns:
                        repeat(2,minmax(0,1fr));
                }

                .nrx-results {
                    grid-template-columns:
                        repeat(2,minmax(0,1fr));
                }
            }

            @media(max-width:760px) {
                .nrx-results {
                    grid-template-columns: 1fr;
                }

                .nrx-location-label {
                    margin-left: 0;
                }
            }

            @media(max-width:540px) {
                #nexus-planner {
                    padding: 18px;
                    border-radius: 17px;
                }

                .nrx-header h2 {
                    font-size: 26px;
                }

                .nrx-icon {
                    display: none;
                }

                .nrx-panel {
                    padding: 16px;
                }

                .nrx-controls {
                    grid-template-columns: 1fr;
                }

                .nrx-panel-heading span {
                    display: none;
                }

                .nrx-actions {
                    flex-direction: column;
                    align-items: stretch;
                }

                .nrx-button {
                    width: 100%;
                }

                .nrx-location-label {
                    text-align: center;
                }

                .nrx-card {
                    padding: 18px;
                }

                .nrx-results-header h3 {
                    font-size: 19px;
                }
            }
        `;

        document.head.appendChild(style);

        // ==========================================
        // BUILD DASHBOARD
        // ==========================================

        const section = document.createElement("section");

        section.id = "nexus-planner";

        section.innerHTML = `
            <div class="nrx-header">
                <div>
                    <div class="nrx-eyebrow">
                        EVCHARGE NEXUS / SMART PLANNER
                    </div>

                    <h2>
                        Find your ideal charging stop.
                    </h2>

                    <p>
                        Discover charging stations tailored
                        to your electric vehicle, battery
                        needs and personal preferences.
                    </p>
                </div>

                <div class="nrx-icon"
                     aria-hidden="true">
                    ⚡
                </div>
            </div>

            <div class="nrx-panel">

                <div class="nrx-panel-heading">
                    <strong>
                        Configure your charging plan
                    </strong>

                    <span>
                        Personalized station discovery
                    </span>
                </div>

                <div class="nrx-controls">

                    <div class="nrx-field">
                        <label for="nrx-vehicle">
                            YOUR ELECTRIC VEHICLE
                        </label>

                        <select id="nrx-vehicle">
                            <option value="">
                                Loading vehicles...
                            </option>
                        </select>
                    </div>

                    <div class="nrx-field">
                        <label for="nrx-priority">
                            OPTIMIZATION PRIORITY
                        </label>

                        <select id="nrx-priority">
                            <option value="overall">
                                Best Overall
                            </option>

                            <option value="cheapest">
                                Lowest Charging Cost
                            </option>

                            <option value="fastest">
                                Fastest Charging
                            </option>

                            <option value="nearest">
                                Nearest Charging Station
                            </option>
                        </select>
                    </div>

                    <div class="nrx-field">
                        <label for="nrx-current">
                            CURRENT BATTERY %
                        </label>

                        <input
                            id="nrx-current"
                            type="number"
                            min="0"
                            max="99"
                            value="20"
                        >
                    </div>

                    <div class="nrx-field">
                        <label for="nrx-target">
                            TARGET BATTERY %
                        </label>

                        <input
                            id="nrx-target"
                            type="number"
                            min="1"
                            max="100"
                            value="80"
                        >
                    </div>

                </div>

                <div class="nrx-actions">
                    <button
                        id="nrx-find"
                        type="button"
                        class="nrx-button nrx-primary"
                    >
                        ✦ Find Best Charging Stations
                    </button>

                    <button
                        id="nrx-location"
                        type="button"
                        class="nrx-button nrx-secondary"
                    >
                        ⌖ Use My Location
                    </button>

                    <span
                        id="nrx-location-status"
                        class="nrx-location-label"
                    >
                        Location not selected
                    </span>
                </div>

                <div
                    id="nrx-status"
                    class="nrx-status"
                    aria-live="polite"
                >
                    Select your preferences to get
                    personalized recommendations.
                </div>
            </div>

            <div class="nrx-results-header">
                <div>
                    <h3>Recommended for you</h3>

                    <p id="nrx-ranking-description">
                        Balanced recommendations using
                        available station information.
                    </p>
                </div>

                <span id="nrx-count"
                      class="nrx-count">
                    READY
                </span>
            </div>

            <div
                id="nrx-results"
                class="nrx-results"
                aria-live="polite"
            >
                <div class="nrx-empty">
                    Select your charging preferences
                    and click Find Best Charging Stations.
                </div>
            </div>

            <div class="nrx-disclaimer">
                Station specifications and prices are
                based on available records and may change.
                Distances are straight-line estimates,
                not road distances. Charging times are
                simplified estimates. Actual charging
                may take longer. Live charger availability
                is not verified.
            </div>
        `;

        mapShell.parentNode.insertBefore(
            section,
            mapShell
        );

        // ==========================================
        // SAVED VEHICLES
        // ==========================================

        async function loadVehicles() {
            const select = $("nrx-vehicle");

            select.replaceChildren();

            const generic = make(
                "option",
                "Generic EV (60 kWh assumption)"
            );

            generic.value = "";
            select.appendChild(generic);

            try {
                const response = await fetch(
                    "/api/my-vehicles"
                );

                if (!response.ok) {
                    throw new Error(
                        "Unable to load saved vehicles."
                    );
                }

                const data = await response.json();

                state.vehicles = Array.isArray(data.vehicles)
                    ? data.vehicles
                    : [];

                state.vehicles.forEach(vehicle => {
                    const label = [
                        vehicle.manufacturer,
                        vehicle.model,
                        vehicle.connector
                            ? `(${vehicle.connector})`
                            : ""
                    ].filter(Boolean).join(" ");

                    const option = make("option", label);
                    option.value = String(vehicle.id);

                    select.appendChild(option);
                });

                if (state.vehicles.length) {
                    select.value = String(
                        state.vehicles[0].id
                    );

                    applyVehicleDefaults();
                }

            } catch (error) {
                console.warn(error);

                setStatus(
                    "Saved vehicles unavailable. " +
                    "Generic estimates remain available."
                );
            }
        }

        function applyVehicleDefaults() {
            const vehicle = selectedVehicle();

            if (!vehicle) return;

            const current = num(vehicle.current_soc);
            const target = num(vehicle.target_soc);

            if (
                current !== null &&
                current >= 0 &&
                current < 100
            ) {
                $("nrx-current").value = current;
            }

            if (
                target !== null &&
                target > 0 &&
                target <= 100
            ) {
                $("nrx-target").value = target;
            }
        }

        // ==========================================
        // CONNECTOR COMPATIBILITY
        // ==========================================

        function compatibility(station, vehicle) {
            if (!vehicle || !vehicle.connector) {
                return "unknown";
            }

            const types = connectors(station);

            if (!types.length) {
                return "unknown";
            }

            const required = normalize(vehicle.connector);

            const match = types.some(type => {
                const actual = normalize(type);

                if (required === "ccs") {
                    return actual.includes("ccs");
                }

                if (
                    required === "gb" ||
                    required === "gbt"
                ) {
                    return actual.includes("gb");
                }

                return actual === required ||
                    actual.includes(required);
            });

            return match ? "match" : "mismatch";
        }

        // ==========================================
        // USER LOCATION
        // ==========================================

        async function useLocation() {
            const button = $("nrx-location");

            button.disabled = true;
            setStatus("Requesting your location...");

            try {
                if (!navigator.geolocation) {
                    throw new Error(
                        "Geolocation not supported."
                    );
                }

                const position = await new Promise(
                    (resolve, reject) => {
                        navigator.geolocation.getCurrentPosition(
                            resolve,
                            reject,
                            {
                                enableHighAccuracy: true,
                                timeout: 12000
                            }
                        );
                    }
                );

                state.location = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };

                $("nrx-location-status").textContent =
                    "✓ Location enabled";

                setStatus(
                    "Location enabled. Distances are ready.",
                    "success"
                );

                if (state.hasResults) {
                    requestRefresh();
                }

            } catch (error) {
                setStatus(
                    "Unable to access location. " +
                    "Check browser permissions.",
                    "error"
                );

            } finally {
                button.disabled = false;
            }
        }

        // ==========================================
        // BATTERY REQUIREMENTS
        // ==========================================

        function requirements() {
            const vehicle = selectedVehicle();

            const recordedBattery = positive(
                vehicle?.battery_kwh
            );

            const battery = recordedBattery || 60;

            const current = num(
                $("nrx-current").value
            );

            const target = num(
                $("nrx-target").value
            );

            if (
                current === null ||
                target === null ||
                current < 0 ||
                current >= 100 ||
                target > 100 ||
                target <= current
            ) {
                throw new Error(
                    "Enter valid battery percentages. " +
                    "Target must be higher than current."
                );
            }

            const batteryEnergy =
                battery * (target - current) / 100;

            const gridEnergy = batteryEnergy / 0.9;

            const vehicleMaxPower =
                positive(vehicle?.max_dc_kw) ||
                positive(vehicle?.max_charging_kw) ||
                positive(vehicle?.max_charge_power_kw) ||
                null;

            return {
                battery,
                current,
                target,
                batteryEnergy,
                gridEnergy,
                vehicleMaxPower,
                genericBattery: !recordedBattery
            };
        }

        // ==========================================
        // CALCULATE STATION METRICS
        // ==========================================

        function stationMetrics(station, needs) {
            const rawPrice = num(
                station.price_per_kwh
            );

            const price =
                rawPrice !== null && rawPrice >= 0
                    ? rawPrice
                    : null;

            const power = positive(
                station.power_kw
            );

            const effectivePower =
                power === null
                    ? null
                    : needs.vehicleMaxPower === null
                        ? power
                        : Math.min(
                            power,
                            needs.vehicleMaxPower
                        );

            const cost =
                price === null
                    ? null
                    : needs.gridEnergy * price;

            const time =
                effectivePower === null
                    ? null
                    : needs.gridEnergy /
                      effectivePower * 60;

            const distance =
                state.location && validCoordinates(station)
                    ? distanceKm(
                        state.location.lat,
                        state.location.lng,
                        Number(station.lat),
                        Number(station.lng)
                    )
                    : null;

            return {
                station,
                price,
                power,
                cost,
                time,
                distance,
                connectorStatus: compatibility(
                    station,
                    selectedVehicle()
                ),
                score: 0,
                metricScores: {}
            };
        }

        // ==========================================
        // NORMALIZE METRICS
        // ==========================================

        function scoreMetric(items, key) {
            const values = items
                .map(item => item[key])
                .filter(value =>
                    value !== null &&
                    Number.isFinite(value)
                );

            if (!values.length) {
                items.forEach(item => {
                    item.metricScores[key] = null;
                });

                return;
            }

            const min = Math.min(...values);
            const max = Math.max(...values);

            items.forEach(item => {
                if (item[key] === null) {
                    item.metricScores[key] = null;
                    return;
                }

                item.metricScores[key] =
                    max === min
                        ? 100
                        : 100 * (
                            1 -
                            (item[key] - min) /
                            (max - min)
                        );
            });
        }

        // ==========================================
        // FOUR OPTIMIZATION PRIORITIES
        // ==========================================

        function rankStations(needs) {
            const priority = $("nrx-priority").value;

            const weights = {
                overall: {
                    cost: 0.35,
                    time: 0.35,
                    distance: 0.30
                },
                cheapest: {
                    cost: 1,
                    time: 0,
                    distance: 0
                },
                fastest: {
                    cost: 0,
                    time: 1,
                    distance: 0
                },
                nearest: {
                    cost: 0,
                    time: 0,
                    distance: 1
                }
            }[priority];

            const items = state.stations
                .filter(validCoordinates)
                .map(station =>
                    stationMetrics(station, needs)
                )
                .filter(item =>
                    item.connectorStatus !== "mismatch"
                );

            ["cost", "time", "distance"].forEach(
                key => scoreMetric(items, key)
            );

            items.forEach(item => {
                let total = 0;

                for (const key of [
                    "cost",
                    "time",
                    "distance"
                ]) {
                    if (!weights[key]) continue;

                    const metric =
                        item.metricScores[key];

                    if (metric !== null) {
                        total += metric * weights[key];
                    }
                }

                if (
                    selectedVehicle() &&
                    item.connectorStatus === "unknown"
                ) {
                    total *= 0.75;
                }

                item.score = total;
            });

            // Specific metric used for each priority.
            const essential = {
                cheapest: "cost",
                fastest: "time",
                nearest: "distance"
            }[priority];

            items.sort((a, b) => {

                if (essential) {
                    const aKnown =
                        a[essential] !== null;

                    const bKnown =
                        b[essential] !== null;

                    // Known values rank above unknown.
                    if (aKnown !== bKnown) {
                        return aKnown ? -1 : 1;
                    }

                    // Lowest value ranks first.
                    if (aKnown && bKnown) {
                        const difference =
                            a[essential] -
                            b[essential];

                        if (difference !== 0) {
                            return difference;
                        }
                    }
                }

                // Best Overall or tied values.
                const scoreDifference =
                    b.score - a.score;

                if (scoreDifference !== 0) {
                    return scoreDifference;
                }

                return String(a.station.name || "")
                    .localeCompare(
                        String(b.station.name || "")
                    );
            });

            return items.slice(0, 3);
        }

        // ==========================================
        // RECOMMENDATION EXPLANATION
        // ==========================================

        function reason(item, index) {
            const priority = $("nrx-priority").value;

            if (priority === "cheapest") {
                return item.cost !== null
                    ? "Ranked by lowest estimated charging cost."
                    : "Charging tariff is unavailable.";
            }

            if (priority === "fastest") {
                return item.time !== null
                    ? "Ranked by shortest estimated charging time."
                    : "Charging power is unavailable.";
            }

            if (priority === "nearest") {
                return item.distance !== null
                    ? "Ranked by distance from your location."
                    : "Distance could not be calculated.";
            }

            if (index === 0) {
                return (
                    "Best balanced station based on " +
                    "available cost, charging speed " +
                    "and distance information."
                );
            }

            if (
                item.distance !== null &&
                item.distance < 3
            ) {
                return "A nearby charging alternative.";
            }

            if (
                item.power !== null &&
                item.power >= 100
            ) {
                return "An alternative with high recorded charging power.";
            }

            return "Another potentially suitable charging option.";
        }

        // ==========================================
        // SHOW ON MAP
        // ==========================================

        function showOnMap(station) {
            window.dispatchEvent(
                new CustomEvent(
                    "nexus:focus-station",
                    {
                        detail: {
                            id: station.id,
                            name: station.name
                        }
                    }
                )
            );

            const map = $("charging-map");

            if (map) {
                map.scrollIntoView({
                    behavior: "smooth",
                    block: "center"
                });
            }
        }

        // ==========================================
        // CARD STAT
        // ==========================================

        function addStat(grid, label, value, accent) {
            const box = make(
                "div",
                undefined,
                "nrx-stat"
            );

            const heading = make(
                "span",
                label,
                "nrx-stat-label"
            );

            const result = make(
                "strong",
                value,
                "nrx-stat-value"
            );

            if (accent) {
                result.dataset.accent = "true";
            }

            box.append(heading, result);
            grid.appendChild(box);
        }

        // ==========================================
        // RECOMMENDATION CARD
        // ==========================================

        function createCard(item, index, needs) {
            const station = item.station;

            const card = make(
                "article",
                undefined,
                "nrx-card"
            );

            const top = make(
                "div",
                undefined,
                "nrx-card-top"
            );

            const priority = $("nrx-priority").value;

            const badges = {
                overall: "✦ BEST MATCH",
                cheapest: "✦ LOWEST COST",
                fastest: "✦ FASTEST OPTION",
                nearest: "✦ NEAREST OPTION"
            };

            top.append(
                make(
                    "span",
                    index === 0
                        ? badges[priority]
                        : "RECOMMENDED OPTION",
                    "nrx-rank"
                ),
                make(
                    "span",
                    String(index + 1).padStart(2, "0"),
                    "nrx-number"
                )
            );

            card.appendChild(top);

            card.appendChild(
                make(
                    "h4",
                    station.name ||
                    "Unnamed Charging Station"
                )
            );

            card.appendChild(
                make(
                    "p",
                    station.address ||
                    "Address not available",
                    "nrx-address"
                )
            );

            const stats = make(
                "div",
                undefined,
                "nrx-stats"
            );

            addStat(
                stats,
                "DISTANCE",
                item.distance === null
                    ? "Not measured"
                    : item.distance.toFixed(2) + " km"
            );

            addStat(
                stats,
                "CHARGER POWER",
                item.power === null
                    ? "Unknown"
                    : item.power + " kW"
            );

            addStat(
                stats,
                "PRICE / kWh",
                item.price === null
                    ? "Not published"
                    : money(item.price)
            );

            addStat(
                stats,
                "ESTIMATED COST",
                item.cost === null
                    ? "Unknown"
                    : money(item.cost),
                true
            );

            addStat(
                stats,
                "IDEALIZED TIME",
                item.time === null
                    ? "Unknown"
                    : Math.round(item.time) + " min"
            );

            addStat(
                stats,
                "CONNECTOR",
                connectors(station).join(", ") ||
                "Unknown"
            );

            card.appendChild(stats);

            card.appendChild(
                make(
                    "div",
                    "✦ " + reason(item, index),
                    "nrx-reason"
                )
            );

            const notes = [];

            if (needs.genericBattery) {
                notes.push(
                    "Illustrative 60 kWh battery."
                );
            }

            if (
                item.connectorStatus === "unknown"
            ) {
                notes.push(
                    "Connector compatibility unknown."
                );
            }

            if (
                item.time !== null &&
                needs.vehicleMaxPower === null
            ) {
                notes.push(
                    "Vehicle maximum charging rate not recorded."
                );
            }

            if (item.price === null) {
                notes.push(
                    "Published tariff unavailable."
                );
            }

            notes.push(
                "Live charger availability not verified."
            );

            card.appendChild(
                make(
                    "div",
                    notes.join(" "),
                    "nrx-notes"
                )
            );

            const actions = make(
                "div",
                undefined,
                "nrx-card-actions"
            );

            const directions = make(
                "a",
                "↗ Directions"
            );

            directions.href =
                "https://www.google.com/maps/dir/?api=1" +
                "&destination=" +
                encodeURIComponent(
                    `${station.lat},${station.lng}`
                );

            directions.target = "_blank";
            directions.rel = "noopener noreferrer";

            const mapButton = make(
                "button",
                "⌖ Show on Map"
            );

            mapButton.type = "button";

            mapButton.addEventListener(
                "click",
                () => showOnMap(station)
            );

            actions.append(directions, mapButton);
            card.appendChild(actions);

            return card;
        }

        // ==========================================
        // RENDER RESULTS
        // ==========================================

        function renderResults(results, needs) {
            const container = $("nrx-results");

            container.replaceChildren();

            const descriptions = {
                overall:
                    "Balanced ranking using available cost, speed and distance data.",
                cheapest:
                    "Sorted by estimated charging cost: lowest first.",
                fastest:
                    "Sorted by estimated charging duration: shortest first.",
                nearest:
                    "Sorted by straight-line distance: nearest first."
            };

            $("nrx-ranking-description").textContent =
                descriptions[$("nrx-priority").value];

            if (!results.length) {
                container.appendChild(
                    make(
                        "div",
                        "No suitable charging stations found. " +
                        "Try another city or vehicle.",
                        "nrx-empty"
                    )
                );

                $("nrx-count").textContent = "0 MATCHES";

                setStatus(
                    "No suitable stations were found.",
                    "error"
                );

                return;
            }

            results.forEach((item, index) => {
                container.appendChild(
                    createCard(item, index, needs)
                );
            });

            $("nrx-count").textContent =
                results.length + " TOP MATCHES";

            setStatus(
                "Optimization: " + priorityLabel() +
                ". Showing " + results.length +
                " recommended stations in " +
                citySelect.value + ".",
                "success"
            );
        }

        // ==========================================
        // FETCH STATIONS
        // ==========================================

        async function fetchStations() {
            const response = await fetch(
                "/api/charging-stations?city=" +
                encodeURIComponent(citySelect.value)
            );

            let data;

            try {
                data = await response.json();
            } catch {
                throw new Error(
                    "Station API returned invalid data."
                );
            }

            if (!response.ok) {
                throw new Error(
                    data.error ||
                    "Unable to retrieve charging stations."
                );
            }

            state.stations = Array.isArray(data.stations)
                ? data.stations
                : [];
        }

        // ==========================================
        // FIND RECOMMENDATIONS
        // ==========================================

        async function findRecommendations() {
            if (state.loading) {
                state.pending = true;
                return;
            }

            const button = $("nrx-find");

            state.loading = true;
            button.disabled = true;

            button.textContent = "Analyzing stations...";

            try {
                do {
                    state.pending = false;

                    const request = ++state.request;
                    const city = citySelect.value;

                    const needs = requirements();

                    if (
                        $("nrx-priority").value === "nearest" &&
                        !state.location
                    ) {
                        throw new Error(
                            "Use My Location before selecting " +
                            "Nearest Charging Station."
                        );
                    }

                    setStatus(
                        "Calculating " +
                        priorityLabel() +
                        " recommendations..."
                    );

                    await fetchStations();

                    if (
                        request !== state.request ||
                        city !== citySelect.value
                    ) {
                        state.pending = true;
                        continue;
                    }

                    if (!state.stations.length) {
                        throw new Error(
                            "No charging stations returned " +
                            "for this city."
                        );
                    }

                    const results = rankStations(needs);

                    state.results = results;
                    state.hasResults = true;

                    renderResults(results, needs);

                } while (state.pending);

            } catch (error) {
                setStatus(error.message, "error");

                console.error(
                    "EVCharge recommendation error:",
                    error
                );

            } finally {
                state.loading = false;
                button.disabled = false;

                button.textContent =
                    "✦ Find Best Charging Stations";

                if (state.pending) {
                    state.pending = false;
                    findRecommendations();
                }
            }
        }

        // ==========================================
        // AUTOMATIC REFRESH
        // ==========================================

        function requestRefresh() {
            if (!state.hasResults) {
                setStatus(
                    "Optimization selected: " +
                    priorityLabel() +
                    ". Click Find Best Charging Stations."
                );
                return;
            }

            if (state.loading) {
                state.pending = true;
                return;
            }

            findRecommendations();
        }

        // ==========================================
        // EVENTS
        // ==========================================

        // Main find button.
        $("nrx-find").addEventListener(
            "click",
            findRecommendations
        );

        // Location button.
        $("nrx-location").addEventListener(
            "click",
            useLocation
        );

        // FIX: Recalculate when priority changes.
        $("nrx-priority").addEventListener(
            "change",
            requestRefresh
        );

        // Recalculate when vehicle changes.
        $("nrx-vehicle").addEventListener(
            "change",
            () => {
                applyVehicleDefaults();
                requestRefresh();
            }
        );

        // Recalculate when battery values change.
        $("nrx-current").addEventListener(
            "change",
            requestRefresh
        );

        $("nrx-target").addEventListener(
            "change",
            requestRefresh
        );

        // Handle city changes.
        citySelect.addEventListener(
            "change",
            () => {
                state.request++;
                state.stations = [];
                state.results = [];

                $("nrx-results").replaceChildren(
                    make(
                        "div",
                        "City changed. Finding new " +
                        "recommendations...",
                        "nrx-empty"
                    )
                );

                $("nrx-count").textContent = "READY";

                if (state.hasResults) {
                    requestRefresh();
                } else {
                    setStatus(
                        "Choose your preferences and " +
                        "analyze stations in " +
                        citySelect.value + "."
                    );
                }
            }
        );

        // ==========================================
        // START MODULE
        // ==========================================

        loadVehicles();

        console.log(
            "EVCharge Nexus Module 4 initialized."
        );
    }
})();
