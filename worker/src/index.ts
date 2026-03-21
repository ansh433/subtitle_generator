import { createClient } from 'redis';
import { S3Client } from '@aws-sdk/client-s3';

import { ITranscriptionService } from './services/transcription.service.js';
import { getTranscriptionService } from './services/transcription.factory.js';
import { IAudioService, FfmpegAudioService } from './services/audio.service.js';
import { ProcessorFactory } from './processors/processor.factory.js';
import { JobData } from './interfaces/job-processor.interface.js';

import { S3StorageService } from './services/storage/s3-storage.service.js';
import { RedisStateService } from './services/state/redis-state.service.js';
import { NodeFileSystemService } from './services/filesystem/node-filesystem.service.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const MAX_GLOBAL_CONCURRENCY = 5;
const MAX_AI_CONCURRENCY = 2;

class ConcurrencyManager {
  private redis: ReturnType<typeof createClient>;
  private queueName: string;
  private limit: number;

  constructor(
    redisClient: ReturnType<typeof createClient>,
    queueName: string,
    limit: number
  ) {
    this.redis = redisClient;
    this.queueName = queueName;
    this.limit = limit;
  }

  async initialize() {
    await this.redis.del(this.queueName);
    const tokens = Array(this.limit).fill('token');
    if (tokens.length > 0) {
      await this.redis.rPush(this.queueName, tokens);
    }
    console.log(
      `[ConcurrencyManager] Initialized ${this.queueName} with ${this.limit} tokens.`
    );
  }

  async acquire(): Promise<void> {
    await this.redis.brPop(this.queueName, 0);
  }

  async release(): Promise<void> {
    await this.redis.lPush(this.queueName, 'token');
  }
}

const redisClient = createClient({ url: process.env.REDIS_URL });

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const S3_BUCKET = process.env.S3_BUCKET_NAME!;
if (!S3_BUCKET) throw new Error('S3_BUCKET_NAME is not set.');


let currentJobId: string | null = null;

const processJob = async (
  jobId: string,
  processorFactory: ProcessorFactory,
  stateService: RedisStateService,
  aiLimiter: ConcurrencyManager
) => {
  try {
    console.log(`[${jobId}] Adding to processing set.`);
    await redisClient.sAdd('jobs:processing', jobId);


    const jobDataRaw = await redisClient.hGetAll(`job:${jobId}`);
    const jobData: JobData = {
      jobId: jobDataRaw.id,
      type: (jobDataRaw.type || 'TRANSCRIBE') as 'TRANSCRIBE' | 'EMBED_SUBTITLES',
      videoUrl: jobDataRaw.videoUrl,
      audioUrl: jobDataRaw.audioUrl,
      subtitleUrl: jobDataRaw.subtitleUrl,
      status: jobDataRaw.status,
      priority: jobDataRaw.priority,
      createdAt: jobDataRaw.createdAt,
      retryCount: jobDataRaw.retryCount,
      error: jobDataRaw.error,
    };

    if (!jobData.videoUrl) {
      throw new Error(`No videoUrl found for job ${jobId}`);
    }

    console.log(`[${jobId}] Processing job of type: ${jobData.type}`);

    
    const processor = processorFactory.getProcessor(jobData.type);

   
    console.log(`[${jobId}] Acquiring AI lock.`);
    await aiLimiter.acquire();
    console.log(`[${jobId}] AI lock acquired. Processing...`);

    let outputUrl: string;
    try {
      
      outputUrl = await processor.process(jobData);
      console.log(`[${jobId}] Processing finished. Output: ${outputUrl}`);
    } finally {
      await aiLimiter.release();
      console.log(`[${jobId}] AI lock released.`);
    }


    await stateService.updateStatus(jobId, 'completed');
    
    
    await redisClient.lRem('queue:processing', 1, jobId);
    
    console.log(`[${jobId}] Job fully completed!`);
    
  } catch (err) {
    const errorMessage = (err as Error).message;
    console.error(`[${jobId}] Processing failed:`, errorMessage);

    const retryCount = await redisClient.hIncrBy(`job:${jobId}`, 'retryCount', 1);

    if (retryCount <= MAX_RETRIES) {
      const backoffDelay = Math.pow(2, retryCount - 1) * INITIAL_BACKOFF_MS;
      console.log(
        `[${jobId}] Will retry (Attempt ${retryCount}/${MAX_RETRIES}). Backoff: ${backoffDelay}ms`
      );

      await stateService.updateStatus(jobId, 'queued:retry');
      await redisClient.hSet(`job:${jobId}`, 'error', errorMessage);

      
      await redisClient.lRem('queue:processing', 1, jobId);

      
      setTimeout(async () => {
        try {
          await redisClient.lPush('queue:low', jobId);
          console.log(`[${jobId}] Re-queued for retry.`);
        } catch (requeueErr) {
          console.error(`[${jobId}] Failed to requeue:`, requeueErr);
        }
      }, backoffDelay);
    } else {
      console.error(
        `[${jobId}] Job failed permanently after ${MAX_RETRIES} attempts. Moving to DLQ.`
      );

      await stateService.updateStatus(jobId, 'failed:dlq');
      await redisClient.hSet(`job:${jobId}`, 'error', errorMessage);
      
      
      await redisClient.lRem('queue:processing', 1, jobId);
      await redisClient.rPush('queue:dlq', jobId);
    }
  } finally {
    console.log(`[${jobId}] Removing from processing set.`);
    await redisClient.sRem('jobs:processing', jobId);
  }
};


const recoverStalledJobs = async () => {
  console.log('[Worker] Checking for stalled jobs in processing queue...');
  
  const stalledJobs = await redisClient.lRange('queue:processing', 0, -1);
  
  if (stalledJobs.length === 0) {
    console.log('[Worker] No stalled jobs found.');
    return;
  }
  
  console.log(`[Worker] Found ${stalledJobs.length} stalled job(s), re-queuing...`);
  
  for (const jobId of stalledJobs) {
    
    await redisClient.lPush('queue:low', jobId);
    await redisClient.lRem('queue:processing', 1, jobId);
    
    
    await redisClient.hSet(`job:${jobId}`, 'status', 'queued:recovered');
    
    console.log(`[Worker]  Re-queued stalled job: ${jobId}`);
  }
};


const gracefulShutdown = async () => {
  console.log('[Worker] SIGTERM/SIGINT received, shutting down gracefully...');
  
  if (currentJobId) {
    console.log(`[Worker] Returning current job ${currentJobId} to queue...`);
    
    try {
      
      await redisClient.lRem('queue:processing', 1, currentJobId);
      await redisClient.lPush('queue:low', currentJobId);
      await redisClient.sRem('jobs:processing', currentJobId);
      await redisClient.hSet(`job:${currentJobId}`, 'status', 'queued:interrupted');
      
      console.log(`[Worker] ✅ Job ${currentJobId} returned to queue.`);
    } catch (err) {
      console.error(`[Worker] ❌ Failed to return job to queue:`, err);
    }
  }
  
  try {
    await redisClient.quit();
    console.log('[Worker] Redis connection closed.');
  } catch (err) {
    console.error('[Worker] Error closing Redis:', err);
  }
  
  console.log('[Worker] Graceful shutdown complete. Exiting.');
  process.exit(0);
};


process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const startWorker = async () => {
  await redisClient.connect();

  const globalLimiter = new ConcurrencyManager(
    redisClient,
    'semaphore:global',
    MAX_GLOBAL_CONCURRENCY
  );
  const aiLimiter = new ConcurrencyManager(
    redisClient,
    'semaphore:ai',
    MAX_AI_CONCURRENCY
  );
  await Promise.all([globalLimiter.initialize(), aiLimiter.initialize()]);

  const storageService = new S3StorageService(s3Client, S3_BUCKET);
  const stateService = new RedisStateService(redisClient);
  const fileSystemService = new NodeFileSystemService();
  const audioService: IAudioService = new FfmpegAudioService();
  const transcriptionService: ITranscriptionService = getTranscriptionService(
    s3Client,
    S3_BUCKET
  );

  
  const processorFactory = new ProcessorFactory(
    storageService,
    stateService,
    fileSystemService,
    audioService,
    transcriptionService
  );

  
  await recoverStalledJobs();

  console.log('✅ Worker connected to Redis, waiting for jobs...');

  while (true) {
    try {
      await globalLimiter.acquire();
      console.log('[Worker] Global slot acquired. Waiting for job from queue...');

      
      let jobId = await redisClient.blMove(
        'queue:high',
        'queue:processing',
        'RIGHT',
        'LEFT',
        5 
      );

      
      if (!jobId) {
        jobId = await redisClient.blMove(
          'queue:low',
          'queue:processing',
          'RIGHT',
          'LEFT',
          0  
        );
      }

      if (jobId) {
        console.log(`[Worker] Found job ${jobId}, starting processing...`);
        currentJobId = jobId;  

        try {
          await processJob(jobId, processorFactory, stateService, aiLimiter);
        } catch (err) {
          console.error(`[${jobId}] Unhandled error in processJob:`, err);
        } finally {
          currentJobId = null;  
          await globalLimiter.release();
          console.log(`[Worker] Global slot released for job ${jobId}.`);
        }
      }
    } catch (error) {
      console.error('Worker loop error (Redis connection?):', error);
      try {
        await globalLimiter.release();
      } catch (releaseErr) {
        console.error('Failed to release global lock after error:', releaseErr);
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
};

startWorker();