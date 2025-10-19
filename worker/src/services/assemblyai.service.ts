import { AssemblyAI } from 'assemblyai';
import { ITranscriptionService, TranscriptSegment } from './transcription.service.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export class AssemblyAiService implements ITranscriptionService {
  private assemblyClient: AssemblyAI;
  private s3Client: S3Client;
  private S3_BUCKET: string;

  constructor(s3Client: S3Client, s3Bucket: string) {
    if (!process.env.ASSEMBLYAI_API_KEY) {
      throw new Error('ASSEMBLYAI_API_KEY is not set.');
    }

    this.assemblyClient = new AssemblyAI({
      apiKey: process.env.ASSEMBLYAI_API_KEY,
    });

    this.s3Client = s3Client;
    this.S3_BUCKET = s3Bucket;
  }

  private async getPresignedS3Url(s3Key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.S3_BUCKET,
      Key: s3Key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: 60 });
  }

  async transcribe(audioS3Key: string): Promise<TranscriptSegment[]> {
    console.log(`[AssemblyAiService] Starting transcription for ${audioS3Key}`);

    const audioUrl = await this.getPresignedS3Url(audioS3Key);

    let transcript = await this.assemblyClient.transcripts.transcribe({
      audio_url: audioUrl,
    });

    while (transcript.status !== 'completed' && transcript.status !== 'error') {
      await delay(3000);
      transcript = await this.assemblyClient.transcripts.get(transcript.id);
      console.log(`[AssemblyAiService] Job ${transcript.id} status: ${transcript.status}`);
    }

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    if (!transcript.words) {
      console.warn('[AssemblyAiService] No words in transcript, returning empty array.');
      return [];
    }

    if (transcript.utterances) {
      return transcript.utterances.map(u => ({
        text: u.text,
        start: u.start,
        end: u.end,
      }));
    } else {
      return [{
        text: transcript.text || '',
        start: 0,
        end: transcript.audio_duration ? transcript.audio_duration * 1000 : 0
      }];
    }
  }
}
