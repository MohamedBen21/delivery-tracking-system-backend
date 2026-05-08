// src/jobs/cleanupStalePresence.job.ts
import cron from 'node-cron';
import { PresenceService } from '../services/presence.service';
import DelivererModel from '../models/deliverer.model';
import TransporterModel from '../models/transporter.model';

export const startStalePresenceCleanup = () => {

  cron.schedule('*/30 * * * *', async () => {
    console.log('🧹 [SAFETY NET] Running stale presence cleanup...');
    
    try {

      const onlineDeliverers = await PresenceService.getAllOnline('deliverer');
      const onlineTransporters = await PresenceService.getAllOnline('transporter');
      

      const deliverersInDB = await DelivererModel.find({ isOnline: true }).select('userId').lean();
      const transportersInDB = await TransporterModel.find({ isOnline: true }).select('userId').lean();
      
      const staleDeliverers = deliverersInDB.filter(
        d => !onlineDeliverers.includes(d.userId.toString())
      );
      
      const staleTransporters = transportersInDB.filter(
        t => !onlineTransporters.includes(t.userId.toString())
      );
      

      if (staleDeliverers.length > 0) {
        await DelivererModel.updateMany(
          { userId: { $in: staleDeliverers.map(d => d.userId) }, isOnline: true },
          { isOnline: false, lastActiveAt: new Date() }
        );
        console.log(`✅ [SAFETY NET] Cleaned up ${staleDeliverers.length} stale deliverers`);
      }
      

      if (staleTransporters.length > 0) {
        await TransporterModel.updateMany(
          { userId: { $in: staleTransporters.map(t => t.userId) }, isOnline: true },
          { isOnline: false, lastActiveAt: new Date() }
        );
        console.log(`✅ [SAFETY NET] Cleaned up ${staleTransporters.length} stale transporters`);
      }
      
      if (staleDeliverers.length === 0 && staleTransporters.length === 0) {
        console.log('✨ [SAFETY NET] No stale online users found');
      }
      
    } catch (error) {
      console.error('❌ [SAFETY NET] Stale presence cleanup failed:', error);
    }
  });
  
  console.log('🟢 [SAFETY NET] Stale presence cleanup scheduled (every 30 minutes)');
};