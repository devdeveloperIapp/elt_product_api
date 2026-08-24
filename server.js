const express = require('express')
const app = express();
const http = require('http');           // ✅ ADD
const { Server } = require('socket.io'); // ✅ ADD
const path = require("path");
const dotenv = require('dotenv').config();
const cors = require('cors');
const { mainDB } = require('./connection/dbConnection');
// ✅ Boot warehouse v2 transformers (registers quickbooks/zohobooks/shopify pipelines)
require('./services/warehouse');
// ✅ Start QB data cleanup scheduler (hard-deletes soft-deleted records after 30 days)
const { startCleanupScheduler } = require('./services/cleanupService');
startCleanupScheduler();
// ✅ Start QB auto-sync scheduler (runs company syncs on their configured schedule)
const { startSyncScheduler } = require('./services/syncSchedulerService');
startSyncScheduler();
const route = require('./router/route');
const jwt = require('jsonwebtoken');
const webhookRoutes = require('./router/webhookRoutes');
const dashboardRoutes = require('./router/dashboardRoutes');

mainDB.authenticate()
  .then(() => console.log("database connected"))
  .catch((error) => console.log("Something went wrong\n", error));

const allowedOrigins = [
  'http://154.53.63.157:7005',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:7005',
  'https://stages-scanning-profession-brain.trycloudflare.com',
  'https://according-fluid-concluded-joke.trycloudflare.com',
  'https://glossiest-comparingly-dann.ngrok-free.dev'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));




app.use((req, res, next) => {
  console.log(`🚀 ${req.method} ${req.originalUrl}`);
  next();
});



app.use('/api/webhook/quickbooks', 
  express.raw({ type: '*/*' })
);

app.use('/api/webhook', webhookRoutes);
app.use('/api', dashboardRoutes);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', route);

app.use("/source_excel_files",
  express.static(path.join(__dirname, "public/source_excel_files")));
app.use("/destination_excel_files",
  express.static(path.join(__dirname, "public/destination_excel_files")));

// ✅ HTTP server banao
const server = http.createServer(app);

// ✅ Socket.io attach karo
const io = new Server(server, {
  cors: {
    origin: "*",           // ✅ sab allow
    methods: ["GET", "POST"],
    credentials: false     // ✅ * ke saath false hona chahiye
  },
  transports: ['polling', 'websocket'] // ✅ polling allow karo
});

// ✅ Global io — WebhookController use karega
global.io = io;

io.on('connection', (socket) => {
  console.log('[WS] Client connected:', socket.id);

  // Frontend company room join karega
  socket.on('join_company', (companyId) => {
    socket.join(`company_${companyId}`);
    console.log(`[WS] Client joined company_${companyId}`);
  });

  socket.on('disconnect', () => {
    console.log('[WS] Client disconnected:', socket.id);
  });
});

// ✅ app.listen ki jagah server.listen
server.listen(process.env.PORT, () =>
  console.log(`Server is Connected on ${process.env.BASE_URL}`)
);