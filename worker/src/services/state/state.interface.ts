// worker/src/services/state/state.interface.ts

export interface JobCheckpoint {
  audioS3Key?: string;        // S3 key of extracted audio
  transcriptJson?: string;    // Raw AssemblyAI JSON response
  srtS3Key?: string;          // S3 key of generated SRT file
}

export interface IStateService {
  /**
   * Update the status of a job
   * @param jobId - Unique job identifier
   * @param status - New status value
   */
  updateStatus(jobId: string, status: string): Promise<void>;

  /**
   * Save checkpoint data for a job (enables resume on failure)
   * @param jobId - Unique job identifier
   * @param checkpoint - Intermediate results to save
   */
  saveCheckpoint(jobId: string, checkpoint: Partial<JobCheckpoint>): Promise<void>;

  /**
   * Retrieve checkpoint data for a job
   * @param jobId - Unique job identifier
   * @returns Checkpoint data if exists, null otherwise
   */
  getCheckpoint(jobId: string): Promise<JobCheckpoint | null>;

  /**
   * Save the final output URL for a job
   * @param jobId - Unique job identifier
   * @param outputUrl - S3 key of the final result
   */
  saveOutput(jobId: string, outputUrl: string): Promise<void>;
}