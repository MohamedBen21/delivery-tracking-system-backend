import mongoose from "mongoose";
import { dbKeys } from "../conifg/db.keys";
import { dbConf } from "../conifg/db.conf";
import { Logger } from "../utils/Logger.util";

let mongoConnection: typeof mongoose | null = null;

const originalStartSession = mongoose.startSession.bind(mongoose);
mongoose.startSession = async function (options?: mongoose.ClientSessionOptions) {
  const session = await originalStartSession(options);
  if (process.env.NODE_ENV === "developement" || process.env.NODE_ENV === "development") {
    session.startTransaction = () => {};
    session.commitTransaction = async () => {};
    session.abortTransaction = async () => {};
  }
  return session;
};
export async function connectMongo(): Promise<typeof mongoose> {
  if (mongoConnection) return mongoConnection;
  
  try {
    const conn = await mongoose.connect(dbKeys.mongodb.uri, dbConf.mongodb.options);


    mongoose.connection.on("error", (err) => {
      Logger.error("MongoDB connection error:", err);
      mongoConnection = null;
    });

    mongoose.connection.on("disconnected", () => {
      Logger.warn("MongoDB disconnected, clearing connection cache");
      mongoConnection = null;
    });

    Logger.info("MongoDB connected");
    mongoConnection = conn;
    return conn;
  } catch (error) {
    Logger.error("MongoDB connection error:", error);
    throw error;
  }
}

export function getMongoConnection(): typeof mongoose {
  if (!mongoConnection) {
    throw new Error("MongoDB not connected. Call connectMongo() first.");
  }
  return mongoConnection;
}
