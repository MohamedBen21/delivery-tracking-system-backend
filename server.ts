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
import { setupTrackingRoutes } from './routes/tracking.route';
import { ErrorMiddleware } from "./middleware/errors"; 
import { NextFunction, Request, Response } from "express"; 

const port = process.env.PORT || 8080;

async function bootstrap() {

  configureCloudinary();
  
  await connectMongo();
  connectRedis();

  startStalePresenceCleanup();

  const httpServer = createServer(app);
  

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.ORIGIN || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    },

    pingTimeout: 20000,
    pingInterval: 25000,
    transports: ["websocket"],
    allowUpgrades: true,
    upgradeTimeout: 10000,

  });
  

  io.use(socketAuth);
  

  const socketService = new SocketService(io);
  

  (global as any).socketService = socketService;


  app.use("/api", setupTrackingRoutes(socketService));


  app.all("*", (req: Request, res: Response, next: NextFunction) => {
    const err = new Error(`route ${req.originalUrl} not found :(`) as any;
    err.statusCode = 404;
    next(err);
  });
  
  app.use(ErrorMiddleware);

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