// In worker/src/services/transcription.factory.ts

import { ITranscriptionService } from './transcription.service.js';
import { AssemblyAiService } from './assemblyai.service.js';
import { MockService } from './mock.service.js';
import { S3Client } from '@aws-sdk/client-s3';

/**
 * Instantiates and returns the correct transcription service
 * based on environment variables.
 */
export const getTranscriptionService = (
  s3Client: S3Client,
  s3Bucket: string
): ITranscriptionService => {

  const provider = process.env.TRANSCRIPTION_PROVIDER;

  switch (provider) {
    case 'assemblyai':
      console.log('Using AssemblyAI for transcription.');
      // Pass S3 dependencies to the service that needs them
      return new AssemblyAiService(s3Client, s3Bucket);

    case 'mock':
      console.log('Using MOCK service for transcription.');
      // Mock service doesn't need S3, so we don't pass them
      return new MockService();

    default:
      console.warn(`No provider set, defaulting to MOCK service.`);
      return new MockService();
  }
};