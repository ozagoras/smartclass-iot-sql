let chart;
const socket = io();  // 🔌 connect to backend WebSocket
let currentClass = null;
socket.on('connect', () => console.log('✅ Connected to server via WebSocket'));
socket.on('disconnect', () => console.log('🔴 Disconnected'));
socket.on('newData', () => {
    console.log('🔄 New data detected → refreshing dashboard');
    fetchSensorData(); // auto refresh UI
    if (currentClass) loadHistory(currentClass); // 🔥 refresh chart as well
    updateLastRefresh();
});

// your existing functions (fetchSensorData, renderCards, etc.)
async function fetchSensorData() {
    try {
        const res = await fetch('/api/getdata');
        const sensors = await res.json();

        // 🧱 Render the main cards
        renderCards(sensors);

        // 🧭 Update dropdown options
        populateClassList(sensors);

        // 🧠 If no class selected yet, auto-pick the first active (or first available)
        if (!currentClass) {
            const firstActive = sensors.find(s => !s.closed);
            const firstAvailable = sensors[0];
            if (firstActive) currentClass = firstActive.room;
            else if (firstAvailable) currentClass = firstAvailable.room;
        }

        // 🎯 If we have a class to display, sync dropdown & show graph
        if (currentClass) {
            const select = document.getElementById("classSelect");
            if (select) select.value = currentClass;
            loadHistory(currentClass);
            console.log(`📊 Default graph loaded for: ${currentClass}`);
        }
    } catch (err) {
        console.error('❌ Failed to fetch data:', err);
    }
    updateLastRefresh();
}
function updateLastRefresh() {
  const now = new Date();
  const formatted = now.toLocaleString([], { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    hour12: false 
  });
  document.getElementById("refresh-status").innerText = `Last update: ${formatted}`;
}


function renderCards(sensors) {
    const container = document.getElementById("cards");
    const active = sensors.filter(s => !s.closed);
    const closed = sensors.filter(s => s.closed);

    container.innerHTML = "";

    if (active.length) {
        container.innerHTML += `<h2>Active Classes</h2>`;
        active.forEach(sensor => container.appendChild(createCard(sensor)));
    }

    if (closed.length) {
        container.innerHTML += `<h2>Closed Classes</h2>`;
        closed.forEach(sensor => container.appendChild(createCard(sensor)));
    }
}

function createCard(sensor) {
    const card = document.createElement("div");
    card.classList.add("sensor-card");
    if (sensor.closed) card.classList.add("closed");

    card.innerHTML = `
  <div class="room-header">
    <span class="status-dot ${sensor.closed ? "closed" : "online"}"></span>
    <h3>${sensor.room}</h3>
    ${sensor.closed ? "<span class='closed-tag'>Closed</span>" : ""}
  </div>
  <div class="temp-value">
    <i class="fa-solid fa-temperature-three-quarters"></i>
    ${sensor.closed ? "--" : sensor.temp.toFixed(1)}°C
  </div>
  <div class="details">
    ${sensor.closed
            ? "<p>No recent data (class ended)</p>"
            : `
        <p><i class="fa-solid fa-droplet"></i> ${sensor.hum.toFixed(1)}%</p>
        <p><i class="fa-solid fa-wave-square"></i> Feels Like: ${sensor.feels.toFixed(1)}°C</p>`
        }
  </div>
`;

    return card;
}
function populateClassList(sensors) {
    const select = document.getElementById("classSelect");
    if (!select) return;

    // 🧱 Build the dropdown dynamically
    select.innerHTML = sensors
        .map(s => `<option value="${s.room}">${s.room}</option>`)
        .join('');

    // 🧭 Keep the dropdown selection consistent
    if (currentClass && sensors.some(s => s.room === currentClass)) {
        select.value = currentClass;
    } else if (sensors.length > 0) {
        select.value = sensors[0].room;
        currentClass = select.value;
    }

    // 🧩 Change handler: when user selects another class
    select.onchange = () => {
        currentClass = select.value;
        loadHistory(currentClass);
        console.log(`🔁 User selected: ${currentClass}`);
    };
}


async function loadHistory(className) {
  try {
    const res = await fetch(`/api/history?class_name=${encodeURIComponent(className)}`);
    const data = await res.json();

    if (!data.length) {
      console.warn("No data found for", className);
      return;
    }

    const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    }));
    const temps = data.map(d => d.temperature);
    const hums = data.map(d => d.humidity);

    document.getElementById("chart-title").innerText = `📈 ${className} History`;

    const ctx = document.getElementById('historyChart').getContext('2d');

    // 🔁 If chart exists, just update the data
    if (window.chart) {
      window.chart.data.labels = labels;
      window.chart.data.datasets[0].data = temps;
      window.chart.data.datasets[1].data = hums;
      window.chart.update();
      return;
    }

    // 🆕 Create new Chart instance
    window.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '🌡️ Temperature (°C)',
            data: temps,
            borderColor: '#ff5722',
            backgroundColor: 'rgba(255, 87, 34, 0.15)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 5
          },
          {
            label: '💧 Humidity (%)',
            data: hums,
            borderColor: '#2196f3',
            backgroundColor: 'rgba(33, 150, 243, 0.15)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#1f2b46',
              usePointStyle: true,
              pointStyle: 'circle',
              font: { size: 13 }
            }
          },
          tooltip: {
            backgroundColor: '#1f2b46',
            titleFont: { size: 13, weight: 'bold' },
            bodyFont: { size: 12 },
            callbacks: {
              label: function (context) {
                const label = context.dataset.label || '';
                const value = context.parsed.y;
                const unit = label.includes('Humidity') ? '%' : '°C';
                return `${label}: ${value.toFixed(1)} ${unit}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#555', maxTicksLimit: 6 },
            grid: { color: '#e5e7eb' }
          },
          y: {
            ticks: { color: '#555' },
            grid: { color: '#e5e7eb' }
          }
        }
      }
    });
  } catch (err) {
    console.error("❌ Error loading chart:", err);
  }
}



fetchSensorData();
setInterval(fetchSensorData, 5000);


