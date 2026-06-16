import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  addPackageIssue,
  assignDeliverer,
  assignFreelancer,
  cancelPackage,
  createCashier,
  createDeliverer,
  createFreelancer,
  createLoader,
  createPackage,
  getActiveRoutes,
  getBranchPackages,
  getCashier,
  getDeliverer,
  getFreelancer,
  getLoader,
  getMeSupervisor,
  getMyBranchPackages,
  getMyCashiers,
  getMyDeliverers,
  getMyFreelancers,
  getMyLoaders,
  getMyRoutes,
  getPackage,
  getPackageHistory,
  getPackagesByBranch,
  getPackagesByReceiver,
  getPackagesBySender,
  getPackagesByStatus,
  getPackagesPaginated,
  getPackageTracking,
  getRoute,
  getRoutes,
  getRoutesByBranch,
  resolvePackageIssue,
  searchPackages,
  toggleBlockCashier,
  toggleBlockDeliverer,
  toggleBlockFreelancer,
  toggleBlockLoader,
  toggleCancelPackage,
  toggleCancelRoute,
  updateCashier,
  updateDeliverer,
  updateFreelancer,
  updateLoader,
  updateMeSupervisor,
  updatePackage,
  updateRoute,
  deleteCashier,
  deleteLoader,
  getPackagesPaginatedFromRoute,
  completeDeliveryByQrCode,
  searchDeliveries,
  getManifestsHistory,
  getTransportationsHistory,
  getOrCreateTodayTransportation,
  arriveAtStopByQrCode,
  startRouteByQrCode,
  generateStopVerificationQR,
  generateStartRouteQR,
} from "../controllers/supervisor.controller";

const supervisorRouter = Router();

const supOrAdmin = [isAuthenticated, authorizeRoles("supervisor", "admin")] as const;

const supAdminDelTrans = [
  isAuthenticated,
  authorizeRoles("supervisor", "admin", "deliverer", "transporter")
] as const;

supervisorRouter.get("/me", ...supOrAdmin, getMeSupervisor);
supervisorRouter.patch("/me", ...supOrAdmin, updateMeSupervisor);

supervisorRouter.get("/routes/by-branch", ...supOrAdmin, getRoutesByBranch);

supervisorRouter.post("/branches/:branchId/deliverers", ...supOrAdmin, createDeliverer);
supervisorRouter.get("/branches/:branchId/deliverers", ...supOrAdmin, getMyDeliverers);
supervisorRouter.get("/branches/:branchId/deliverers/:delivererId", ...supOrAdmin, getDeliverer);
supervisorRouter.patch("/branches/:branchId/deliverers/:delivererId", ...supOrAdmin, updateDeliverer);
supervisorRouter.patch(
  "/branches/:branchId/deliverers/:delivererId/toggle-block",
  ...supOrAdmin,
  toggleBlockDeliverer,
);
supervisorRouter.post("/branches/:branchId/deliverers/assign", ...supOrAdmin, assignDeliverer);
supervisorRouter.post("/branches/:branchId/freelancers/assign", ...supOrAdmin, assignFreelancer);

supervisorRouter.post("/branches/:branchId/freelancers", ...supOrAdmin, createFreelancer);
supervisorRouter.get("/branches/:branchId/freelancers", isAuthenticated, authorizeRoles("cashier", "supervisor", "admin"), getMyFreelancers);
supervisorRouter.get("/branches/:branchId/freelancers/:freelancerId", ...supOrAdmin, getFreelancer);
supervisorRouter.patch("/branches/:branchId/freelancers/:freelancerId", ...supOrAdmin, updateFreelancer);
supervisorRouter.patch(
  "/branches/:branchId/freelancers/:freelancerId/toggle-block",
  ...supOrAdmin,
  toggleBlockFreelancer,
);

supervisorRouter.post("/branches/:branchId/packages", ...supOrAdmin, createPackage);
supervisorRouter.get("/branches/:branchId/packages", ...supOrAdmin, getBranchPackages);
supervisorRouter.get("/branches/:branchId/packages/compact", ...supOrAdmin, getMyBranchPackages);
supervisorRouter.get("/branches/:branchId/packages/by-status", ...supOrAdmin, getPackagesByStatus);
supervisorRouter.get("/branches/:branchId/packages/by-branch-role", ...supOrAdmin, getPackagesByBranch);
supervisorRouter.get("/branches/:branchId/packages/by-sender", ...supOrAdmin, getPackagesBySender);
supervisorRouter.get("/branches/:branchId/packages/by-receiver", ...supOrAdmin, getPackagesByReceiver);
supervisorRouter.get("/branches/:branchId/packages/:packageId", authorizeRoles("supervisor", "freelancer"), getPackage);
supervisorRouter.patch("/branches/:branchId/packages/:packageId", ...supOrAdmin, updatePackage);
supervisorRouter.patch(
  "/branches/:branchId/packages/:packageId/toggle-cancel",
  ...supOrAdmin,
  toggleCancelPackage,
);
supervisorRouter.patch("/branches/:branchId/packages/:packageId/cancel", ...supOrAdmin, cancelPackage);
supervisorRouter.post("/branches/:branchId/packages/:packageId/issues", ...supOrAdmin, addPackageIssue);
supervisorRouter.patch(
  "/branches/:branchId/packages/:packageId/issues/:issueIndex/resolve",
  ...supOrAdmin,
  resolvePackageIssue,
);
supervisorRouter.get(
  "/branches/:branchId/packages/:packageId/history",
  ...supOrAdmin,
  getPackageHistory,
);
supervisorRouter.get(
  "/branches/:branchId/packages/:packageId/tracking",
  ...supOrAdmin,
  getPackageTracking,
);

supervisorRouter.get("/branches/:branchId/routes/active", ...supOrAdmin, getActiveRoutes);
// supervisorRouter.get("/branches/:branchId/routes", ...supOrAdmin, getRoutes);
supervisorRouter.get("/branches/:branchId/routes", ...supAdminDelTrans, getRoutes);
supervisorRouter.get("/branches/:branchId/routes/:routeId", ...supOrAdmin, getRoute);
supervisorRouter.patch("/branches/:branchId/routes/:routeId", ...supOrAdmin, updateRoute);
supervisorRouter.patch(
  "/branches/:branchId/routes/:routeId/toggle-cancel",
  ...supOrAdmin,
  toggleCancelRoute,
);

supervisorRouter.get("/packages/search", isAuthenticated, searchPackages);
// supervisorRouter.get("/packages", isAuthenticated, authorizeRoles("deliverer", "transporter", "cashier"), getPackagesPaginated);
supervisorRouter.get("/packages", isAuthenticated, authorizeRoles("deliverer", "transporter", "cashier", 'supervisor'), getPackagesPaginatedFromRoute);



const supMgrAdmin = [isAuthenticated, authorizeRoles("supervisor", "manager", "admin")] as const;




supervisorRouter.post(
  "/branches/:branchId/cashiers",
  ...supMgrAdmin,
  createCashier
);


supervisorRouter.get(
  "/branches/:branchId/cashiers",
  ...supMgrAdmin,
  getMyCashiers
);


supervisorRouter.get(
  "/branches/:branchId/cashiers/:cashierId",
  ...supMgrAdmin,
  getCashier
);


supervisorRouter.patch(
  "/branches/:branchId/cashiers/:cashierId",
  ...supMgrAdmin,
  updateCashier
);


supervisorRouter.patch(
  "/branches/:branchId/cashiers/:cashierId/toggle-block",
  ...supMgrAdmin,
  toggleBlockCashier
);





supervisorRouter.post(
  "/branches/:branchId/loaders",
  ...supMgrAdmin,
  createLoader
);


supervisorRouter.get(
  "/branches/:branchId/loaders",
  ...supMgrAdmin,
  getMyLoaders
);


supervisorRouter.get(
  "/branches/:branchId/loaders/:loaderId",
  ...supMgrAdmin,
  getLoader
);


supervisorRouter.patch(
  "/branches/:branchId/loaders/:loaderId",
  ...supMgrAdmin,
  updateLoader
);


supervisorRouter.patch(
  "/branches/:branchId/loaders/:loaderId/toggle-block",
  ...supMgrAdmin,
  toggleBlockLoader
);


supervisorRouter.delete(
  "/branches/:branchId/cashiers/:cashierId",
  ...supMgrAdmin,
  deleteCashier
);


supervisorRouter.delete(
  "/branches/:branchId/loaders/:loaderId",
  ...supMgrAdmin,
  deleteLoader
);




supervisorRouter.get(
  "/routes/get-my-routes",
  isAuthenticated,
  authorizeRoles("supervisor", "transporter", "deliverer"),
  getMyRoutes
);


supervisorRouter.post(
  "/complete-delivery-qr",
  isAuthenticated,
  authorizeRoles("deliverer"),
  completeDeliveryByQrCode
);

supervisorRouter.get("/deliveries/search", isAuthenticated, authorizeRoles("deliverer"), searchDeliveries);

supervisorRouter.get(
  "/transportation/today",
  isAuthenticated,
  authorizeRoles( "transporter"),
  getOrCreateTodayTransportation
);


supervisorRouter.get(
  "/transportation/history",
  isAuthenticated,
  authorizeRoles( "transporter"),
  getTransportationsHistory
);


supervisorRouter.get(
  "/manifest/history",
  isAuthenticated,
  authorizeRoles( "transporter"),
  getManifestsHistory
);


supervisorRouter.post(
  "/transporter/start-route-qr",
  isAuthenticated,
  authorizeRoles("transporter"),
  startRouteByQrCode
);

supervisorRouter.post(
  "/transporter/arrive-at-stop-qr",
  isAuthenticated,
  authorizeRoles("transporter"),
  arriveAtStopByQrCode
);


supervisorRouter.post(
  '/qr/generate-stop-verification',
  isAuthenticated,
  generateStopVerificationQR
);

supervisorRouter.post(
  '/qr/generate-start-route',
  isAuthenticated,
  generateStartRouteQR
);

export default supervisorRouter;


