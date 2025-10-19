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
  const toTimestamp = (ms: number) => new Date(ms).toISOString().substr(11, 12);
  return transcript.map((entry, index) =>
    `${index + 1}\n${toTimestamp(entry.start)} --> ${toTimestamp(entry.end)}\n${entry.text}\n`
  ).join('\n');
};

const processJob = async (
  jobId: string,
  audioService: IAudioService,
  transcriptionService: ITranscriptionService
) => {
  const tempDir = path.join('/tmp', jobId);
  let tempVideoPath = '';
  let tempAudioPath = '';
  let tempSrtPath = '';

  try {
    await fs.mkdir(tempDir, { recursive: true });

    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:downloading_video');
    const videoS3Key = await redisClient.hGet(`job:${jobId}`, 'videoUrl');
    if (!videoS3Key) throw new Error(`No videoUrl found for job ${jobId}`);

    tempVideoPath = path.join(tempDir, path.basename(videoS3Key));
    tempAudioPath = path.join(tempDir, `${path.parse(videoS3Key).name}.mp3`);
    tempSrtPath = path.join(tempDir, `${path.parse(videoS3Key).name}.srt`);

    const getObjectCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: videoS3Key });
    const s3Response = await s3Client.send(getObjectCommand);
    await pipeline(s3Response.Body as NodeJS.ReadableStream, createWriteStream(tempVideoPath));
    console.log(`[${jobId}] Video downloaded to ${tempVideoPath}`);

    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:extracting_audio');
    await audioService.extractAudio(tempVideoPath, tempAudioPath);

    const audioS3Key = `${path.parse(videoS3Key).name}.mp3`;
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: audioS3Key,
      Body: await fs.readFile(tempAudioPath),
      ContentType: 'audio/mpeg',
    }));
    await redisClient.hSet(`job:${jobId}`, 'audioUrl', audioS3Key);

    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:transcribing_audio');
    const transcript = await transcriptionService.transcribe(audioS3Key);

    if (!transcript || transcript.length === 0) {
      throw new Error('Transcription service returned no segments.');
    }

    const srtContent = formatToSrt(transcript);
    await fs.writeFile(tempSrtPath, srtContent);

    const srtS3Key = `${path.parse(videoS3Key).name}.srt`;
    const srtData = await fs.readFile(tempSrtPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: srtS3Key,
      Body: srtData,
      ContentType: 'application/x-subrip',
    }));

    await redisClient.hSet(`job:${jobId}`, 'subtitleUrl', srtS3Key);
    await redisClient.hSet(`job:${jobId}`, 'status', 'completed');
    console.log(`[${jobId}] Job fully completed!`);

  } catch (err) {
    console.error(`[${jobId}] Processing failed:`, (err as Error).message);

    const retryCount = await redisClient.hIncrBy(`job:${jobId}`, 'retryCount', 1);

    if (retryCount <= MAX_RETRIES) {
      const backoffDelay = Math.pow(2, retryCount - 1) * INITIAL_BACKOFF_MS;
      console.log(`[${jobId}] Retrying (Attempt ${retryCount}/${MAX_RETRIES}). Waiting ${backoffDelay}ms...`);

      await redisClient.hSet(`job:${jobId}`, 'status', 'queued:retry');
      await redisClient.hSet(`job:${jobId}`, 'error', String(err));

      await new Promise(res => setTimeout(res, backoffDelay));

      await redisClient.lPush('queue:low', jobId);

    } else {
      console.error(`[${jobId}] Job failed permanently after ${MAX_RETRIES} attempts. Moving to DLQ.`);

      await redisClient.hSet(`job:${jobId}`, 'status', 'failed:dlq');
      await redisClient.hSet(`job:${jobId}`, 'error', String(err));

      await redisClient.rPush('queue:dlq', jobId);
    }
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[${jobId}] Cleaned up temporary directory: ${tempDir}`);
    } catch (cleanupErr) {
      console.error(`[${jobId}] Failed to cleanup temp directory:`, cleanupErr);
    }
  }
};

const startWorker = async () => {
  await redisClient.connect();

  const audioService: IAudioService = new FfmpegAudioService();
  const transcriptionService: ITranscriptionService = getTranscriptionService(
    s3Client,
    S3_BUCKET
  );

  console.log('✅ Worker connected to Redis, waiting for jobs...');

  while (true) {
    try {
      const result = await redisClient.brPop(['queue:high', 'queue:low'], 0);
      if (result) {
        const jobId = result.element;
        console.log(`- Found job ${jobId}, starting processing...`);

        // Await the job to ensure sequential processing.
        await processJob(jobId, audioService, transcriptionService);
      }
    } catch (error) {
      console.error('Worker loop error (Redis connection?):', error);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
};

startWorker();