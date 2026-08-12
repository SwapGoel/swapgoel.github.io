/*
  Scroll-driven 3D map journey: India -> Varanasi (MGKVP) -> Dhanbad (IIT ISM)
  -> Bengaluru (GalaxEye) -> Bengaluru (Pixxel).

  Requires a free Mapbox access token: https://account.mapbox.com/
  Paste it below. No credit card is required for the free tier of map loads.
*/
mapboxgl.accessToken = "PASTE_YOUR_MAPBOX_TOKEN_HERE";

const STOPS = [
  {
    id: "india",
    intro: true,
    center: [82.8, 22.6],
    zoom: 4.1,
    pitch: 0,
    bearing: 0,
    heading: "Swapnil Kumar Goel",
    subheading: "Image processing engineer working across GIS, SAR and hyperspectral imaging. Scroll to follow the journey.",
  },
  {
    id: "mgkvp",
    arc: false,
    curve: 1.5,
    flyDuration: 3200,
    // Mahatma Gandhi Kashi Vidyapeeth, Chetganj campus, Varanasi
    center: [82.9895, 25.3212],
    zoom: 17,
    pitch: 60,
    bearing: -20,
    place: "Varanasi, Uttar Pradesh",
    title: "Mahatma Gandhi Kashi Vidyapeeth",
    role: "Bachelor's Degree, Physics & Mathematics",
    period: "Aug 2019 – Mar 2022",
    bullets: ["GPA: 8.05", "Foundation in physics and mathematics"],
  },
  {
    id: "ism",
    arc: true,
    flyDuration: 4200,
    // IIT (Indian School of Mines), Dhanbad
    center: [86.4419, 23.8133],
    zoom: 16.4,
    pitch: 60,
    bearing: 30,
    place: "Dhanbad, Jharkhand",
    title: "IIT (Indian School of Mines), Dhanbad",
    role: "Master's Degree, Applied Geophysics",
    period: "Aug 2022 – May 2025",
    bullets: ["GPA: 8.27", "Fieldwork and thesis in geophysical exploration"],
  },
  {
    id: "galaxeye",
    arc: true,
    flyDuration: 4200,
    // GalaxEye Space – KIADB Defence Aerospace Park, Devanahalli (approximate)
    center: [77.715, 13.2437],
    zoom: 16.2,
    pitch: 55,
    bearing: 0,
    place: "Bengaluru, Karnataka",
    title: "GalaxEye Space",
    role: "Signal Processing Intern",
    period: "May 2025 – Nov 2025",
    bullets: [
      "SAR autofocus algorithms",
      "SAR image registration algorithms",
      "Geocoding and coregistration",
      "SAR image quality automation",
    ],
  },
  {
    id: "pixxel",
    arc: false,
    curve: 1,
    flyDuration: 2200,
    // Pixxel – HBR Layout, Bengaluru (approximate)
    center: [77.6465, 13.0191],
    zoom: 16.8,
    pitch: 55,
    bearing: 0,
    place: "Bengaluru, Karnataka",
    title: "Pixxel",
    role: "Associate Image Processing Engineer",
    period: "Nov 2025 – Present",
    bullets: [
      "Built a web GIS and an error-monitoring dashboard",
      "Georeferencing of hyperspectral images",
      "Band alignment and mosaic creation",
      "Auto-clipping images to AOI",
      "QA/QC of hyperspectral images",
      "Built 2 QGIS plugins for hyperspectral analysis",
    ],
  },
];

const journeySection = document.getElementById("journey");

function initJourney() {
  if (!journeySection) return;

  const isReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallScreen = window.matchMedia("(max-width: 768px)").matches;
  const isLowPower = isReducedMotion || isSmallScreen;

  if (typeof mapboxgl === "undefined" || !mapboxgl.supported()) {
    journeySection.classList.add("journey--fallback");
    renderFallback();
    return;
  }

  buildStepEls();

  const map = new mapboxgl.Map({
    container: "journey-map",
    style: "mapbox://styles/mapbox/standard",
    projection: "globe",
    center: STOPS[0].center,
    zoom: STOPS[0].zoom,
    pitch: STOPS[0].pitch,
    bearing: STOPS[0].bearing,
    interactive: false,
    attributionControl: false,
  });

  let mapReady = false;
  let flightFrameId = null;
  let currentIndex = -1;

  map.on("style.load", () => {
    map.setConfigProperty("basemap", "lightPreset", "night");
  });

  map.on("load", () => {
    map.addSource("mapbox-dem", {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14,
    });
    map.setTerrain({ source: "mapbox-dem", exaggeration: isLowPower ? 1 : 1.3 });

    if (!map.getLayer("sky")) {
      map.addLayer({
        id: "sky",
        type: "sky",
        paint: { "sky-type": "atmosphere", "sky-atmosphere-sun-intensity": 10 },
      });
    }

    map.setFog({
      color: "rgb(20, 20, 30)",
      "high-color": "rgb(10, 10, 25)",
      "horizon-blend": 0.02,
      "space-color": "rgb(4, 4, 10)",
      "star-intensity": 0.4,
    });

    mapReady = true;
    goToStep(0);
  });

  function goToStep(index) {
    if (index === currentIndex || index < 0 || index >= STOPS.length) return;
    const prev = currentIndex >= 0 ? STOPS[currentIndex] : null;
    const stop = STOPS[index];
    currentIndex = index;

    updateProgress(index);
    renderCard(stop);

    if (!mapReady) return;
    cancelFlight();
    map.stop();

    if (prev && stop.arc && !isLowPower) {
      runArcFlight(prev, stop);
    } else {
      map.flyTo({
        center: stop.center,
        zoom: stop.zoom,
        pitch: isLowPower ? Math.min(stop.pitch, 45) : stop.pitch,
        bearing: stop.bearing,
        duration: stop.flyDuration || 2800,
        curve: stop.curve ?? 1.42,
        essential: true,
      });
    }
  }

  function cancelFlight() {
    if (flightFrameId) {
      cancelAnimationFrame(flightFrameId);
      flightFrameId = null;
    }
  }

  function runArcFlight(prev, stop) {
    const duration = stop.flyDuration || 4000;
    const from = { center: prev.center, zoom: prev.zoom, pitch: prev.pitch, bearing: prev.bearing };
    const to = { center: stop.center, zoom: stop.zoom, pitch: stop.pitch, bearing: stop.bearing };
    const control = bowControlPoint(from.center, to.center);
    const apexZoom = 4.5;
    const startTime = performance.now();

    function frame(now) {
      const raw = Math.min(1, (now - startTime) / duration);
      const t = easeInOutCubic(raw);

      const lng = bezier1D(from.center[0], control.lng, to.center[0], t);
      const lat = bezier1D(from.center[1], control.lat, to.center[1], t);
      const zoom = bezier1D(from.zoom, apexZoom, to.zoom, t);
      const pitch = bezier1D(from.pitch, 0, to.pitch, t);
      const bearing = lerpAngle(from.bearing, to.bearing, t);

      map.jumpTo({ center: [lng, lat], zoom, pitch, bearing });

      if (raw < 1) {
        flightFrameId = requestAnimationFrame(frame);
      } else {
        flightFrameId = null;
      }
    }

    flightFrameId = requestAnimationFrame(frame);
  }

  function buildStepEls() {
    const track = document.getElementById("journey-steps");
    STOPS.forEach((stop, i) => {
      const step = document.createElement("div");
      step.className = "journey-step";
      step.dataset.index = String(i);
      track.appendChild(step);
    });

    const progress = document.getElementById("journey-progress");
    STOPS.forEach((stop, i) => {
      const dot = document.createElement("li");
      dot.className = "journey-progress__dot";
      dot.dataset.index = String(i);
      dot.setAttribute("role", "button");
      dot.setAttribute("aria-label", stop.title || stop.heading || `Step ${i + 1}`);
      dot.addEventListener("click", () => {
        const target = track.children[i];
        if (target) target.scrollIntoView({ behavior: isLowPower ? "auto" : "smooth", block: "center" });
      });
      progress.appendChild(dot);
    });

    if (typeof scrollama === "undefined") return;

    const scroller = scrollama();
    scroller
      .setup({
        step: ".journey-step",
        offset: 0.6,
      })
      .onStepEnter(({ index }) => goToStep(index));

    window.addEventListener("resize", () => scroller.resize());
  }

  function updateProgress(index) {
    document.querySelectorAll(".journey-progress__dot").forEach((dot) => {
      dot.classList.toggle("is-active", Number(dot.dataset.index) === index);
    });
  }

  function renderCard(stop) {
    const card = document.getElementById("journey-card");
    if (!card) return;

    if (stop.intro) {
      card.innerHTML = `
        <h2 class="journey-card__heading">${stop.heading}</h2>
        <p class="journey-card__subheading">${stop.subheading}</p>
      `;
    } else {
      card.innerHTML = `
        <span class="journey-card__place">${stop.place}</span>
        <h3 class="journey-card__title">${stop.title}</h3>
        <p class="journey-card__role">${stop.role}</p>
        <p class="journey-card__period">${stop.period}</p>
        <ul class="journey-card__bullets">
          ${stop.bullets.map((b) => `<li>${b}</li>`).join("")}
        </ul>
      `;
    }
    card.classList.add("is-visible");
  }
}

function renderFallback() {
  const track = document.getElementById("journey-steps");
  STOPS.forEach((stop) => {
    const card = document.createElement("div");
    card.className = "journey-step journey-step--static";
    if (stop.intro) {
      card.innerHTML = `<h2 class="journey-card__heading">${stop.heading}</h2><p class="journey-card__subheading">${stop.subheading}</p>`;
    } else {
      card.innerHTML = `
        <span class="journey-card__place">${stop.place}</span>
        <h3 class="journey-card__title">${stop.title}</h3>
        <p class="journey-card__role">${stop.role}</p>
        <p class="journey-card__period">${stop.period}</p>
        <ul class="journey-card__bullets">${stop.bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
      `;
    }
    track.appendChild(card);
  });
}

function bezier1D(p0, p1, p2, t) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function bowControlPoint(from, to) {
  const midLng = (from[0] + to[0]) / 2;
  const midLat = (from[1] + to[1]) / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dist = Math.hypot(dx, dy) || 1;
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const bow = dist * 0.18;
  return { lng: midLng + perpX * bow, lat: midLat + perpY * bow };
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

initJourney();
