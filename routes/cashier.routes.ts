import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  lookupFreelancer,
  claimPackage,
  acceptPackage,
  rejectPackage,
  checkIn,
  checkOut,
  getMyShift,
  getPendingPackages,
  printSingleBordereau,
  printBulkBordereau,
  getPackageByTrackingNumber,
} from "../controllers/cashier.controller";

const cashierRouter = Router();


cashierRouter.use(isAuthenticated, authorizeRoles("cashier"));


cashierRouter.post("/check-in", checkIn);
cashierRouter.post("/check-out", checkOut);
cashierRouter.get("/my-shift", getMyShift);


cashierRouter.get("/freelancer-lookup", lookupFreelancer);
cashierRouter.get("/pending-packages", getPendingPackages);


cashierRouter.post("/claim-package", claimPackage);
cashierRouter.post("/accept-package", acceptPackage);
cashierRouter.post("/reject-package", rejectPackage);


cashierRouter.get("/bordereau/:trackingNumber", printSingleBordereau);
cashierRouter.post("/bordereau/bulk", printBulkBordereau);

cashierRouter.get("/scan/:trackingNumber/branch/:branchId", getPackageByTrackingNumber);

export default cashierRouter;