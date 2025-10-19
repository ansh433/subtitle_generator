// In frontend/src/App.tsx

import { useState, useEffect } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client'; 
import './App.css';

interface SystemStats {
  highPriority: number;
  lowPriority: number;
  dlq: number;
  processing: number; 
}

function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    // Connect to our dashboard server
    const socket = io('http://localhost:4001');

    socket.on('connect', () => {
      console.log('Connected to dashboard server!');
    });

    // Listen for the 'systemStats' event
    socket.on('systemStats', (data: SystemStats) => {
      setStats(data);
    });

    // Cleanup on component unmount
    return () => {
      socket.disconnect();
    };
  }, []); // Empty dependency array so this runs once

  return (
    <div className="dashboard">
      <h2>Live System Status</h2>
      {stats ? (
        <div className="stats-grid">
          <div className="stat-box high-priority">
            <h3>High Priority</h3>
            <span>{stats.highPriority}</span>
          </div>

          {/* --- 3. ADD THIS NEW BOX --- */}
          <div className="stat-box processing">
            <h3>Processing</h3>
            <span>{stats.processing}</span>
          </div>

          <div className="stat-box low-priority">
            <h3>Low Priority</h3>
            <span>{stats.lowPriority}</span>
          </div>
          <div className="stat-box dlq">
            <h3>Dead-Letter (DLQ)</h3>
            <span>{stats.dlq}</span>
          </div>
        </div>
      ) : (
        <p>Connecting to dashboard...</p>
      )}
    </div>
  );
}

// --- UPLOADER COMPONENT (Same as before) ---
function Uploader() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setSelectedFile(event.target.files[0]);
    }
  };

  const handleUpload = async () => {
    // ... (this entire function is identical to before)
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
      setStatusMessage('2/3: Uploading video...');
      await axios.put(preSignedUrl, selectedFile, {
        headers: { 'Content-Type': selectedFile.type },
      });
      setStatusMessage('3/3: Creating processing job...');
      const jobResponse = await axios.post('http://localhost:3000/jobs', {
        videoUrl: key,
      });
      setJobId(jobResponse.data.jobId);
      setStatusMessage('Job created successfully!');
    } catch (error) {
      console.error('Error during upload process:', error);
      setStatusMessage('Upload process failed. See console.');
    }
  };

  return (
    <div className="uploader">
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
    </div>
  );
}

// --- MAIN APP COMPONENT ---
function App() {
  return (
    <div className="App">
      <header className="App-header">
        <Uploader />
        <Dashboard />
      </header>
    </div>
  );
}

export default App;