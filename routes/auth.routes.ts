import express from "express";
import {
  activate,
  changeEmail,
  deleteProfilePicture,
  googleLogin,
  login,
  logout,
  passwordRecovery,
  refreshTokens,
  register,
  resendActivation,
  resetPassword,
  updateProfilePicture,
  updateUser,
} from "../controllers/auth.controller";
import { checkFailedLogins, limiters } from "../middleware/redisRateLimiter";
import { isAuthenticated } from "../middleware/auth";
import { profileImageUpload } from "../middleware/uploadProfile";

const authRouter = express.Router();

authRouter.post("/login", limiters.login, checkFailedLogins, login);

authRouter.post("/register", limiters.register, register);
authRouter.post("/activate", limiters.activate, activate);
authRouter.post(
  "/resend-activation",
  limiters.resendActivation,
  resendActivation,
);
authRouter.post(
  "/password-recovery",
  limiters.passwordRecovery,
  passwordRecovery,
);
authRouter.post("/reset-password", resetPassword);
authRouter.post("/refresh", refreshTokens);
authRouter.post("/google", googleLogin);

authRouter.post("/logout", isAuthenticated, logout);
authRouter.put("/update", isAuthenticated, limiters.emailChange, updateUser);
authRouter.post("/change-email", changeEmail);
authRouter.put(
  "/profile-picture",
  isAuthenticated,
  profileImageUpload,
  updateProfilePicture,
);
authRouter.delete("/profile-picture", isAuthenticated, deleteProfilePicture);

export default authRouter;
