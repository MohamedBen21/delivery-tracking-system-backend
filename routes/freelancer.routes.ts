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
import { getAllFreelancersAdmin } from "../controllers/supervisor.controller";

const freelancerRouter = Router();

const isFreelancer = [isAuthenticated, authorizeRoles("freelancer")];


freelancerRouter.get("/", isAuthenticated, authorizeRoles("admin", "manager"), getAllFreelancersAdmin)


freelancerRouter.get("/me", isFreelancer, getMeFreelancer);
freelancerRouter.patch("/me", isFreelancer, updateMeFreelancer);

freelancerRouter.get("/packages", isFreelancer, getMyPackages);
freelancerRouter.get("/packages/active", isFreelancer, getMyActivePackages);
freelancerRouter.get("/packages/delivered", isFreelancer, getMyDeliveredPackages);
freelancerRouter.get("/packages/:packageId/track", isFreelancer, trackPackage);
freelancerRouter.patch("/packages/:packageId/cancel", isFreelancer, cancelPackage);

freelancerRouter.post("/packages", isAuthenticated, authorizeRoles("cashier", "freelancer", "supervisor"), createPackage);

freelancerRouter.post("/packages", isAuthenticated, authorizeRoles("freelancer", "cashier"), createPackageWithImages);

freelancerRouter.get("/branches/search", isFreelancer, searchBranchesForPickup);


// freelancerRouter.get(
//   "/communes/search",
//   isAuthenticated,
//   authorizeRoles("freelancer"),
//   searchServedCommunes
// );


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