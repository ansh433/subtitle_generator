// In worker/src/index.ts

import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not set.');
}

const redisClient = createClient({
    url: redisUrl,
});

// A simple promise-based delay function
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const startWorker = async () => {
    await redisClient.connect();
    console.log('✅ Worker connected to Redis, waiting for jobs...');

    // Main worker loop
    while (true) {
        try {
            // BRPOP is a blocking command that waits for an item to appear.
            // It checks 'queue:high' first, then 'queue:low'. Timeout 0 means wait forever.
            const result = await redisClient.brPop(['queue:high', 'queue:low'], 0);

            if (result) {
                const jobId = result.element;
                console.log(`- Found job ${jobId} in queue: ${result.key}`);

                // Update job status to 'processing'
                await redisClient.hSet(`job:${jobId}`, 'status', 'processing');
                console.log(`  > Processing job ${jobId}...`);

                // Simulate the actual work (e.g., ffmpeg, AI call)
                await delay(5000); // Wait for 5 seconds

                // Update job status to 'completed'
                await redisClient.hSet(`job:${jobId}`, 'status', 'completed');
                console.log(`  ✔ Completed job ${jobId}`);
            }
        } catch (error) {
            console.error('Worker error:', error);
            // Wait for a bit before retrying to prevent a fast crash loop
            await delay(5000);
        }
    }
};

startWorker();