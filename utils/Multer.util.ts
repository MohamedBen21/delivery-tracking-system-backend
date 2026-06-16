import path from "path";
import fs from "fs";
import { Logger } from "./Logger.util";

export const deleteImage = (relativePath: string): void => {
  const fullPath = path.resolve("src" + relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlink(fullPath, (err) => {
      if (err) {
        Logger.error(`Error deleting file: ${fullPath}`, err);
      } else {
        Logger.info(`Deleted image: ${relativePath}`);
      }
    });
  } else {
    Logger.warn(`File not found: ${relativePath}`);
  }
};
