require("dotenv").config(); 

import { app } from "./app";
import { configureCloudinary } from "./conifg/cloudinary.conf";
import { connectMongo } from "./databases/Mongo.database";
import { connectRedis } from "./databases/Redis.database";
import { startScheduler } from "./route_planning/scheduler";
import { createServer } from 'http';
import { Server } from 'socket.io';
import { socketAuth } from './middleware/socketAuth';
import { SocketService } from './services/socket.service';
import { startStalePresenceCleanup } from './Cron/cleanupStalePresence.job'; 
import { resolveCorsOrigin } from "./utils/corsOrigin";

const port = process.env.PORT || 8080;

async function bootstrap() {

  configureCloudinary();
  
  await connectMongo();
  connectRedis();


  startStalePresenceCleanup();

  const httpServer = createServer(app);
  

  const io = new Server(httpServer, {
    cors: {
      origin: resolveCorsOrigin(process.env.ORIGIN, "http://localhost:5173"),
      methods: ["GET", "POST"],
      credentials: true
    },

    pingTimeout: 20000,   // disconnect after 20 seconds of no pong from client
    pingInterval: 25000,  // send ping to client every 25 seconds
    transports: ["websocket"], // prefer WebSocket over polling
    allowUpgrades: true,  // allow upgrade from polling to WebSocket
    upgradeTimeout: 10000, // timeout for upgrade to WebSocket (10 seconds)

  });
  

  io.use(socketAuth);
  

  const socketService = new SocketService(io);
  

  (global as any).socketService = socketService;


  const server = httpServer.listen(port, () => {

    console.log(`App is running on port ${port} with Socket.IO support`);
    console.log(`Socket.IO settings: pingTimeout=20s, pingInterval=25s, grace-period=30s`);
    
    startScheduler();
  });

  function shutdown(signal: string) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(() => {
      console.log("Server closed correctly.");
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});