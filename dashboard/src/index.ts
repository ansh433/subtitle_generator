// dashboard/src/index.ts

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { createClient } from 'redis';

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "http://localhost:5173" }));

const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.log('Redis Client Error', err));

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

/**
 * Gets the current queue lengths in a single, atomic transaction.
 */
const getSystemStats = async () => {
  try {
    // Use multi() for a transactional query
    const results = await redisClient.multi()
      .lLen('queue:high') // <-- FIX 1: Corrected to lLen
      .lLen('queue:low')
      .lLen('queue:dlq')   // <-- FIX 2: Corrected to lLen
      .sCard('jobs:processing') // <-- ADD THIS (sCard = get Set Cardinality/Size)
      .exec();

    // FIX 3: Use (value as unknown as number) for safe type casting
    return {
      highPriority: (results?.[0] as unknown as number) || 0,
      lowPriority: (results?.[1] as unknown as number) || 0,
      dlq: (results?.[2] as unknown as number) || 0,
      processing: (results?.[3] as unknown as number) || 0, // <-- ADD THIS
    };
  } catch (error) {
    console.error("Error fetching stats from Redis:", error);
    return { highPriority: 0, lowPriority: 0, dlq: 0, processing: 0 }; // <-- ADD THIS
  }
};

const startServer = async () => {
  await redisClient.connect();
  server.listen(4001, () => {
    console.log('📊 Dashboard server is running on port 4001');
  });

  // Start ONE global poller that broadcasts to everyone
  setInterval(async () => {
    const stats = await getSystemStats();
    io.emit('systemStats', stats); // Broadcast to all
  }, 2000); // Poll every 2 seconds
};

// Simple connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

startServer();