import { getRedisClient } from "../databases/Redis.database";
import { Logger } from "../utils/Logger.util";
import { dbConf } from "../conifg/db.conf";



const hashKey  = (role: string, userId: string) => `presence:${role}:${userId}`;
const setKey   = (role: string)                 => `presence:${role}:online`;

const TTL = (): number =>
  parseInt(process.env.HEARTBEAT_TIMEOUT_SECONDS ?? "180", 10);



export class PresenceService {

  static async setOnline(userId: string, role: string): Promise<void> {
    try {
      const redis     = getRedisClient();
      const ttl       = TTL();
      const now       = new Date().toISOString();
      const pipeline  = redis.pipeline();

      pipeline.hset(hashKey(role, userId), "lastActiveAt", now);
      pipeline.expire(hashKey(role, userId), ttl);
      pipeline.sadd(setKey(role), userId);

      await pipeline.exec();
      Logger.info(`[Presence] setOnline  role=${role} userId=${userId} ttl=${ttl}s`);
    } catch (err: any) {
      Logger.error(`[Presence] setOnline error: ${err.message}`);
      throw err;
    }
  }


  static async setOffline(userId: string, role: string): Promise<void> {
    try {
      const redis    = getRedisClient();
      const pipeline = redis.pipeline();

      pipeline.del(hashKey(role, userId));
      pipeline.srem(setKey(role), userId);

      await pipeline.exec();
      Logger.info(`[Presence] setOffline role=${role} userId=${userId}`);
    } catch (err: any) {
      Logger.error(`[Presence] setOffline error: ${err.message}`);
      throw err;
    }
  }



  static async updateHeartbeat(userId: string, role: string): Promise<boolean> {
    try {
      const redis    = getRedisClient();
      const ttl      = TTL();
      const now      = new Date().toISOString();
      const pipeline = redis.pipeline();

      pipeline.hset(hashKey(role, userId), "lastActiveAt", now);
      pipeline.expire(hashKey(role, userId), ttl);

      pipeline.sadd(setKey(role), userId);

      await pipeline.exec();
      return true;
    } catch (err: any) {
      Logger.error(`[Presence] updateHeartbeat error: ${err.message}`);
      return false;
    }
  }


  static async isOnline(userId: string, role: string): Promise<boolean> {
    try {
      const redis  = getRedisClient();
      const exists = await redis.exists(hashKey(role, userId));
      return exists === 1;
    } catch (err: any) {
      Logger.error(`[Presence] isOnline error: ${err.message}`);
      return false;
    }
  }



  static async getAllOnline(role: string): Promise<string[]> {
    try {
      const redis  = getRedisClient();
      const members = await redis.smembers(setKey(role));
      return members;
    } catch (err: any) {
      Logger.error(`[Presence] getAllOnline error: ${err.message}`);
      return [];
    }
  }


  static async getLastActive(userId: string, role: string): Promise<string | null> {
    try {
      const redis = getRedisClient();
      return await redis.hget(hashKey(role, userId), "lastActiveAt");
    } catch (err: any) {
      Logger.error(`[Presence] getLastActive error: ${err.message}`);
      return null;
    }
  }

 
  static async ping(): Promise<boolean> {
    try {
      const redis  = getRedisClient();
      const result = await redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }
}