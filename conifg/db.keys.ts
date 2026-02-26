function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const isProd = process.env.NODE_ENV === "production";

export interface DbKeys {
  mongodb: {
    uri: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
}

export const dbKeys: DbKeys = {
  mongodb: {
    uri: isProd
      ? getRequiredEnv("MONGODB_URI")
      : process.env.MONGODB_URI || "mongodb://localhost:27017/delivery_app",
  },
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || "",
  },
};
