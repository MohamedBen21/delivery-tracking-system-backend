import multer from "multer";

/** Memory upload for profile picture field `image` (max 5 MB). */
export const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single("image");
