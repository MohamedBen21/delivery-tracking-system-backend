import mongoose from "mongoose";
import { dbKeys } from "../conifg/db.keys";
import { dbConf } from "../conifg/db.conf";
import { Logger } from "../utils/Logger.util";

let mongoConnection: typeof mongoose | null = null;

export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoConnection) return mongoConnection;

  try {
    const conn = await mongoose.connect(
      dbKeys.mongodb.uri,
      dbConf.mongodb.options,
    );

    Logger.info("✅ MongoDB connected");
    mongoConnection = conn;
    return conn;
  } catch (error) {
    Logger.error("❌ MongoDB connection error:", error);
    throw error;
  }
}

export function getMongoConnection(): typeof mongoose {
  if (!mongoConnection) {
    throw new Error("MongoDB not connected. Call connectMongo() first.");
  }
  return mongoConnection;
}
