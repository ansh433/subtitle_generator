import { createClient } from 'redis';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

import { ITranscriptionService, TranscriptSegment } from './services/transcription.service.js';
import { getTranscriptionService } from './services/transcription.factory.js';
import { IAudioService, FfmpegAudioService } from './services/audio.service.js';

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

const formatToSrt = (transcript: TranscriptSegment[]): string => {
  const toTimestamp = (ms: number) =>
    new Date(ms).toISOString().substr(11, 12);
  return transcript
    .map(
      (entry, index) =>
        `${index + 1}\n${toTimestamp(entry.start)} --> ${toTimestamp(
          entry.end
        )}\n${entry.text}\n`
    )
    .join('\n');
};

const processJob = async (
  jobId: string,
  audioService: IAudioService,
  transcriptionService: ITranscriptionService,
  aiLimiter: ConcurrencyManager
) => {
  const tempDir = path.join('/tmp', jobId);
  let tempVideoPath = '';
  let tempAudioPath = '';
  let tempSrtPath = '';
  let shouldRetry = false;
  let errorMessage = '';

  try {
    console.log(`[${jobId}] Adding to processing set.`);
    await redisClient.sAdd('jobs:processing', jobId);

    console.log(`[${jobId}] Creating temp directory.`);
    await fs.mkdir(tempDir, { recursive: true });

    await redisClient.hSet(
      `job:${jobId}`,
      'status',
      'processing:downloading_video'
    );
    const videoS3Key = await redisClient.hGet(`job:${jobId}`, 'videoUrl');
    if (!videoS3Key) throw new Error(`No videoUrl found for job ${jobId}`);

    tempVideoPath = path.join(tempDir, path.basename(videoS3Key));
    tempAudioPath = path.join(tempDir, `${path.parse(videoS3Key).name}.mp3`);
    tempSrtPath = path.join(tempDir, `${path.parse(videoS3Key).name}.srt`);

    console.log(`[${jobId}] Downloading video.`);
    const getObjectCommand = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: videoS3Key,
    });
    const s3Response = await s3Client.send(getObjectCommand);
    await pipeline(
      s3Response.Body as NodeJS.ReadableStream,
      createWriteStream(tempVideoPath)
    );
    console.log(`[${jobId}] Video downloaded to ${tempVideoPath}`);

    console.log(`[${jobId}] Extracting audio.`);
    await redisClient.hSet(
      `job:${jobId}`,
      'status',
      'processing:extracting_audio'
    );
    await audioService.extractAudio(tempVideoPath, tempAudioPath);
    console.log(`[${jobId}] Audio extracted.`);

    console.log(`[${jobId}] Uploading audio.`);
    const audioS3Key = `${path.parse(videoS3Key).name}.mp3`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: audioS3Key,
        Body: await fs.readFile(tempAudioPath),
        ContentType: 'audio/mpeg',
      })
    );
    await redisClient.hSet(`job:${jobId}`, 'audioUrl', audioS3Key);
    console.log(`[${jobId}] Audio uploaded.`);

    console.log(`[${jobId}] Acquiring AI lock.`);
    await aiLimiter.acquire();
    console.log(`[${jobId}] AI lock acquired. Transcribing...`);

    let transcript: TranscriptSegment[] | null = null;
    try {
      await redisClient.hSet(
        `job:${jobId}`,
        'status',
        'processing:transcribing_audio'
      );
      transcript = await transcriptionService.transcribe(audioS3Key);
      console.log(`[${jobId}] Transcription finished.`);
    } finally {
      await aiLimiter.release();
      console.log(`[${jobId}] AI lock released.`);
    }

    console.log(`[${jobId}] Validating transcript.`);
    if (!transcript || transcript.length === 0) {
      throw new Error('Transcription service returned no segments.');
    }
    console.log(`[${jobId}] Transcript validated.`);

    console.log(`[${jobId}] Formatting SRT.`);
    const srtContent = formatToSrt(transcript);
    await fs.writeFile(tempSrtPath, srtContent);
    console.log(`[${jobId}] SRT formatted.`);

    console.log(`[${jobId}] Uploading SRT.`);
    const srtS3Key = `${path.parse(videoS3Key).name}.srt`;
    const srtData = await fs.readFile(tempSrtPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: srtS3Key,
        Body: srtData,
        ContentType: 'application/x-subrip',
      })
    );
    await redisClient.hSet(`job:${jobId}`, 'subtitleUrl', srtS3Key);
    console.log(`[${jobId}] SRT uploaded.`);

    await redisClient.hSet(`job:${jobId}`, 'status', 'completed');
    console.log(`[${jobId}] Job fully completed!`);
  } catch (err) {
    errorMessage = (err as Error).message;
    console.error(`[${jobId}] Processing failed:`, errorMessage);

    const retryCount = await redisClient.hIncrBy(`job:${jobId}`, 'retryCount', 1);

    if (retryCount <= MAX_RETRIES) {
      const backoffDelay = Math.pow(2, retryCount - 1) * INITIAL_BACKOFF_MS;
      console.log(
        `[${jobId}] Will retry (Attempt ${retryCount}/${MAX_RETRIES}). Backoff: ${backoffDelay}ms`
      );

      await redisClient.hSet(`job:${jobId}`, 'status', 'queued:retry');
      await redisClient.hSet(`job:${jobId}`, 'error', errorMessage);

      shouldRetry = true;

      // Schedule retry with backoff
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

      await redisClient.hSet(`job:${jobId}`, 'status', 'failed:dlq');
      await redisClient.hSet(`job:${jobId}`, 'error', errorMessage);

      await redisClient.rPush('queue:dlq', jobId);
    }
  } finally {
    console.log(`[${jobId}] Cleaning up.`);
    
    await redisClient.sRem('jobs:processing', jobId);

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${jobId}] Cleaned up temporary directory: ${tempDir}`);
    } catch (cleanupErr) {
      console.error(
        `[${jobId}] Failed to cleanup temp directory:`,
        cleanupErr
      );
    }
  }
};

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

  const audioService: IAudioService = new FfmpegAudioService();
  const transcriptionService: ITranscriptionService = getTranscriptionService(
    s3Client,
    S3_BUCKET
  );

  console.log('✅ Worker connected to Redis, waiting for jobs...');

  while (true) {
    try {
      // Acquire global slot BEFORE getting job
      console.log('[Worker] Waiting for a free global processing slot...');
      await globalLimiter.acquire();
      console.log('[Worker] Global slot acquired. Waiting for job from queue...');

      const result = await redisClient.brPop(['queue:high', 'queue:low'], 0);

      if (result) {
        const jobId = result.element;
        console.log(`[Worker] Found job ${jobId}, starting processing...`);

        try {
          // CRITICAL FIX: AWAIT processJob to ensure proper concurrency
          await processJob(
            jobId,
            audioService,
            transcriptionService,
            aiLimiter
          );
        } catch (err) {
          console.error(
            `[${jobId}] Unhandled error in processJob:`,
            err
          );
        } finally {
          // CRITICAL FIX: Release global slot AFTER job completes (success or failure)
          await globalLimiter.release();
          console.log(`[Worker] Global slot released for job ${jobId}.`);
        }
      }
    } catch (error) {
      console.error('Worker loop error (Redis connection?):', error);
      // Release the global lock if we acquired it but failed before processing
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