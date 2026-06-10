import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  cancelPackage,
  // checkCommuneServed,
  createPackage,
  createPackageWithImages,
  getMeFreelancer,
  getMyActivePackages,
  getMyDeliveredPackages,
  getMyPackages,
  searchBranchesForPickup,
  // searchServedCommunes,
  trackPackage,
  updateMeFreelancer,
} from "../controllers/freelancer.controller";

const freelancerRouter = Router();

freelancerRouter.use(isAuthenticated, authorizeRoles("freelancer"));

freelancerRouter.get("/me", getMeFreelancer);
freelancerRouter.patch("/me", updateMeFreelancer);

freelancerRouter.get("/packages", getMyPackages);
freelancerRouter.get("/packages/active", getMyActivePackages);
freelancerRouter.get("/packages/delivered", getMyDeliveredPackages);
freelancerRouter.get("/packages/:packageId/track", trackPackage);
freelancerRouter.patch("/packages/:packageId/cancel", cancelPackage);

freelancerRouter.post("/packages" ,isAuthenticated,authorizeRoles("freelancer"), createPackage);


freelancerRouter.post("/packages" ,isAuthenticated,authorizeRoles("freelancer"), createPackageWithImages);

freelancerRouter.get("/branches/search", searchBranchesForPickup);

// // For autocomplete as they type
// freelancerRouter.get(
//   "/communes/search",
//   isAuthenticated,
//   authorizeRoles("freelancer"),
//   searchServedCommunes
// );

// // For validation before submission
// freelancerRouter.get(
//   "/communes/check",
//   isAuthenticated,
//   authorizeRoles("freelancer"),
//   checkCommuneServed
// );

export default freelancerRouter;


// {
//     "email": "imed.ferhat@example.com",
//     "password": "Freelancer123"
// }