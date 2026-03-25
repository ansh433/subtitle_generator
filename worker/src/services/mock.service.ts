import { ITranscriptionService } from './transcription.service.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export class MockService implements ITranscriptionService {
  async transcribe(audioS3Key: string): Promise<string> {
    console.log(`[MockService] Simulating transcription for ${audioS3Key}`);
    
    // Simulate a brief processing delay
    await delay(2500);
    
    // Return a valid, hardcoded SRT string instead of an array of objects
    return `1
00:00:01,000 --> 00:00:04,000
This is a mock subtitle generated locally.

2
00:00:04,500 --> 00:00:08,000
It skips the AssemblyAI API to save credits during dev.`;
  }
}