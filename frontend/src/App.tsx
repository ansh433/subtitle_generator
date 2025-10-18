// frontend/src/App.tsx

import { useState } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setSelectedFile(event.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setStatusMessage('Please select a file first.');
      return;
    }

    setStatusMessage('1/3: Getting secure upload URL...');
    setJobId(null);

    try {
      const urlResponse = await axios.post('http://localhost:3000/jobs/signed-url', {
        fileName: selectedFile.name,
        fileType: selectedFile.type,
      });
      const { preSignedUrl, key } = urlResponse.data;

      setStatusMessage('2/3: Uploading video directly to cloud storage...');

      await axios.put(preSignedUrl, selectedFile, {
        headers: { 'Content-Type': selectedFile.type },
      });

      setStatusMessage('3/3: Video uploaded! Creating processing job...');

      const jobResponse = await axios.post('http://localhost:3000/jobs', {
        videoUrl: key,
      });

      setJobId(jobResponse.data.jobId);
      setStatusMessage('Job created successfully!');
    } catch (error) {
      console.error('Error during upload process:', error);
      setStatusMessage('Upload process failed. See console for details.');
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Upload Video for Subtitles</h1>
        <input type="file" onChange={handleFileChange} />
        <button onClick={handleUpload} disabled={!selectedFile}>
          Generate Subtitles
        </button>

        {statusMessage && <p>{statusMessage}</p>}
        {jobId && (
          <div className="job-id-container">
            <p>Your Job ID is:</p>
            <code>{jobId}</code>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
