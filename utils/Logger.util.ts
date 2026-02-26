// utils/Logger.util.ts

export class Logger {
  private static getTimestamp(): string {
    return new Date().toISOString();
  }

  static info(...messages: unknown[]): void {
    console.log(`[INFO] ${this.getTimestamp()} -`, ...messages);
  }

  static warn(...messages: unknown[]): void {
    console.warn(`[WARN] ${this.getTimestamp()} -`, ...messages);
  }

  static error(...messages: unknown[]): void {
    console.error(`[ERROR] ${this.getTimestamp()} -`, ...messages);
  }
}
