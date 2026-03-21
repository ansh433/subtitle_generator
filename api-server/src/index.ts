import express from 'express';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';
import cors from 'cors';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
    const preSignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
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
      videoUrl: videoUrl,
      status: 'queued',
      createdAt: new Date().toISOString(),
      priority: priority || 'low',
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
  app.listen(3000, () => {
    console.log('API Server is listening on port 3000');
  });
};

startServer();