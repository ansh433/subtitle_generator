export interface ITranscriptionService {
  /**
   * @param audioIdentifier The S3 key or public URL of the audio file to transcribe.
   * @returns A Promise that resolves to a fully formatted SRT string.
   */
  transcribe(audioIdentifier: string): Promise<string>;
}