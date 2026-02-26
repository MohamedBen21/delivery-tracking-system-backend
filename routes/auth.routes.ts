import express from "express";
import {
  activate,
  login,
  logout,
  passwordRecovery,
  register,
  resetPassword,
  refreshTokens,
  updateUser,
  changeEmail,
  googleLogin,
  resendActivation,
} from "../controllers/auth.controller";
import { checkFailedLogins, limiters } from "../middleware/redisRateLimiter";

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
authRouter.post("/logout", logout);
authRouter.post("/google", googleLogin);

authRouter.put("/update", limiters.emailChange, updateUser);
authRouter.post("/change-email", changeEmail);

export default authRouter;
