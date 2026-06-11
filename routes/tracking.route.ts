// routes/tracking.routes.ts

import express from 'express';
import TrackingController from '../controllers/tracking.controller';
import { SocketService } from '../services/socket.service';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiting for public tracking endpoints
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: 'Too many tracking requests, please try again later',
});

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many subscription attempts, please wait',
});

export function setupTrackingRoutes(socketService: SocketService) {
  const trackingController = new TrackingController(socketService);

  // Public routes - no authentication required
  router.get(
    '/track/:trackingNumber',
    trackingLimiter,
    trackingController.trackPackage
  );

  router.post(
    '/track/:trackingNumber/subscribe',
    subscribeLimiter,
    trackingController.subscribeToTracking
  );

  return router;
}

export default setupTrackingRoutes;