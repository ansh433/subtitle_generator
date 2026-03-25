// worker/src/interfaces/job-processor.interface.ts

export interface JobData {
  jobId: string;
  type: "transcribe" | "embed_subtitles"; // ✅ Change to lowercase
  videoUrl: string;
  audioUrl?: string;
  subtitleUrl?: string;
  status: string;
  priority: string;
  createdAt: string;
  retryCount?: string;
  error?: string;
}

export interface IJobProcessor {
  /**
   * Process a job of this type
   * @param jobData - Complete job data from Redis
   * @returns S3 key of the output file
   */
  process(jobData: JobData): Promise<string>;
}
