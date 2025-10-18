// In worker/src/index.ts

import { createClient } from 'redis';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// --- SETUP ---
const redisClient = createClient({ url: process.env.REDIS_URL });
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

const S3_BUCKET = process.env.S3_BUCKET_NAME!;

// --- HELPER FUNCTIONS ---

// Function to run shell commands, wrapped in a Promise
const runCommand = (command: string) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Command error: ${stderr}`);
                return reject(error);
            }
            resolve(stdout);
        });
    });
};

// Main worker function to process a single job
const processJob = async (jobId: string) => {
    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:downloading_video');

    // 1. Get S3 key from Redis
    const videoS3Key = await redisClient.hGet(`job:${jobId}`, 'videoUrl');
    if (!videoS3Key) throw new Error(`No videoUrl found for job ${jobId}`);
    console.log(`[${jobId}] Processing video from S3 key: ${videoS3Key}`);

    // 2. Download video from S3 to a temporary local file
    const tempVideoPath = path.join('/tmp', videoS3Key);
    await fs.mkdir(path.dirname(tempVideoPath), { recursive: true });

    const getObjectCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: videoS3Key });
    const s3Response = await s3Client.send(getObjectCommand);
    const videoData = await s3Response.Body!.transformToByteArray();
    await fs.writeFile(tempVideoPath, videoData);
    console.log(`[${jobId}] Video downloaded to ${tempVideoPath}`);

    // 3. Extract audio using FFmpeg
    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:extracting_audio');
    const tempAudioPath = path.join('/tmp', `${path.parse(videoS3Key).name}.mp3`);
    const ffmpegCommand = `ffmpeg -i ${tempVideoPath} -vn -acodec libmp3lame -q:a 2 ${tempAudioPath}`;
    console.log(`[${jobId}] Running FFmpeg: ${ffmpegCommand}`);
    await runCommand(ffmpegCommand);
    console.log(`[${jobId}] Audio extracted to ${tempAudioPath}`);

    // 4. Upload the audio file to S3
    await redisClient.hSet(`job:${jobId}`, 'status', 'processing:uploading_audio');
    const audioS3Key = `${path.parse(videoS3Key).name}.mp3`;
    const audioData = await fs.readFile(tempAudioPath);

    const putObjectCommand = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: audioS3Key,
        Body: audioData,
        ContentType: 'audio/mpeg',
    });
    await s3Client.send(putObjectCommand);
    console.log(`[${jobId}] Audio uploaded to S3 with key: ${audioS3Key}`);

    // 5. Update Redis with the audio file key
    await redisClient.hSet(`job:${jobId}`, 'audioUrl', audioS3Key);
    await redisClient.hSet(`job:${jobId}`, 'status', 'completed:audio_extraction');

    // 6. Cleanup local temporary files
    await fs.unlink(tempVideoPath);
    await fs.unlink(tempAudioPath);
    console.log(`[${jobId}] Cleaned up temporary files.`);
};

// --- MAIN WORKER LOOP ---
const startWorker = async () => {
    await redisClient.connect();
    console.log('✅ Worker connected to Redis, waiting for jobs...');

    while (true) {
        try {
            const result = await redisClient.brPop(['queue:high', 'queue:low'], 0);
            if (result) {
                const jobId = result.element;
                console.log(`- Found job ${jobId}, starting processing...`);
                await processJob(jobId).catch(err => {
                    console.error(`[${jobId}] Processing failed:`, err);
                    redisClient.hSet(`job:${jobId}`, 'status', `failed:audio_extraction`);
                    redisClient.hSet(`job:${jobId}`, 'error', String(err));
                });
            }
        } catch (error) {
            console.error('Worker loop error:', error);
            await new Promise(res => setTimeout(res, 5000)); // Prevent fast crash loop
        }
    }
};

startWorker();