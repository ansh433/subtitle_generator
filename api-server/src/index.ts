import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';
import cors from 'cors';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();
const corsOptions = {
  origin: 'http://localhost:5173',
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL environment variable is not set.');
}

const redisClient = createClient({ url: redisUrl });
redisClient.on('error', (err) => console.error('Redis Client Error:', err));

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

app.post('/jobs/signed-url', async (req, res) => {
  const { fileName, fileType } = req.body;

  if (!fileName || !fileType) {
    return res
      .status(400)
      .send({ message: 'fileName and fileType are required.' });
  }

  const key = `${randomUUID()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    ContentType: fileType,
  });

  try {
    const preSignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    res.status(200).json({ preSignedUrl, key });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).send({ message: 'Could not generate signed URL.' });
  }
});

app.post('/jobs', async (req, res) => {
  const { videoUrl, priority } = req.body;

  if (!videoUrl) {
    return res
      .status(400)
      .send({ message: 'Missing videoUrl (S3 key) in request body.' });
  }

  const jobId = randomUUID();
  const jobQueue = priority === 'high' ? 'queue:high' : 'queue:low';

  try {
    await redisClient.hSet(`job:${jobId}`, {
  id: jobId,
  type: 'transcribe',  
  videoUrl: videoUrl,
  status: 'queued',
  createdAt: new Date().toISOString(),
  priority: priority || 'low',
  retryCount: '0',  //
});

    await redisClient.lPush(jobQueue, jobId);

    console.log(`Job ${jobId} created for S3 key ${videoUrl}`);
    res.status(201).json({
      message: 'Job created successfully',
      jobId,
    });
  } catch (error) {
    console.error('Failed to create job:', error);
    res.status(500).send({ message: 'Server error while creating job.' });
  }
});

// ===== EMBED SUBTITLES ENDPOINT =====
app.post('/jobs/embed', async (req, res) => {
  const { videoUrl, subtitleUrl, priority = 'low' } = req.body;

  if (!videoUrl || !subtitleUrl) {
    return res.status(400).json({ error: 'videoUrl and subtitleUrl are required' });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    type: 'embed_subtitles',
    videoUrl,
    subtitleUrl,
    status: 'queued',
    priority,
    createdAt: new Date().toISOString(),
    retryCount: 0,
  };

  // Save to Redis
  await redisClient.hSet(`job:${jobId}`, job);

  // Add to queue
  const queueName = priority === 'high' ? 'queue:high' : 'queue:low';
  await redisClient.rPush(queueName, jobId);

  res.json({ jobId, status: 'queued' });
});

app.get('/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const jobData = await redisClient.hGetAll(`job:${jobId}`);
    
    if (!jobData.id) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({
      id: jobData.id,
      type: jobData.type,
      videoUrl: jobData.videoUrl,
      audioUrl: jobData.audioUrl || null,
      subtitleUrl: jobData.subtitleUrl || null,
      embeddedVideoUrl: jobData.embeddedVideoUrl || null, 
      status: jobData.status,
      priority: jobData.priority,
      createdAt: jobData.createdAt,
      retryCount: parseInt(jobData.retryCount || '0'),
      error: jobData.error || null,
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ===== MULTIPART UPLOAD ENDPOINTS =====

// 1. Initiate multipart upload
app.post('/jobs/multipart/initiate', async (req, res) => {
  const { fileName, fileType } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ error: 'fileName and fileType are required' });
  }

  const key = `${uuidv4()}-${fileName}`;

  try {
    const command = new CreateMultipartUploadCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: fileType,
    });

    const response = await s3Client.send(command);

    res.json({
      uploadId: response.UploadId,
      key: key,
    });
  } catch (error) {
    console.error('Error initiating multipart upload:', error);
    res.status(500).json({ error: 'Failed to initiate multipart upload' });
  }
});

// 2. Get presigned URL for uploading a part
app.post('/jobs/multipart/presigned-url', async (req, res) => {
  const { key, uploadId, partNumber } = req.body;

  if (!key || !uploadId || !partNumber) {
    return res.status(400).json({ error: 'key, uploadId, and partNumber are required' });
  }

  try {
    const command = new UploadPartCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const preSignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({ preSignedUrl });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// 3. Complete multipart upload
app.post('/jobs/multipart/complete', async (req, res) => {
  const { key, uploadId, parts } = req.body;

  if (!key || !uploadId || !parts || !Array.isArray(parts)) {
    return res.status(400).json({ error: 'key, uploadId, and parts array are required' });
  }

  try {
    const command = new CompleteMultipartUploadCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part: any) => ({
          ETag: part.ETag,
          PartNumber: part.PartNumber,
        })),
      },
    });

    await s3Client.send(command);

    res.json({ 
      success: true,
      key: key,
    });
  } catch (error) {
    console.error('Error completing multipart upload:', error);
    res.status(500).json({ error: 'Failed to complete multipart upload' });
  }
});

// 4. Abort multipart upload (cleanup on failure)
app.post('/jobs/multipart/abort', async (req, res) => {
  const { key, uploadId } = req.body;

  if (!key || !uploadId) {
    return res.status(400).json({ error: 'key and uploadId are required' });
  }

  try {
    const command = new AbortMultipartUploadCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
    });

    await s3Client.send(command);

    res.json({ success: true });
  } catch (error) {
    console.error('Error aborting multipart upload:', error);
    res.status(500).json({ error: 'Failed to abort multipart upload' });
  }
});

app.get('/jobs/:jobId/subtitle', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const jobData = await redisClient.hGetAll(`job:${jobId}`);
    
    if (!jobData.id) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (jobData.status !== 'completed') {
      return res.status(400).json({ 
        error: 'Job not completed yet',
        status: jobData.status 
      });
    }
    
    if (!jobData.subtitleUrl) {
      return res.status(404).json({ error: 'Subtitle file not found' });
    }
    
    const getCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: jobData.subtitleUrl,
    });
    
    const downloadUrl = await getSignedUrl(s3Client, getCommand, { 
      expiresIn: 3600 
    });
    
    res.json({ downloadUrl });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

const startServer = async () => {
  await redisClient.connect();
  
  if (process.env.AWS_EXECUTION_ENV === undefined) {
    app.listen(3000, () => {
      console.log('API Server is listening on port 3000');
    });
  }
};

startServer();

export default app;