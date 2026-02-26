import { ConnectOptions } from "mongoose";

export interface MongoConfig {
  options: ConnectOptions;
}

export interface RedisConfig {
  sessionTTL: number;
  rateLimitTTL: number;
  connectionTimeout: number;
}

export interface DbConf {
  mongodb: MongoConfig;
  redis: RedisConfig;
}

export const dbConf: DbConf = {
  mongodb: {
    options: {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
      socketTimeoutMS: 45000,
    },
  },
  redis: {
    sessionTTL: 7 * 24 * 60 * 60,
    rateLimitTTL: 15 * 60,
    connectionTimeout: 10_000,
  },
};
