// In worker/src/services/mock.service.ts

import { ITranscriptionService, TranscriptSegment } from './transcription.service.js';

export class MockService implements ITranscriptionService {
    // In worker/src/services/mock.service.ts
async transcribe(audioS3Key: string): Promise<TranscriptSegment[]> {
  console.log(`[MockService] SIMULATING FAILURE for ${audioS3Key}`);
  throw new Error("MockService: AI transcription service is down!");
}
 
}

//  async transcribe(audioS3Key: string): Promise<TranscriptSegment[]> {
//     console.log(`[MockService] Transcribing ${audioS3Key}... This will take 7 seconds.`);

//     await new Promise(resolve => setTimeout(resolve, 7000)); // Simulate delay

//     console.log(`[MockService] Transcription complete for ${audioS3Key}.`);

//     // Return a fake, structured transcript
//     return [
//       { text: "Hello, this is a MOCK transcript.", start: 1000, end: 2500 },
//       { text: "The real service has been swapped out.", start: 3000, end: 6000 },
//       { text: "Testing complete.", start: 6500, end: 8000 }
//     ];
//   }