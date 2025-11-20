/******************************************************************
 * SmartClass Server — CLEAN, STABLE, NON-BLOCKING VERSION
 ******************************************************************/

const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const http = require("http");
const cron = require("node-cron");
const { Server } = require("socket.io");

dotenv.config({ path: "./mysql_config.env" });
let globalFlowEnabled = false;

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server);
// 🔔 ALARMS PER CLASS
let classAlarms = {}; 
// format:
// classAlarms["ClassA"] = { active: true, message: "CO2 high" }

/******************************************************************
 * Load SSL CA ONCE (instead of inside every reconnection)
 ******************************************************************/
let sslCA;
try {
  sslCA = fs.readFileSync("./ca.pem");
  console.log("🔐 SSL CA loaded once");
} catch (e) {
  console.error("❌ Could not load ca.pem:", e);
  process.exit(1);
}

/******************************************************************
 * MySQL STABLE RECONNECT LOGIC (no recursive storms)
 ******************************************************************/
let db;
let reconnecting = false;

function handleDbConnection() {
  if (reconnecting) return; // prevents multiple reconnect loops
  reconnecting = true;

  console.log("🔌 Connecting to Aiven MySQL...");

  db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: sslCA },
    connectTimeout: 8000,
  });

  db.connect((err) => {
    reconnecting = false;

    if (err) {
      console.error("❌ MySQL connection error:", err.code);
      setTimeout(handleDbConnection, 5000);
      return;
    }

    console.log("✅ Connected to Aiven MySQL");

    // Create table once after successful connection
    db.query(
      `
      CREATE TABLE IF NOT EXISTS sensor_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_name VARCHAR(50) NOT NULL,
        temperature FLOAT,
        humidity FLOAT,
        co2 FLOAT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    );
  });

  db.on("error", (err) => {
    console.error("⚠️ MySQL error:", err.code);

    if (err.fatal || err.code === "PROTOCOL_CONNECTION_LOST") {
      console.log("🔄 Reconnecting to MySQL...");
      handleDbConnection();
    }
  });
}

handleDbConnection();

/******************************************************************
 * CRON JOB — Retention Cleanup (Runs every 15 minutes)
 ******************************************************************/
cron.schedule("*/15 * * * *", async () => {
  try {
    const [result] = await db.promise().query(
      "DELETE FROM sensor_data WHERE timestamp < NOW() - INTERVAL 6 HOUR"
    );

    console.log(`🧹 Cleanup: removed ${result.affectedRows} old rows`);
  } catch (err) {
    console.error("❌ Cron cleanup failed:", err.code);
  }
});

/******************************************************************
 * POST /api/data — ESP32 sends sensor readings
 ******************************************************************/
app.post("/api/data", (req, res) => {
  let { class_name, temperature, humidity , co2 } = req.body;

  if (!class_name || temperature == null || humidity == null || co2 == null) {
    return res.status(400).send("Missing fields");
  }

  class_name = class_name === 1 ? "ClassA" : "ClassB";

  const timestamp = new Date();

  const sql =
    "INSERT INTO sensor_data (class_name, temperature, humidity, co2, timestamp) VALUES (?, ?, ?, ?, ?)";

  db.query({ sql, timeout: 3000 }, [class_name, temperature, humidity, co2, timestamp], (err) => {
    if (err) {
      console.error("❌ Insert error:", err.code);
      handleDbConnection(); // no destroy, safe reconnect
      return res.send("OK");
    }

    console.log(`📡 ${class_name}: ${temperature}°C, ${humidity}%, ${co2} ppm`);
    io.emit("newData",class_name);
    res.send("OK");
  });
});

// ESP32 → send an alarm for a specific class
app.post("/api/alarm", (req, res) => {
  const { room, message } = req.body;

  if (!room || !message) {
    return res.status(400).json({ error: "Missing room or message" });
  }

  classAlarms[room] = {
    active: true,
    message,
    timestamp: new Date()
  };

  console.log("🚨 ALARM:", room, message);

  // Notify only the dashboard, not all classes
  io.emit("alarm", { room, message });

  res.json({ status: "OK" });
});

// Dashboard → fetch alarm for a specific class
app.get("/api/alarm", (req, res) => {
  const room = req.query.room;
  res.json(classAlarms[room] || { active: false });
});

/******************************************************************
 * GET /api/getdata — Latest reading per class
 ******************************************************************/
app.get("/api/getdata", (req, res) => {
  const sql = `
    SELECT s1.class_name, s1.temperature, s1.humidity, s1.timestamp, s1.co2
    FROM sensor_data s1
    INNER JOIN (
        SELECT class_name, MAX(timestamp) AS latest
        FROM sensor_data
        GROUP BY class_name
    ) s2 ON s1.class_name = s2.class_name AND s1.timestamp = s2.latest
    ORDER BY s1.class_name
  `;

  db.query({ sql, timeout: 3000 }, (err, results) => {
    if (err) {
      console.error("❌ Query error:", err.code);
      handleDbConnection();
      return res.send("OK");
    }

    const now = Date.now();

    const data = results.map((r) => {
      const diffMinutes = (now - new Date(r.timestamp).getTime()) / 60000;
      return {
        room: r.class_name,
        temp: r.temperature,
        hum: r.humidity,
        feels: calculateFeelsLike(r.temperature, r.humidity),
        timestamp: r.timestamp,
        closed: diffMinutes >= 5,
      };
    });

    res.json(data);
  });
});

// ===============================
// GLOBAL FLOW CONTROL
// ===============================
app.post("/api/flow", async (req, res) => {
  console.log("Global flow control " + JSON.stringify(req.body));
  const { enable } = req.body;

  globalFlowEnabled = enable;
  console.log("🌐 Global flow now :", globalFlowEnabled);
  res.json({ ok: true, globalFlowEnabled });

});
// DASHBOARD → ESP32 reads this
app.get("/api/flow", (req, res) => {
  res.json({ enable: globalFlowEnabled });
});

/******************************************************************
 * GET /api/history — Full history for charts
 ******************************************************************/
app.get("/api/history", (req, res) => {
  const { class_name } = req.query;

  db.query(
    {
      sql: "SELECT temperature, humidity, co2, timestamp FROM sensor_data WHERE class_name = ? ORDER BY timestamp",
      timeout: 3000,
    },
    [class_name || "ClassA"],
    (err, results) => {
      if (err) {
        console.error("❌ History query error:", err.code);
        handleDbConnection();
        return res.send("OK");
      }

      res.json(results);
    }
  );
});

/******************************************************************
 * Feels Like Formula
 ******************************************************************/
function calculateFeelsLike(tempC, humidity) {
  const T = tempC;
  const R = humidity;

  return (
    -8.784695 +
    1.61139411 * T +
    2.338549 * R -
    0.14611605 * T * R -
    0.01230809 * T * T -
    0.01642482 * R * R +
    0.00221173 * T * T * R +
    0.00072546 * T * R * R -
    0.00000358 * T * T * R * R
  );
}

/******************************************************************
 * SOCKET.IO
 ******************************************************************/
io.on("connection", () => {
  console.log("🟢 Dashboard connected");
});

/******************************************************************
 * START SERVER
 ******************************************************************/
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 SmartClass Server running on port ${PORT}`)
);
