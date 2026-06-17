import express from "express";
import {
  activate,
  calculateETA,
  confirmChangeEmail,
  confirmContactChange,
  confirmPasswordReset,
  deleteProfilePicture,
  googleLogin,
  login,
  logout,
  manualRoutePlanning,
  meUser,
  passwordRecovery,
  refreshTokens,
  register,
  requestContactChange,
  requestPasswordReset,
  resendActivation,
  resetPassword,
  resolvePlace,
  reverseGeocodeAddress,
  searchAddress,
  updateProfilePicture,
  updateUser,
  verifyOTP,
} from "../controllers/auth.controller";
import { checkFailedLogins, limiters } from "../middleware/redisRateLimiter";
import { authorizeRoles, isAuthenticated } from "../middleware/auth";
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

authRouter.post("/confirm-email", confirmChangeEmail);

authRouter.put(
  "/profile-picture",
  isAuthenticated,
  profileImageUpload,
  updateProfilePicture,
);

authRouter.delete("/profile-picture", isAuthenticated, deleteProfilePicture);


authRouter.post("/reset-password/request", requestPasswordReset);
authRouter.post("/reset-password/verify-otp", verifyOTP);
authRouter.post("/reset-password/confirm", confirmPasswordReset);

authRouter.get("/me/user", isAuthenticated, meUser);


authRouter.get("/geocode/search", searchAddress);
authRouter.post("/geocode/resolve", resolvePlace);
authRouter.get("/geocode/reverse", reverseGeocodeAddress);


authRouter.post(
  "/calculate-eta",
  isAuthenticated,
  authorizeRoles("deliverer", "transporter"),
  calculateETA,
);


authRouter.post(
  "/change-contact/request",
  isAuthenticated,
  requestContactChange,
);

authRouter.post(
  "/change-contact/confirm",
  isAuthenticated,
  confirmContactChange,
);


authRouter.post(
  "/routes/plan",
  isAuthenticated,
  // authorizeRoles("admin", "manager"),
  manualRoutePlanning
);

export default authRouter;
