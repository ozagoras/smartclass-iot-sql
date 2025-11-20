/* ==========================================================
   SMARTCLASS DASHBOARD — FINAL VERSION (FLOW TOGGLE + CARD SELECT)
   ========================================================== */

let tempChart = null;
let humChart = null;
let co2Chart = null;

let currentClass = null;
let userSelected = false;

let flowEnabled = false; // global flag

const socket = io();

/* ==========================================================
   WEBSOCKET — RECEIVE DATA IN REALTIME
   ========================================================== */
socket.on("newData", async (roomName) => {
  console.log("📡 Incoming data from:", roomName);

  const res = await fetch("/api/getdata");
  const sensors = await res.json();

  const allClosed = sensors.every(s => s.closed);

  // Auto switch ONLY if all were closed
  if (allClosed) {
    console.log("🟢 Auto-switch →", roomName);
    currentClass = roomName;
    userSelected = false;
  }

  loadDashboard();
});

/* ==========================================================
   WEBSOCKET — ALARM
   ========================================================== */
socket.on("alarm", (alarm) => {
  if (alarm.room === currentClass) {
    showAlarm(alarm);
  }
});

async function toggleAllFlow() {
  const btn = document.getElementById("flow-toggle-btn");

  // Toggle
  flowEnabled = !flowEnabled;

  console.log("Sending enable =", flowEnabled);

  // Send EXACT field name expected by server
  await fetch("/api/flow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enable: flowEnabled })   // <-- FIXED
  });

  // Button UI
  if (flowEnabled) {
    btn.textContent = "Disable Flow";
    btn.classList.add("on");
    btn.classList.remove("off");
  } else {
    btn.textContent = "Enable Flow";
    btn.classList.add("off");
    btn.classList.remove("on");
  }
}




/* ==========================================================
   ALARM LOAD / DISPLAY
   ========================================================== */
async function loadClassAlarm(room) {
  const res = await fetch(`/api/alarm?room=${room}`);
  const alarm = await res.json();
  showAlarm(alarm);
}

function showAlarm(alarm) {
  const box = document.getElementById("class-alarm");
  if (!box) return;

  if (alarm.active) {
    box.textContent = `🚨 ${alarm.message}`;
    box.classList.remove("alarm-hidden");
    box.classList.add("alarm-visible");
  } else {
    box.classList.add("alarm-hidden");
    box.classList.remove("alarm-visible");
  }
}

/* ==========================================================
   GLOBAL FLOW BUTTON
   ========================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("flow-toggle-btn");

  // Always start visually as ENABLED (green)
  btn.classList.add("on");
  btn.textContent = "Disable Flow"; 
  flowEnabled = true;  

  btn.addEventListener("click", async () => {

    // Toggle state
    flowEnabled = !flowEnabled;

    console.log("🌐 Sending global flow status:", flowEnabled);

    // Send correct field name to server  (THIS FIXES UNDEFINED)
    await fetch("/api/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable: flowEnabled })
    });

    // Update button appearance
    if (flowEnabled) {
      btn.textContent = "Disable Flow";
      btn.classList.remove("off");
      btn.classList.add("on");  // green
    } else {
      btn.textContent = "Enable Flow";
      btn.classList.remove("on");
      btn.classList.add("off"); // red
    }
  });
});


/* ==========================================================
   PASSIVE REFRESH (never changes selected class)
   ========================================================== */
setInterval(loadDashboard, 5000);

/* ==========================================================
   LOAD EVERYTHING
   ========================================================== */
loadDashboard();

async function loadDashboard() {
  try {
    const res = await fetch("/api/getdata");
    const sensors = await res.json();

    renderCards(sensors);

    if (!currentClass && sensors.length > 0) {
      currentClass = sensors[0].room;
    }

    highlightSelectedCard(currentClass);

    if (currentClass) {
      loadHistory(currentClass);
    }

  } catch (err) {
    console.error(err);
  }

  updateLastRefresh();
}

/* ==========================================================
   CLOCK
   ========================================================== */
function updateLastRefresh() {
  const now = new Date();
  document.getElementById("refresh-status").textContent =
    `Last update: ${now.toLocaleTimeString([], { hour12: false })}`;
}

/* ==========================================================
   RENDER CARDS
   ========================================================== */
function renderCards(sensors) {
  const container = document.getElementById("cards");
  container.innerHTML = "";

  const active = sensors.filter(s => !s.closed);
  const closed = sensors.filter(s => s.closed);

  if (active.length) {
    container.innerHTML += `<h2>Active Classes</h2>`;
    active.forEach(s => container.appendChild(createCard(s)));
  }

  if (closed.length) {
    container.innerHTML += `<h2>Closed Classes</h2>`;
    closed.forEach(s => container.appendChild(createCard(s)));
  }

  highlightSelectedCard(currentClass);
}

function createCard(s) {
  const card = document.createElement("div");
  card.classList.add("sensor-card", s.closed ? "closed" : "online");
  card.setAttribute("data-room", s.room);

  card.innerHTML = `
    <div class="room-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="status-dot glow ${s.closed ? "closed" : "online"}"></span>
        <h3>${s.room}</h3>
      </div>
      <span class="status-chip ${s.closed ? "offline" : "online"}">
        ${s.closed ? "🔴 Offline" : "🟢 Online"}
      </span>
    </div>

    <div class="temp-value">${s.closed ? "--" : s.temp.toFixed(1)}°C</div>

    <div class="details">
      ${s.closed
      ? "<p>No recent data</p>"
      : `<p>${s.hum.toFixed(1)}% humidity</p>
           <p>Feels like: ${s.feels.toFixed(1)}°C</p>`
    }
    </div>
  `;

  return card;
}

/* ==========================================================
   CARD CLICK HANDLER
   ========================================================== */
document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("cards");

  container.addEventListener("click", (e) => {
    const card = e.target.closest(".sensor-card");
    if (!card) return;

    const room = card.getAttribute("data-room");
    if (!room) return;

    currentClass = room;
    userSelected = true;

    highlightSelectedCard(room);
    loadHistory(room);
  });
});

/* ==========================================================
   HIGHLIGHT SELECTED CLASS
   ========================================================== */
function highlightSelectedCard(room) {
  const cards = document.querySelectorAll(".sensor-card");
  cards.forEach(c => c.classList.remove("selected-card"));

  const active = [...cards].find(
    c => c.getAttribute("data-room") === room
  );

  if (active) active.classList.add("selected-card");
}

/* ==========================================================
   HISTORY + CHART LOADING
   ========================================================== */
async function loadHistory(className) {
  await loadClassAlarm(className);

  const res = await fetch(`/api/history?class_name=${className}`);
  const data = await res.json();

  const labels = data.map(d =>
    new Date(d.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );

  const temps = data.map(d => d.temperature);
  const hums = data.map(d => d.humidity);
  const co2s = data.map(d => d.co2);

  buildTempChart(labels, temps);
  buildHumChart(labels, hums);
  buildCo2Chart(labels, co2s);
}

/* ==========================================================
   CHART HELPERS
   ========================================================== */
function createGradient(ctx, c1, c2) {
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  return g;
}

function firstPoint(ctx, color) {
  return {
    radius: ctx.dataIndex === 0 ? 5 : 0,
    hoverRadius: 6,
    backgroundColor: "#fff",
    borderColor: color,
    borderWidth: 2
  };
}

/* ==========================================================
   TEMP CHART
   ========================================================== */
function buildTempChart(labels, temps) {
  const ctx = document.getElementById("tempChart").getContext("2d");
  const color = "#3F88F8";

  if (!tempChart) {
    tempChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Temperature",
          data: temps,
          borderColor: color,
          backgroundColor: createGradient(ctx, "rgba(63,136,248,0.35)", "rgba(63,136,248,0.02)"),
          fill: true,
          tension: 0.45,
          borderWidth: 3,
          borderDash: [6, 6],
          pointRadius: (c) => firstPoint(c, color).radius,
          pointHoverRadius: (c) => firstPoint(c, color).hoverRadius,
          pointBackgroundColor: (c) => firstPoint(c, color).backgroundColor,
          pointBorderColor: (c) => firstPoint(c, color).borderColor,
          pointBorderWidth: (c) => firstPoint(c, color).borderWidth,
        }]
      },
      options: chartOptions("°C")
    });
  } else {
    tempChart.data.labels = labels;
    tempChart.data.datasets[0].data = temps;
    tempChart.update();
  }
}

/* ==========================================================
   HUMIDITY CHART
   ========================================================== */
function buildHumChart(labels, hums) {
  const ctx = document.getElementById("humChart").getContext("2d");
  const color = "#B388FF";

  if (!humChart) {
    humChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Humidity",
          data: hums,
          borderColor: color,
          backgroundColor: createGradient(ctx, "rgba(179,136,255,0.35)", "rgba(179,136,255,0.02)"),
          fill: true,
          tension: 0.45,
          borderDash: [6, 6],
          borderWidth: 3,
          pointRadius: (c) => firstPoint(c, color).radius,
          pointHoverRadius: (c) => firstPoint(c, color).hoverRadius,
          pointBackgroundColor: (c) => firstPoint(c, color).backgroundColor,
          pointBorderColor: (c) => firstPoint(c, color).borderColor,
          pointBorderWidth: (c) => firstPoint(c, color).borderWidth
        }]
      },
      options: chartOptions("%")
    });
  } else {
    humChart.data.labels = labels;
    humChart.data.datasets[0].data = hums;
    humChart.update();
  }
}

/* ==========================================================
   CO₂ CHART
   ========================================================== */
function buildCo2Chart(labels, co2s) {
  const ctx = document.getElementById("co2Chart").getContext("2d");
  const color = "#66BB6A";

  if (!co2Chart) {
    co2Chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "CO₂",
          data: co2s,
          borderColor: color,
          backgroundColor: createGradient(ctx, "rgba(102,187,106,0.35)", "rgba(102,187,106,0.02)"),
          fill: true,
          tension: 0.45,
          borderDash: [6, 6],
          borderWidth: 3,
          pointRadius: (c) => firstPoint(c, color).radius,
          pointHoverRadius: (c) => firstPoint(c, color).hoverRadius,
          pointBackgroundColor: (c) => firstPoint(c, color).backgroundColor,
          pointBorderColor: (c) => firstPoint(c, color).borderColor,
          pointBorderWidth: (c) => firstPoint(c, color).borderWidth
        }]
      },
      options: chartOptions("ppm")
    });
  } else {
    co2Chart.data.labels = labels;
    co2Chart.data.datasets[0].data = co2s;
    co2Chart.update();
  }
}

/* ==========================================================
   SHARED CHART OPTIONS
   ========================================================== */
function chartOptions(unit) {
  return {
    maintainAspectRatio: false,
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.parsed.y} ${unit}`
        }
      }
    },
    scales: {
      x: {
        ticks: { color: "#666" },
        grid: { color: "rgba(0,0,0,0.05)" }
      },
      y: {
        ticks: { color: "#666" },
        grid: { color: "rgba(0,0,0,0.05)" }
      }
    }
  };
}
