require("dotenv").config(); 

import { app } from "./app";
import { configureCloudinary } from "./conifg/cloudinary.conf";
import { connectMongo } from "./databases/Mongo.database";
import { connectRedis } from "./databases/Redis.database";
import { startScheduler } from "./route_planning/scheduler";


const port = process.env.PORT || 8080;

async function bootstrap() {

  configureCloudinary();
  
  await connectMongo();
  connectRedis();

  const server = app.listen(port, () => {
    console.log(`App is running on port ${port}`);
    startScheduler();
  });

  function shutdown(signal: string) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(() => {
      console.log("Server closed correctly.");
      process.exit(0);
    });
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});