export interface TranscriptSegment {
  
  text: string;
  
  start: number;
  
  end: number;
}


export interface ITranscriptionService {
  /**
   * @param audioIdentifier The S3 key or public URL of the audio file to transcribe.
   * @returns A Promise that resolves to an array of TranscriptSegment objects.
   */
  transcribe(audioIdentifier: string): Promise<TranscriptSegment[]>;
}