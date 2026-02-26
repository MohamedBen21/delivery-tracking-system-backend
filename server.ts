import { app } from "./app";
import { connectMongo } from "./databases/Mongo.database";
import { connectRedis } from "./databases/Redis.database";
require("dotenv").config();

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  console.log(`app is running on port ${port}`);
  connectMongo();
  connectRedis();
});

process.on("SIGINT", () => {
  server.close(() => {
    console.log("Server closed correctly.");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => {
    console.log("Server closed correctly.");
    process.exit(0);
  });
});
