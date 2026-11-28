
document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    const $ = id => document.getElementById(id);

    const mapElement = $("charging-map");

    if (!mapElement || typeof L === "undefined") {
        console.error("Leaflet or charging map is missing.");
        return;
    }

    // ==========================================
    // CITY LOCATIONS
    // ==========================================

    const CITIES = {
        Karachi: [24.8607, 67.0011],
        Lahore: [31.5204, 74.3587],
        Islamabad: [33.6844, 73.0479],
        Rawalpindi: [33.5651, 73.0169],
        Faisalabad: [31.4504, 73.1350],
        Multan: [30.1575, 71.5249],
        Peshawar: [34.0151, 71.5249],
        Quetta: [30.1798, 66.9750],
        Hyderabad: [25.3960, 68.3578]
    };

    // ==========================================
    // REPORTED KARACHI DIRECTORY INFORMATION
    //
    // These are published directory records,
    // not verified live operator information.
    //
    // Only enrich confidently matched names.
    // Do not overwrite usable API information.
    // ==========================================

    const DIRECTORY = [
        {
            aliases: [
                "go libra civil lines",
                "go libra",
                "libra autos"
            ],
            operator: "GO Petroleum",
            hours: "24/7"
        },
        {
            aliases: [
                "caltex estate avenue"
            ],
            operator: "Caltex",
            hours: "24/7"
        },
        {
            aliases: [
                "hubco green charging station"
            ],
            operator: "HUBCO Green",
            hours: "24/7"
        },
        {
            aliases: [
                "inverex charging station"
            ],
            operator: "Inverex",
            hours: "10:00 AM – 7:00 PM"
        },
        {
            aliases: [
                "abb m 9 motorway"
            ],
            operator: "ABB / Shell Recharge",
            hours: "24/7"
        },
        {
            aliases: [
                "bilal ev caltex"
            ],
            operator: "Caltex",
            hours: "24/7"
        },
        {
            aliases: [
                "shell recharge askari 4"
            ],
            operator: "Shell Recharge",
            hours: "24/7"
        },
        {
            aliases: [
                "shell recharge dha phase 5"
            ],
            operator: "Shell Recharge",
            hours: "24/7"
        },
        {
            aliases: [
                "haval society khalid bin waleed"
            ],
            operator: "Independent",
            hours: "9:00 AM – 6:00 PM; closed Sunday"
        }
    ];

    // ==========================================
    // ELEMENTS
    // ==========================================

    const citySelect = $("city");
    const searchInput = $("search");
    const connectorSelect = $("connector");
    const vehicleSelect = $("vehicle");
    const stationList = $("station-list");
    const countElement = $("count");

    const compareBar = $("compare-bar");
    const compareCount = $("compare-count");
    const compareModal = $("compare-modal");
    const compareGrid = $("compare-grid");

    const selectedStations = new Map();

    let allStations = [];
    let visibleStations = [];
    let vehicles = [];
    let userLocation = null;
    let locationMarker = null;
    let nearestLine = null;
    let nearestCircle = null;
    let requestId = 0;

    // ==========================================
    // HELPERS
    // ==========================================

    function normalize(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
    }

    function hasValue(value) {
        return value !== null &&
            value !== undefined &&
            String(value).trim() !== "";
    }

    function meaningful(value) {
        if (!hasValue(value)) return false;

        const text = normalize(value);

        return ![
            "unknown",
            "unknown operator",
            "not available",
            "not recorded",
            "n a",
            "none",
            "null"
        ].includes(text);
    }

    function textValue(value) {
        return meaningful(value)
            ? String(value)
            : "Not available";
    }

    function numberOrNull(value) {
        if (!hasValue(value)) return null;

        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : null;
    }

    function positiveNumber(value) {
        const number = numberOrNull(value);

        return number !== null && number > 0
            ? number
            : null;
    }

    function money(value) {
        return "Rs. " + Number(value).toLocaleString(
            "en-PK",
            {
                maximumFractionDigits: 0
            }
        );
    }

    function create(tag, content, className) {
        const element = document.createElement(tag);

        if (content !== undefined) {
            element.textContent = String(content);
        }

        if (className) {
            element.className = className;
        }

        return element;
    }

    function safeUrl(value) {
        if (!hasValue(value)) return null;

        try {
            const url = new URL(value);

            return ["http:", "https:"].includes(
                url.protocol
            )
                ? url.href
                : null;
        } catch {
            return null;
        }
    }

    function stationKey(station) {
        return String(
            station.id ||
            `${station.name}-${station.lat}-${station.lng}`
        );
    }

    function connectorList(station) {
        return Array.isArray(station.connectors)
            ? station.connectors.filter(Boolean)
            : [];
    }

    function matchesConnector(station, wanted) {
        if (!wanted) return true;

        const required = normalize(wanted)
            .replace(/\s/g, "");

        return connectorList(station).some(item => {
            const actual = normalize(item)
                .replace(/\s/g, "");

            if (required === "ccs") {
                return actual.includes("ccs");
            }

            if (required === "gb") {
                return actual.includes("gb");
            }

            return actual.includes(required);
        });
    }

    function validCoordinates(station) {
        const lat = numberOrNull(station.lat);
        const lng = numberOrNull(station.lng);

        return lat !== null &&
            lng !== null &&
            Math.abs(lat) <= 90 &&
            Math.abs(lng) <= 180;
    }

    function distanceKm(lat1, lng1, lat2, lng2) {
        const rad = degrees =>
            degrees * Math.PI / 180;

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

    function directionsUrl(station) {
        return (
            "https://www.google.com/maps/dir/?api=1" +
            "&destination=" +
            encodeURIComponent(
                `${station.lat},${station.lng}`
            )
        );
    }

    // ==========================================
    // DIRECTORY ENRICHMENT
    // ==========================================

    function enrichStation(station, city) {
        const enriched = { ...station };

        if (city !== "Karachi") {
            return enriched;
        }

        const name = normalize(station.name);

        const record = DIRECTORY.find(entry =>
            entry.aliases.some(alias =>
                name.includes(alias)
            )
        );

        if (!record) {
            return enriched;
        }

        if (!meaningful(enriched.operator)) {
            enriched.operator = record.operator;
            enriched.operator_source =
                "Published directory";
        }

        if (!meaningful(enriched.opening_hours)) {
            enriched.opening_hours = record.hours;
            enriched.hours_source =
                "Published directory";
        }

        return enriched;
    }

    // ==========================================
    // PRICING
    // ==========================================

    function tariff(station) {
        const price = numberOrNull(
            station.price_per_kwh
        );

        return price !== null && price >= 0
            ? price
            : null;
    }

    function priceText(station) {
        const price = tariff(station);

        if (price === null) {
            return "Price not published";
        }

        let label = "Recorded tariff";

        if (
            station.price_type ===
            "published_directory"
        ) {
            label = "Published directory tariff";
        } else if (
            station.price_type ===
            "community_recorded"
        ) {
            label = "Community-recorded tariff";
        }

        return `${money(price)}/kWh · ${label}`;
    }

    function validPriceSource(station) {
        if (tariff(station) === null) {
            return null;
        }

        if (!meaningful(station.price_source)) {
            return null;
        }

        return safeUrl(station.price_source_url);
    }

    function powerText(station) {
        const power = positiveNumber(
            station.power_kw
        );

        return power === null
            ? "Power not recorded"
            : `${power} kW`;
    }

    function operatorText(station) {
        const operator = textValue(
            station.operator
        );

        if (station.operator_source) {
            return `${operator} (directory-reported)`;
        }

        return operator;
    }

    function hoursText(station) {
        const hours = textValue(
            station.opening_hours
        );

        if (station.hours_source) {
            return `${hours} (directory-reported)`;
        }

        return hours;
    }

    function priceSourceText(station) {
        if (tariff(station) === null) {
            return "No published tariff";
        }

        return textValue(station.price_source);
    }

    // ==========================================
    // MAP
    // ==========================================

    const map = L.map("charging-map", {
        zoomControl: false
    }).setView(CITIES.Karachi, 12);

    L.control.zoom({
        position: "bottomright"
    }).addTo(map);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution:
                "&copy; OpenStreetMap contributors",
            maxZoom: 19
        }
    ).addTo(map);

    const markerGroup = L.featureGroup().addTo(map);

    function fitMap() {
        map.invalidateSize();

        if (markerGroup.getLayers().length) {
            map.fitBounds(
                markerGroup.getBounds(),
                {
                    padding: [40, 40],
                    maxZoom: 14
                }
            );
        } else {
            map.setView(
                CITIES[citySelect.value] ||
                CITIES.Karachi,
                12
            );
        }
    }

    // ==========================================
    // SAVED VEHICLES
    // ==========================================

    function selectedVehicle() {
        return vehicles.find(vehicle =>
            String(vehicle.id) ===
            String(vehicleSelect.value)
        ) || null;
    }

    function vehicleConnector() {
        return selectedVehicle()?.connector || "";
    }

    async function loadVehicles() {
        try {
            const response = await fetch(
                "/api/my-vehicles"
            );

            if (!response.ok) {
                throw new Error(
                    "Could not load saved vehicles"
                );
            }

            const data = await response.json();

            vehicles = Array.isArray(data.vehicles)
                ? data.vehicles
                : [];

            vehicleSelect.replaceChildren();

            const anyOption = create(
                "option",
                "Any vehicle"
            );

            anyOption.value = "";
            vehicleSelect.appendChild(anyOption);

            vehicles.forEach(vehicle => {
                const option = create(
                    "option",
                    `${vehicle.manufacturer} ${vehicle.model} (${vehicle.connector})`
                );

                option.value = String(vehicle.id);

                vehicleSelect.appendChild(option);
            });

        } catch (error) {
            console.warn(error);
            vehicles = [];
        }
    }

    function fillVehicleCalculator() {
        const vehicle = selectedVehicle();

        if (!vehicle) return;

        if (positiveNumber(vehicle.battery_kwh)) {
            $("calc-battery").value =
                vehicle.battery_kwh;
        }

        if (numberOrNull(vehicle.current_soc) !== null) {
            $("calc-start").value =
                vehicle.current_soc;
        }

        if (numberOrNull(vehicle.target_soc) !== null) {
            $("calc-target").value =
                vehicle.target_soc;
        }
    }

    function compatibilityText(station) {
        const vehicle = selectedVehicle();

        if (!vehicle) {
            return "Select a saved vehicle";
        }

        if (!connectorList(station).length) {
            return "Unknown — connector not recorded";
        }

        return matchesConnector(
            station,
            vehicle.connector
        )
            ? "Connector type matches (not verified)"
            : "Connector type does not match";
    }

    // ==========================================
    // CHARGING CALCULATOR
    // ==========================================

    function calculatorValues() {
        const battery = Number(
            $("calc-battery").value
        );

        const start = Number(
            $("calc-start").value
        );

        const target = Number(
            $("calc-target").value
        );

        const efficiency = Number(
            $("calc-efficiency").value
        );

        if (
            !Number.isFinite(battery) ||
            battery <= 0 ||
            !Number.isFinite(start) ||
            !Number.isFinite(target) ||
            start < 0 ||
            target > 100 ||
            target <= start ||
            !Number.isFinite(efficiency) ||
            efficiency <= 0 ||
            efficiency > 100
        ) {
            return null;
        }

        const batteryEnergy =
            battery * (target - start) / 100;

        const gridEnergy =
            batteryEnergy / (efficiency / 100);

        return {
            batteryEnergy,
            gridEnergy
        };
    }

    function estimateStation(station) {
        const values = calculatorValues();

        if (!values) {
            return {
                energy: "Invalid calculator inputs",
                cost: "Invalid calculator inputs",
                time: "Invalid calculator inputs"
            };
        }

        const price = tariff(station);

        const power = positiveNumber(
            station.power_kw
        );

        return {
            energy:
                values.gridEnergy.toFixed(1) +
                " kWh",

            cost: price === null
                ? "Cannot estimate — price unknown"
                : money(values.gridEnergy * price),

            time: power === null
                ? "Cannot estimate — power unknown"
                : Math.round(
                    values.gridEnergy / power * 60
                ) + " min (idealized)"
        };
    }

    // ==========================================
    // STATION DETAILS
    // ==========================================

    function setDetail(id, value) {
        const element = $(id);

        if (element) {
            element.textContent = value;
        }
    }

    function openDetails(station) {
        setDetail(
            "details-title",
            textValue(station.name)
        );

        setDetail(
            "details-address",
            textValue(station.address)
        );

        setDetail(
            "details-power",
            powerText(station)
        );

        setDetail(
            "details-price",
            priceText(station)
        );

        setDetail(
            "details-price-source",
            priceSourceText(station)
        );

        setDetail(
            "details-connectors",
            connectorList(station).join(", ") ||
            "Not recorded"
        );

        setDetail(
            "details-capacity",
            textValue(station.capacity)
        );

        setDetail(
            "details-operator",
            operatorText(station)
        );

        setDetail(
            "details-hours",
            hoursText(station)
        );

        setDetail(
            "details-availability",
            "Not verified"
        );

        setDetail(
            "details-source",
            textValue(station.source)
        );

        const priceLink = $("details-price-link");

        if (priceLink) {
            const url = validPriceSource(station);

            priceLink.hidden = !url;
            priceLink.style.display = url
                ? "block"
                : "none";

            if (url) {
                priceLink.href = url;
            } else {
                priceLink.removeAttribute("href");
            }
        }

        const phone = $("details-phone");

        if (phone) {
            phone.replaceChildren();

            if (meaningful(station.phone)) {
                const link = create(
                    "a",
                    station.phone
                );

                link.href = "tel:" +
                    String(station.phone)
                        .replace(/[^\d+]/g, "");

                phone.appendChild(link);
            } else {
                phone.textContent = "Not available";
            }
        }

        const website = $("details-website");

        if (website) {
            website.replaceChildren();

            const url = safeUrl(station.website);

            if (url) {
                const link = create(
                    "a",
                    "Visit website ↗"
                );

                link.href = url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";

                website.appendChild(link);
            } else {
                website.textContent = "Not available";
            }
        }

        const directions = $("details-directions");

        if (directions) {
            directions.href = directionsUrl(station);
        }

        $("station-details").hidden = false;
    }

    function closeDetails() {
        $("station-details").hidden = true;
    }

    // ==========================================
    // COMPARISON SELECTION
    // ==========================================

    function compareButton(station) {
        const button = create(
            "button",
            "+ Compare",
            "nexus-compare-btn"
        );

        button.type = "button";
        button.dataset.compareKey =
            stationKey(station);

        button.addEventListener("click", event => {
            event.stopPropagation();

            const key = stationKey(station);

            if (selectedStations.has(key)) {
                selectedStations.delete(key);
            } else {
                if (selectedStations.size >= 3) {
                    alert(
                        "You can compare a maximum of 3 stations."
                    );
                    return;
                }

                selectedStations.set(key, station);
            }

            updateComparison();
        });

        return button;
    }

    function updateComparison() {
        compareBar.hidden =
            selectedStations.size === 0;

        compareCount.textContent =
            `${selectedStations.size} / 3 stations selected`;

        $("open-comparison").disabled =
            selectedStations.size < 2;

        document.querySelectorAll(
            "[data-compare-key]"
        ).forEach(button => {
            const selected = selectedStations.has(
                button.dataset.compareKey
            );

            button.textContent = selected
                ? "✓ Selected"
                : "+ Compare";

            button.setAttribute(
                "aria-pressed",
                String(selected)
            );
        });

        if (!compareModal.hidden) {
            renderComparison();
        }
    }

    function addComparisonField(
        card,
        label,
        value
    ) {
        const row = create(
            "div",
            undefined,
            "nexus-compare-field"
        );

        row.append(
            create("small", label),
            create("strong", value)
        );

        card.appendChild(row);
    }

    function distanceText(station) {
        if (!userLocation) {
            return "Use My Location to calculate";
        }

        const distance = distanceKm(
            userLocation.lat,
            userLocation.lng,
            Number(station.lat),
            Number(station.lng)
        );

        return (
            distance.toFixed(2) +
            " km (straight-line)"
        );
    }

    function renderComparison() {
        compareGrid.replaceChildren();

        selectedStations.forEach(station => {
            const card = create(
                "article",
                undefined,
                "nexus-compare-card"
            );

            card.append(
                create(
                    "h3",
                    textValue(station.name)
                ),
                create(
                    "p",
                    textValue(station.address)
                )
            );

            const estimate = estimateStation(
                station
            );

            const fields = [
                [
                    "Distance",
                    distanceText(station)
                ],
                [
                    "Charging power",
                    powerText(station)
                ],
                [
                    "Price per kWh",
                    priceText(station)
                ],
                [
                    "Estimated energy from grid",
                    estimate.energy
                ],
                [
                    "Estimated charging cost",
                    estimate.cost
                ],
                [
                    "Idealized charging time",
                    estimate.time
                ],
                [
                    "Connector types",
                    connectorList(station).join(", ") ||
                    "Not recorded"
                ],
                [
                    "Vehicle compatibility",
                    compatibilityText(station)
                ],
                [
                    "Charging points",
                    textValue(station.capacity)
                ],
                [
                    "Operator",
                    operatorText(station)
                ],
                [
                    "Opening hours",
                    hoursText(station)
                ],
                [
                    "Availability",
                    "Not verified"
                ],
                [
                    "Station data source",
                    textValue(station.source)
                ],
                [
                    "Price source",
                    priceSourceText(station)
                ]
            ];

            fields.forEach(([label, value]) => {
                addComparisonField(
                    card,
                    label,
                    value
                );
            });

            // FIX: No published price = no source link.

            const sourceUrl = validPriceSource(
                station
            );

            if (sourceUrl) {
                const sourceLink = create(
                    "a",
                    "View published price source ↗"
                );

                sourceLink.href = sourceUrl;
                sourceLink.target = "_blank";
                sourceLink.rel =
                    "noopener noreferrer";

                card.appendChild(sourceLink);
            }

            const directions = create(
                "a",
                "Get directions ↗"
            );

            directions.href = directionsUrl(
                station
            );

            directions.target = "_blank";
            directions.rel =
                "noopener noreferrer";

            card.appendChild(directions);

            const remove = create(
                "button",
                "Remove",
                "nexus-secondary-btn"
            );

            remove.type = "button";

            remove.addEventListener("click", () => {
                selectedStations.delete(
                    stationKey(station)
                );

                if (!selectedStations.size) {
                    compareModal.hidden = true;
                }

                updateComparison();
            });

            card.appendChild(remove);
            compareGrid.appendChild(card);
        });
    }

    // ==========================================
    // STATION CARDS AND MARKERS
    // ==========================================

    function renderStations() {
        closeDetails();

        markerGroup.clearLayers();
        stationList.replaceChildren();

        const search = normalize(
            searchInput.value
        );

        const connector =
            connectorSelect.value;

        const vehicle =
            vehicleConnector();

        visibleStations = allStations.filter(
            station => {
                const searchable = normalize([
                    station.name,
                    station.address,
                    station.operator
                ].join(" "));

                return (
                    validCoordinates(station) &&
                    searchable.includes(search) &&
                    matchesConnector(
                        station,
                        connector
                    ) &&
                    matchesConnector(
                        station,
                        vehicle
                    )
                );
            }
        );

        countElement.textContent =
            `${visibleStations.length} charging locations`;

        if (!visibleStations.length) {
            stationList.appendChild(
                create(
                    "p",
                    "No matching stations found. Try changing your filters."
                )
            );

            fitMap();
            return;
        }

        visibleStations.forEach(station => {
            const marker = L.marker([
                Number(station.lat),
                Number(station.lng)
            ]).addTo(markerGroup);

            const popup = create("div");

            popup.append(
                create(
                    "strong",
                    station.name
                ),
                create(
                    "p",
                    station.address
                ),
                create(
                    "p",
                    powerText(station)
                ),
                create(
                    "p",
                    priceText(station)
                )
            );

            const detailsButton = create(
                "button",
                "View details"
            );

            detailsButton.type = "button";

            detailsButton.addEventListener(
                "click",
                () => openDetails(station)
            );

            popup.append(
                detailsButton,
                document.createTextNode(" "),
                compareButton(station)
            );

            marker.bindPopup(popup);

            marker.on("click", () => {
                openDetails(station);
            });

            const card = create(
                "div",
                undefined,
                "station-card"
            );

            card.append(
                create(
                    "strong",
                    station.name
                ),
                create(
                    "p",
                    station.address
                ),
                create(
                    "small",
                    connectorList(station).join(", ") ||
                    "Connectors not recorded"
                ),
                create(
                    "p",
                    "⚡ " + powerText(station)
                ),
                create(
                    "p",
                    "💰 " + priceText(station)
                ),
                create(
                    "p",
                    "🏢 " + operatorText(station)
                ),
                create(
                    "p",
                    "🕒 " + hoursText(station)
                )
            );

            const actions = create(
                "div",
                undefined,
                "station-actions"
            );

            const viewButton = create(
                "button",
                "View station",
                "nexus-secondary-btn"
            );

            viewButton.type = "button";

            viewButton.addEventListener(
                "click",
                () => {
                    map.setView([
                        station.lat,
                        station.lng
                    ], 15);

                    marker.openPopup();
                    openDetails(station);
                }
            );

            actions.append(
                viewButton,
                compareButton(station)
            );

            card.appendChild(actions);
            stationList.appendChild(card);
        });

        updateComparison();
        fitMap();
    }

    // ==========================================
    // STATION API
    // ==========================================

    async function loadStations() {
        const currentRequest = ++requestId;
        const city = citySelect.value;

        selectedStations.clear();
        compareModal.hidden = true;
        updateComparison();

        allStations = [];
        markerGroup.clearLayers();
        stationList.replaceChildren();

        countElement.textContent =
            "Loading charging stations...";

        map.setView(
            CITIES[city] || CITIES.Karachi,
            12
        );

        try {
            const response = await fetch(
                "/api/charging-stations?city=" +
                encodeURIComponent(city)
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error ||
                    `API error ${response.status}`
                );
            }

            if (currentRequest !== requestId) {
                return;
            }

            allStations = Array.isArray(
                data.stations
            )
                ? data.stations.map(station =>
                    enrichStation(station, city)
                )
                : [];

            renderStations();

        } catch (error) {
            if (currentRequest !== requestId) {
                return;
            }

            console.error(error);

            countElement.textContent =
                "Station data unavailable";

            stationList.replaceChildren(
                create(
                    "p",
                    "Unable to load stations: " +
                    error.message
                )
            );
        }
    }

    // ==========================================
    // LOCATION AND NEAREST STATION
    // ==========================================

    function getLocation() {
        return new Promise(
            (resolve, reject) => {
                if (!navigator.geolocation) {
                    reject(
                        new Error(
                            "Geolocation not supported"
                        )
                    );
                    return;
                }

                navigator.geolocation.getCurrentPosition(
                    position => {
                        resolve({
                            lat:
                                position.coords.latitude,
                            lng:
                                position.coords.longitude
                        });
                    },
                    reject,
                    {
                        enableHighAccuracy: true,
                        timeout: 12000
                    }
                );
            }
        );
    }

    function showLocation(location) {
        userLocation = location;

        if (locationMarker) {
            map.removeLayer(locationMarker);
        }

        locationMarker = L.marker([
            location.lat,
            location.lng
        ]).addTo(map);

        locationMarker.bindPopup(
            "Your location"
        );

        if (!compareModal.hidden) {
            renderComparison();
        }
    }

    function clearNearest() {
        if (nearestLine) {
            map.removeLayer(nearestLine);
            nearestLine = null;
        }

        if (nearestCircle) {
            map.removeLayer(nearestCircle);
            nearestCircle = null;
        }

        const result = $("nearest-result");

        result.hidden = true;
        result.replaceChildren();
    }

    $("locate").addEventListener(
        "click",
        async () => {
            try {
                const location =
                    await getLocation();

                showLocation(location);

                map.setView([
                    location.lat,
                    location.lng
                ], 14);

                locationMarker.openPopup();

            } catch {
                alert(
                    "Unable to access your location. Check browser permissions."
                );
            }
        }
    );

    $("nearest").addEventListener(
        "click",
        async () => {
            if (!visibleStations.length) {
                alert(
                    "No stations are currently loaded."
                );
                return;
            }

            try {
                const location =
                    await getLocation();

                showLocation(location);
                clearNearest();

                let closest = null;
                let minimum = Infinity;

                visibleStations.forEach(
                    station => {
                        const distance =
                            distanceKm(
                                location.lat,
                                location.lng,
                                Number(station.lat),
                                Number(station.lng)
                            );

                        if (distance < minimum) {
                            minimum = distance;
                            closest = station;
                        }
                    }
                );

                if (!closest) return;

                nearestCircle =
                    L.circleMarker(
                        [
                            closest.lat,
                            closest.lng
                        ],
                        {
                            radius: 18,
                            color: "#16a34a",
                            weight: 4,
                            fillOpacity: 0.2
                        }
                    ).addTo(map);

                nearestLine = L.polyline(
                    [
                        [
                            location.lat,
                            location.lng
                        ],
                        [
                            closest.lat,
                            closest.lng
                        ]
                    ],
                    {
                        color: "#16a34a",
                        dashArray: "8, 8"
                    }
                ).addTo(map);

                const result =
                    $("nearest-result");

                result.replaceChildren();

                result.append(
                    create(
                        "strong",
                        "⚡ Nearest charging station"
                    ),
                    create(
                        "p",
                        closest.name
                    ),
                    create(
                        "p",
                        minimum.toFixed(2) +
                        " km straight-line distance"
                    )
                );

                const directions = create(
                    "a",
                    "Get directions ↗"
                );

                directions.href =
                    directionsUrl(closest);

                directions.target = "_blank";
                directions.rel =
                    "noopener noreferrer";

                result.appendChild(directions);
                result.hidden = false;

                map.fitBounds(
                    [
                        [
                            location.lat,
                            location.lng
                        ],
                        [
                            closest.lat,
                            closest.lng
                        ]
                    ],
                    {
                        padding: [60, 60],
                        maxZoom: 15
                    }
                );

                openDetails(closest);

            } catch {
                alert(
                    "Unable to find the nearest station. Check location permissions."
                );
            }
        }
    );

    $("reset").addEventListener(
        "click",
        () => {
            closeDetails();
            clearNearest();
            fitMap();
        }
    );

    $("close-details").addEventListener(
        "click",
        closeDetails
    );

    // ==========================================
    // COMPARISON MODAL
    // ==========================================

    $("open-comparison").addEventListener(
        "click",
        () => {
            if (selectedStations.size < 2) {
                alert(
                    "Select at least two stations."
                );
                return;
            }

            fillVehicleCalculator();

            renderComparison();

            compareModal.hidden = false;
        }
    );

    $("close-comparison").addEventListener(
        "click",
        () => {
            compareModal.hidden = true;
        }
    );

    $("clear-comparison").addEventListener(
        "click",
        () => {
            selectedStations.clear();
            compareModal.hidden = true;
            updateComparison();
        }
    );

    compareModal.addEventListener(
        "click",
        event => {
            if (event.target === compareModal) {
                compareModal.hidden = true;
            }
        }
    );

    document.addEventListener(
        "keydown",
        event => {
            if (event.key === "Escape") {
                compareModal.hidden = true;
            }
        }
    );

    [
        "calc-battery",
        "calc-start",
        "calc-target",
        "calc-efficiency"
    ].forEach(id => {
        $(id).addEventListener(
            "input",
            () => {
                if (!compareModal.hidden) {
                    renderComparison();
                }
            }
        );
    });

    // ==========================================
    // FILTER EVENTS
    // ==========================================

    citySelect.addEventListener(
        "change",
        loadStations
    );

    searchInput.addEventListener(
        "input",
        renderStations
    );

    connectorSelect.addEventListener(
        "change",
        renderStations
    );

    vehicleSelect.addEventListener(
        "change",
        () => {
            fillVehicleCalculator();
            renderStations();
        }
    );

    window.addEventListener(
        "resize",
        () => map.invalidateSize()
    );

    setTimeout(
        () => map.invalidateSize(),
        300
    );

    // ==========================================
    // INITIALIZE
    // ==========================================

    async function initialize() {
        await loadVehicles();
        await loadStations();
    }

    initialize();
});
