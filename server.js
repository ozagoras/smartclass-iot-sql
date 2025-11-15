const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const http = require('http');
const cron = require('node-cron');
const { Server } = require('socket.io');


dotenv.config({ path: './mysql_config.env' });

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server);

// 🧩 MySQL Connection
let db;

function handleDbConnection() {
  db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync('./ca.pem') },
    connectTimeout: 10000  // 10s connection timeout
  });

  db.connect(err => {
    if (err) {
      console.error('❌ Error connecting to MySQL:', err);
      setTimeout(handleDbConnection, 5000); // retry after 5s
    } else {
      console.log('✅ Connected to Aiven MySQL');
    }
  });

  db.on('error', err => {
  console.error('⚠️ MySQL error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
    console.log('🔄 Reconnecting to MySQL...');
    handleDbConnection();
  } else {
    throw err;
  }
});

 // 🧱 Ensure table exists
  db.query(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    class_name VARCHAR(50) NOT NULL,
    temperature FLOAT,
    humidity FLOAT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
}


handleDbConnection();





// 🧹 Retention cleanup every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const [result] = await db.promise().query(
      'DELETE FROM sensor_data WHERE timestamp < NOW() - INTERVAL 6 HOUR'
    );
    console.log(`🧹 Deleted ${result.affectedRows} old rows`);
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
  }
});


// 📡 ESP32 → POST data
app.post('/api/data', (req, res) => {
  let { class_name, temperature, humidity } = req.body;
  if (!class_name || temperature == null || humidity == null) {
    return res.status(400).send('Missing fields');
  }
  if(class_name !== 1){
    class_name = "ClassB";
  } else {
    class_name = "ClassA";
  }
  const now = Date.now();
  const time = new Date(now);
  const sql = 'INSERT INTO sensor_data (class_name, temperature, humidity, timestamp) VALUES (?, ?, ?, ?)';
  db.query({sql:sql,timeout:7000}, [class_name, temperature, humidity, time], err => {
    if (err) {
      db.destroy();
      handleDbConnection();
      res.send('OK');
    } else {
      console.log(`📡 ${class_name}: ${temperature}°C, ${humidity}%`);
      io.emit('newData'); 
      res.send('OK');
    }
  });
});

// 🟢 Latest data per class (for dashboard)
app.get('/api/getdata', (req, res) => {
  const sql = `
    SELECT s1.class_name, s1.temperature, s1.humidity, s1.timestamp
    FROM sensor_data s1
    INNER JOIN (
      SELECT class_name, MAX(timestamp) AS latest
      FROM sensor_data
      GROUP BY class_name
    ) s2
    ON s1.class_name = s2.class_name AND s1.timestamp = s2.latest
    ORDER BY s1.class_name ASC
  `;

  db.query({sql:sql,timeout:7000}, (err, results) => {
    if (err) {
      console.error('⏰ Query timeout — reconnecting...');
      db.destroy();
      handleDbConnection();
      res.send('OK');
    } else {
      const now = Date.now();
      const data = results.map(r => {
        const lastUpdate = new Date(r.timestamp).getTime();
        const diffMinutes = (now - lastUpdate) / 1000 / 60;
        const closed = diffMinutes >= 5; // 💡 mark offline if >5 min since last update

      return {
        room: r.class_name,
        temp: r.temperature,
        hum: r.humidity,
        feels: calculateFeelsLike(r.temperature, r.humidity),
        timestamp: r.timestamp,
        closed: closed
      };
    });

    res.json(data);
    }
  }); 
});


// 📈 History data (for graphs)
app.get('/api/history', (req, res) => {
  const { class_name } = req.query;
  const sql = `
    SELECT temperature, humidity, timestamp
    FROM sensor_data
    WHERE class_name = ?
    ORDER BY timestamp ASC
  `;
  db.query({sql:sql,timeout:7000}, [class_name || 'ClassA'], (err, results) => {
    if (err) {
      console.error('⏰ Query timeout — reconnecting...');
      db.destroy();
      handleDbConnection();
      res.send('OK');
    } else {
      res.json(results);
    }
  });
});

function calculateFeelsLike(tempC, humidity) {
  const T = tempC;
  const R = humidity;
  const feelsLikeC =
    -8.784695 +
    1.61139411 * T +
    2.338549 * R +
    -0.14611605 * T * R +
    -0.01230809 * T * T +
    -0.01642482 * R * R +
    0.00221173 * T * T * R +
    0.00072546 * T * R * R +
    -0.00000358 * T * T * R * R;

  return feelsLikeC;
}

io.on('connection', socket => {
  console.log('🟢 Dashboard connected');
});

const PORT = 3000;
server.listen(PORT, "0.0.0.0",( ) => console.log(`🚀 SmartClass server running on http://localhost:${PORT}`));
