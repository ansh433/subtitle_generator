import express from 'express';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// Check for the required environment variable
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not set.');
}

// Connect to Redis using the validated URL
const redisClient = createClient({
    url: redisUrl
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

app.post('/jobs', async (req, res) => {
    const { videoUrl, priority } = req.body;

    if (!videoUrl) {
        return res.status(400).send({ message: 'Missing videoUrl in request body.' });
    }

    const jobId = randomUUID();
    const jobQueue = priority === 'high' ? 'queue:high' : 'queue:low';

    try {
        await redisClient.hSet(`job:${jobId}`, {
            id: jobId,
            videoUrl: videoUrl,
            status: 'queued',
            createdAt: new Date().toISOString(),
            priority: priority || 'low'
        });

        await redisClient.lPush(jobQueue, jobId);

        console.log(`Job ${jobId} created and added to ${jobQueue}`);
        res.status(201).json({
            message: 'Job created successfully',
            jobId: jobId,
        });

    } catch (error) {
        console.error('Failed to create job:', error);
        res.status(500).send({ message: 'Server error while creating job.' });
    }
});

const startServer = async () => {
    await redisClient.connect();
    app.listen(3000, () => {
        console.log('API Server is listening on port 3000');
    });
};

startServer();