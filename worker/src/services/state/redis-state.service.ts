// worker/src/services/state/redis-state.service.ts

import { createClient } from 'redis';
import { IStateService, JobCheckpoint } from './state.interface.js';

export class RedisStateService implements IStateService {
  constructor(private redisClient: ReturnType<typeof createClient>) {}

  async updateStatus(jobId: string, status: string): Promise<void> {
    console.log(`[RedisState] Updating job ${jobId} status to: ${status}`);
    await this.redisClient.hSet(`job:${jobId}`, 'status', status);
  }

  async saveCheckpoint(jobId: string, checkpoint: Partial<JobCheckpoint>): Promise<void> {
    console.log(`[RedisState] Saving checkpoint for job ${jobId}:`, checkpoint);
    
    const checkpointKey = `job:${jobId}:checkpoint`;
    
    // Merge with existing checkpoint
    const existing = await this.getCheckpoint(jobId) || {};
    const merged = { ...existing, ...checkpoint };
    
    await this.redisClient.set(checkpointKey, JSON.stringify(merged));
  }

  async getCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
    const checkpointKey = `job:${jobId}:checkpoint`;
    const data = await this.redisClient.get(checkpointKey);
    
    if (!data) {
      return null;
    }
    
    try {
      return JSON.parse(data) as JobCheckpoint;
    } catch (err) {
      console.error(`[RedisState] Failed to parse checkpoint for ${jobId}:`, err);
      return null;
    }
  }

  async saveOutput(jobId: string, outputUrl: string): Promise<void> {
    console.log(`[RedisState] Saving output for job ${jobId}: ${outputUrl}`);
    await this.redisClient.hSet(`job:${jobId}`, 'subtitleUrl', outputUrl);
  }
}