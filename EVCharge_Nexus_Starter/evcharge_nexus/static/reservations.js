
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    stations: [],
    vehicles: [],
    stationRequest: 0,
    validPlan: null,
    booking: false
  };

  const EFFICIENCY = 0.90;
  const MAX_DAYS = 14;

  // ==========================================
  // GENERAL HELPERS
  // ==========================================

  function status(message, type = "") {
    const element = $("res-alert");
    element.textContent = message;
    element.className = "res-alert" + (type ? " " + type : "");
  }

  function addOption(select, value, label) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    select.appendChild(option);
  }

  function selectedVehicle() {
    return state.vehicles.find(
      v => String(v.id) === $("res-vehicle").value
    );
  }

  function selectedStation() {
    return state.stations.find(
      s => String(s.id) === $("res-station").value
    );
  }

  function normalizeConnector(value) {
    const v = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    if (v.includes("ccs") || v.includes("combo")) return "ccs2";
    if (v.includes("chademo")) return "chademo";
    if (v.includes("type2") || v.includes("mennekes")) return "type2";
    if (v.includes("nacs") || v.includes("tesla")) return "nacs";
    if (v.includes("gbt")) return "gbt";

    return v;
  }

  function compatible(vehicle, station) {
    const required = normalizeConnector(vehicle.connector);

    const connectors = Array.isArray(station.connectors)
      ? station.connectors
      : [];

    return connectors.some(
      connector => normalizeConnector(connector) === required
    );
  }

  function formatDuration(minutes) {
    const total = Math.max(1, Math.ceil(minutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;

    if (hours && mins) return `${hours}h ${mins}m`;
    if (hours) return `${hours}h`;
    return `${mins}m`;
  }

  function pakistanNow() {
    return new Date(
      new Date().toLocaleString("en-US", {
        timeZone: "Asia/Karachi"
      })
    );
  }

  function dateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function pakistanStart(date, time) {
    return new Date(`${date}T${time}:00+05:00`);
  }

  // ==========================================
  // RESET CHARGING SUMMARY
  // ==========================================

  function resetSummary() {
    state.validPlan = null;

    $("res-confirm").disabled = true;
    $("res-confirm").textContent = "Confirm Reservation";

    $("res-energy").textContent = "—";
    $("res-duration").textContent = "—";
    $("res-cost").textContent = "—";

    $("res-summary-station").textContent = "Not selected";
    $("res-summary-vehicle").textContent = "Not selected";
    $("res-summary-connector").textContent = "—";
    $("res-summary-date").textContent = "Not selected";

    const bookingLink = $("res-booking-link");

    if (bookingLink) {
      bookingLink.hidden = true;
    }

    // Hide old directions when user changes selection.
    const directionsLink = $("res-directions-link");

    if (directionsLink) {
      directionsLink.hidden = true;
      directionsLink.style.display = "none";
    }
  }

  // ==========================================
  // API HELPERS
  // ==========================================

  async function fetchJSON(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Unable to load data (HTTP ${response.status}).`
      );
    }

    return response.json();
  }

  // ==========================================
  // LOAD SAVED VEHICLES
  // ==========================================

  async function loadVehicles() {
    const select = $("res-vehicle");

    try {
      const data = await fetchJSON("/api/my-vehicles");

      state.vehicles = Array.isArray(data.vehicles)
        ? data.vehicles
        : [];

      select.replaceChildren();
      addOption(select, "", "Select your saved EV");

      state.vehicles.forEach(vehicle => {
        addOption(
          select,
          vehicle.id,
          `${vehicle.manufacturer} ${vehicle.model} — ${vehicle.connector}`
        );
      });

      $("res-vehicle-info").textContent = state.vehicles.length
        ? "Choose a saved vehicle to calculate charging requirements."
        : "No saved vehicles. Add one in My Vehicles.";

    } catch (error) {
      select.replaceChildren();
      addOption(select, "", "Unable to load vehicles");
      status(error.message, "error");
    }
  }

  // ==========================================
  // LOAD CHARGING STATIONS
  // ==========================================

  async function loadStations() {
    const requestId = ++state.stationRequest;
    const city = $("res-city").value;
    const select = $("res-station");

    state.stations = [];
    resetSummary();

    select.replaceChildren();
    addOption(select, "", "Loading charging stations...");

    status(`Loading charging stations in ${city}...`);

    try {
      const data = await fetchJSON(
        `/api/charging-stations?city=${encodeURIComponent(city)}`
      );

      if (requestId !== state.stationRequest) return;

      state.stations = Array.isArray(data.stations)
        ? data.stations
        : [];

      state.stations.sort((a, b) =>
        String(a.name).localeCompare(String(b.name))
      );

      select.replaceChildren();
      addOption(select, "", "Select charging station");

      state.stations.forEach(station => {
        addOption(
          select,
          station.id,
          `${station.name} — ${station.address || city}`
        );
      });

      $("res-station-info").textContent =
        `${state.stations.length} stations found in ${city}.`;

      status(
        state.stations.length
          ? "Stations loaded. Select your vehicle and charging station."
          : "No stations found. Try another city.",
        state.stations.length ? "" : "error"
      );

    } catch (error) {
      if (requestId !== state.stationRequest) return;

      select.replaceChildren();
      addOption(select, "", "Stations unavailable");

      $("res-station-info").textContent =
        "Station data could not be loaded.";

      status(error.message, "error");
    }
  }

  // ==========================================
  // VEHICLE DEFAULTS
  // ==========================================

  function applyVehicleDefaults() {
    const vehicle = selectedVehicle();

    if (vehicle) {
      $("res-current").value = vehicle.current_soc;
      $("res-target").value = vehicle.target_soc;

      $("res-vehicle-info").textContent =
        `${vehicle.battery_kwh} kWh battery • ${vehicle.connector} connector`;
    }

    resetSummary();
  }

  // ==========================================
  // SMART CHARGING CALCULATOR
  // ==========================================

  function calculatePlan() {
    resetSummary();

    const vehicle = selectedVehicle();
    const station = selectedStation();

    if (!vehicle || !station) {
      status(
        "Please select both a vehicle and charging station.",
        "error"
      );
      return;
    }

    if (!compatible(vehicle, station)) {
      status(
        `Connector mismatch. Your vehicle uses ${vehicle.connector}, ` +
        "which is not listed at this station.",
        "error"
      );
      return;
    }

    const currentText = $("res-current").value.trim();
    const targetText = $("res-target").value.trim();

    const current = Number(currentText);
    const target = Number(targetText);

    const battery = Number(vehicle.battery_kwh);
    const power = Number(station.power_kw);

    if (
      !currentText ||
      !targetText ||
      !Number.isInteger(current) ||
      !Number.isInteger(target) ||
      current < 0 ||
      target > 100 ||
      current >= target
    ) {
      status(
        "Enter valid battery percentages. Target must exceed current.",
        "error"
      );
      return;
    }

    if (!Number.isFinite(battery) || battery <= 0) {
      status("Invalid vehicle battery capacity.", "error");
      return;
    }

    if (!Number.isFinite(power) || power <= 0) {
      status(
        "Station charging power is unknown. Booking cannot be estimated.",
        "error"
      );
      return;
    }

    const date = $("res-date").value;
    const time = $("res-time").value;

    if (!date || !time) {
      status("Please select a date and time.", "error");
      return;
    }

    const start = pakistanStart(date, time);
    const now = new Date();

    if (!Number.isFinite(start.getTime()) || start <= now) {
      status(
        "Please choose a future date and time in Pakistan.",
        "error"
      );
      return;
    }

    if (
      start > new Date(now.getTime() + MAX_DAYS * 86400000)
    ) {
      status(
        "Prototype bookings are available up to 14 days ahead.",
        "error"
      );
      return;
    }

    const [hours, minutesPart] = time.split(":").map(Number);

    if (
      !Number.isInteger(hours) ||
      !Number.isInteger(minutesPart) ||
      minutesPart % 15 !== 0
    ) {
      status(
        "Please choose a 15-minute time slot, such as 13:00, 13:15, 13:30 or 13:45.",
        "error"
      );
      return;
    }

    const energy = battery * (target - current) / 100;
    const gridEnergy = energy / EFFICIENCY;

    // Match backend's prototype duration calculation.
    const estimatedMinutes = Math.max(
      15,
      Math.ceil(
        (gridEnergy / power * 60 * 1.25) / 15
      ) * 15
    );

    if (estimatedMinutes > 360) {
      status(
        "Estimated charging session exceeds the six-hour booking limit.",
        "error"
      );
      return;
    }

    const end = new Date(
      start.getTime() + estimatedMinutes * 60000
    );

    if (
      end > new Date(now.getTime() + MAX_DAYS * 86400000)
    ) {
      status(
        "The charging session must finish within 14 days.",
        "error"
      );
      return;
    }

    const rawPrice = station.price_per_kwh;

    const hasPrice =
      rawPrice !== null &&
      rawPrice !== undefined &&
      rawPrice !== "" &&
      Number.isFinite(Number(rawPrice)) &&
      Number(rawPrice) >= 0;

    const cost = hasPrice
      ? gridEnergy * Number(rawPrice)
      : null;

    $("res-energy").textContent =
      `${energy.toFixed(1)} kWh`;

    $("res-duration").textContent =
      formatDuration(estimatedMinutes);

    $("res-cost").textContent =
      cost === null
        ? "Price unknown"
        : `Rs. ${Math.round(cost).toLocaleString("en-PK")}`;

    $("res-summary-station").textContent = station.name;

    $("res-summary-vehicle").textContent =
      `${vehicle.manufacturer} ${vehicle.model}`;

    $("res-summary-connector").textContent =
      vehicle.connector;

    $("res-summary-date").textContent =
      `${date} • ${time}`;

    state.validPlan = {
      city: $("res-city").value,
      station_id: String(station.id),
      vehicle_id: Number(vehicle.id),
      current_soc: current,
      target_soc: target,
      start_at: `${date}T${time}:00+05:00`
    };

    $("res-confirm").disabled = false;

    status(
      "Charging plan calculated successfully. " +
      "You can now confirm your academic prototype reservation. " +
      "Final slot availability will be checked by the server.",
      "success"
    );
  }

  // ==========================================
  // ALTERNATIVE BOOKING SLOTS
  // ==========================================

  function showAlternatives(alternatives) {
    const alert = $("res-alert");

    if (!Array.isArray(alternatives) || !alternatives.length) {
      return;
    }

    const heading = document.createElement("div");
    heading.textContent = "Alternative available prototype slots:";
    heading.style.marginTop = "12px";
    heading.style.fontWeight = "700";

    alert.appendChild(heading);

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexWrap = "wrap";
    wrapper.style.gap = "8px";
    wrapper.style.marginTop = "10px";

    alternatives.forEach(value => {
      const date = new Date(value);

      if (Number.isNaN(date.getTime())) return;

      const button = document.createElement("button");
      button.type = "button";

      button.textContent = date.toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
        dateStyle: "medium",
        timeStyle: "short"
      });

      button.style.padding = "9px 12px";
      button.style.borderRadius = "8px";
      button.style.border = "1px solid #43dca5";
      button.style.background = "#173b35";
      button.style.color = "#9df3ce";
      button.style.cursor = "pointer";

      button.addEventListener("click", () => {
        const pakistanDate = new Date(
          date.toLocaleString("en-US", {
            timeZone: "Asia/Karachi"
          })
        );

        $("res-date").value = dateString(pakistanDate);

        $("res-time").value =
          String(pakistanDate.getHours()).padStart(2, "0") +
          ":" +
          String(pakistanDate.getMinutes()).padStart(2, "0");

        calculatePlan();
      });

      wrapper.appendChild(button);
    });

    alert.appendChild(wrapper);
  }

  // ==========================================
  // GET DIRECTIONS - NEW FEATURE
  // ==========================================

  function showDirections(stationId) {
    const station = state.stations.find(
      s => String(s.id) === String(stationId)
    );

    if (!station) return;

    if (
      station.lat === null ||
      station.lat === undefined ||
      station.lng === null ||
      station.lng === undefined ||
      station.lat === "" ||
      station.lng === ""
    ) {
      return;
    }

    const lat = Number(station.lat);
    const lng = Number(station.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return;
    }

    let link = $("res-directions-link");

    if (!link) {
      link = document.createElement("a");

      link.id = "res-directions-link";
      link.className = "res-directions-btn";

      link.style.display = "block";
      link.style.width = "100%";
      link.style.boxSizing = "border-box";
      link.style.marginTop = "12px";
      link.style.padding = "15px";
      link.style.textAlign = "center";
      link.style.borderRadius = "12px";
      link.style.textDecoration = "none";
      link.style.fontWeight = "800";
      link.style.fontSize = "14px";
      link.style.background = "#173b35";
      link.style.border = "1px solid #43dca5";
      link.style.color = "#9df3ce";
      link.style.transition = "background 0.2s";

      link.addEventListener("mouseenter", () => {
        link.style.background = "#205347";
      });

      link.addEventListener("mouseleave", () => {
        link.style.background = "#173b35";
      });

      $("res-confirm").insertAdjacentElement(
        "afterend",
        link
      );
    }

    const destination = `${lat},${lng}`;

    link.href =
      "https://www.google.com/maps/dir/?api=1" +
      "&destination=" +
      encodeURIComponent(destination) +
      "&travelmode=driving";

    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "↗ Get Directions";

    link.hidden = false;
    link.style.display = "block";
  }

  // ==========================================
  // CONFIRM RESERVATION
  // ==========================================

  async function confirmReservation() {
    if (!state.validPlan || state.booking) return;

    const button = $("res-confirm");

    const bookingData = { ...state.validPlan };

    state.booking = true;
    button.disabled = true;
    button.textContent = "Confirming Reservation...";

    status("Checking prototype availability and saving booking...");

    try {
      const response = await fetch("/api/reservations", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(bookingData)
      });

      const result = await response.json();

      if (!response.ok) {
        status(
          result.error || "Unable to confirm reservation.",
          "error"
        );

        if (response.status === 409) {
          showAlternatives(result.alternatives);
        }

        return;
      }

      // Booking successfully saved.
      // Show navigation for the booked station.
      showDirections(bookingData.station_id);

      state.validPlan = null;

      button.textContent = "Reservation Confirmed ✓";

      status(
        `Prototype reservation confirmed! ` +
        `Your booking reference is ${result.reference}. ` +
        "No real charging operator has been notified.",
        "success"
      );

      const link = $("res-booking-link");

      if (link) {
        link.href = "/my-reservations";
        link.textContent = "View My Reservations →";
        link.hidden = false;
      } else {
        const newLink = document.createElement("a");

        newLink.id = "res-booking-link";
        newLink.href = "/my-reservations";
        newLink.textContent = "View My Reservations →";

        newLink.style.display = "block";
        newLink.style.marginTop = "14px";
        newLink.style.textAlign = "center";
        newLink.style.color = "#5ee0b0";
        newLink.style.fontWeight = "700";

        const directions = $("res-directions-link");

        if (directions) {
          directions.insertAdjacentElement(
            "afterend",
            newLink
          );
        } else {
          button.insertAdjacentElement(
            "afterend",
            newLink
          );
        }
      }

    } catch (error) {
      status(
        "Unable to connect to the reservation server. " +
        "Please check Flask and try again.",
        "error"
      );

    } finally {
      state.booking = false;

      if (state.validPlan) {
        button.disabled = false;
        button.textContent = "Confirm Reservation";
      }
    }
  }

  // ==========================================
  // INITIALIZE RESERVATION PAGE
  // ==========================================

  function initialize() {
    const today = pakistanNow();

    $("res-date").min = dateString(today);
    $("res-date").value = dateString(today);

    $("res-time").step = "900";

    resetSummary();

    $("res-city").addEventListener(
      "change",
      loadStations
    );

    $("res-vehicle").addEventListener(
      "change",
      applyVehicleDefaults
    );

    $("res-station").addEventListener("change", () => {
      resetSummary();

      const station = selectedStation();

      if (station) {
        const connectors = Array.isArray(station.connectors)
          ? station.connectors.join(", ")
          : "Unknown";

        $("res-station-info").textContent =
          `${connectors} • ${station.power_kw || "Unknown"} kW`;
      }
    });

    $("res-preview").addEventListener(
      "click",
      calculatePlan
    );

    $("res-confirm").addEventListener(
      "click",
      confirmReservation
    );

    [
      "res-current",
      "res-target",
      "res-date",
      "res-time"
    ].forEach(id => {
      $(id).addEventListener(
        "input",
        resetSummary
      );

      $(id).addEventListener(
        "change",
        resetSummary
      );
    });

    const params = new URLSearchParams(
      window.location.search
    );

    const requestedCity = params.get("city");

    if (requestedCity) {
      const match = [...$("res-city").options].find(
        option =>
          option.value.toLowerCase() ===
          requestedCity.toLowerCase()
      );

      if (match) {
        $("res-city").value = match.value;
      }
    }

    Promise.all([
      loadVehicles(),
      loadStations()
    ]);
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize
    );
  } else {
    initialize();
  }
})();
