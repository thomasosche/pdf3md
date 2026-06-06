// src/App.jsx
import { useState, useRef, useEffect } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import Sidebar from './components/Sidebar'
import MultiFileUploadStatus from './components/MultiFileUploadStatus' // Import the new component
import './App.css'
import './components/LoadingStyles.css'
import './components/MultiFileUploadStatus.css' // Import its CSS

function App() {
  const [markdown, setMarkdown] = useState('')
  const [markdownFilename, setMarkdownFilename] = useState('') // Original source filename of the displayed markdown
  const [isLoading, setIsLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [showPreview, setShowPreview] = useState(false) // Toggle rendered markdown preview vs raw text
  const [widePreview, setWidePreview] = useState(false) // Use full window width for the preview
  const [history, setHistory] = useState([])
  const [selectedHistoryId, setSelectedHistoryId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true) // Start open on desktop, will be handled by mobile detection
  const [currentFile, setCurrentFile] = useState(null) // Represents the file currently being processed
  const [uploadQueue, setUploadQueue] = useState([]); // Holds files selected for upload
  const [fileUploadStates, setFileUploadStates] = useState([]); // Tracks status of each file in a batch
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingStage, setLoadingStage] = useState('')
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(0)
  const [isMobile, setIsMobile] = useState(false)
  const [mode, setMode] = useState('pdf-to-md') // 'pdf-to-md' or 'md-to-word'
  const [markdownInput, setMarkdownInput] = useState('')
  const [isConverting, setIsConverting] = useState(false)
  const fileInputRef = useRef(null)
  const isInitialMount = useRef(true); // Ref to track initial mount
  const activeConversionId = useRef(null); // Tracks the current conversion ID for polling

  // Check if device is mobile
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Load history from localStorage on component mount
  useEffect(() => {
    const savedHistory = localStorage.getItem('pdf3md-history');
    console.log('Loading history from localStorage:', savedHistory);
    if (savedHistory) {
      try {
        const parsedHistory = JSON.parse(savedHistory);
        console.log('Parsed history:', parsedHistory);
        if (Array.isArray(parsedHistory)) {
          setHistory(parsedHistory);
        } else {
          console.error('Loaded history is not an array. Resetting history.');
          setHistory([]);
        }
      } catch (error) {
        console.error('Error parsing history from localStorage. Resetting history:', error);
        setHistory([]);
      }
    } else {
      console.log('No history found in localStorage.');
    }
  }, []);

  // Save history to localStorage whenever it changes
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false; // Set to false after first run, so subsequent runs will save
      // Optionally, if history is already populated by the load effect synchronously
      // AND the load effect runs before this save effect on mount,
      // you might not even need to log here or could log differently.
      // However, the primary goal is to prevent saving the initial empty `history` state.
      console.log('Skipping initial save of history to localStorage.');
      return;
    }
    try {
      const historyToSave = JSON.stringify(history);
      console.log('Saving history to localStorage (actual save):', historyToSave);
      localStorage.setItem('pdf3md-history', historyToSave);
    } catch (error) {
      console.error('Error saving history to localStorage:', error);
    }
  }, [history]);

  // Effect to process files from the uploadQueue one by one
  useEffect(() => {
    if (uploadQueue.length > 0 && !isLoading) {
      const fileToProcess = uploadQueue[0];
      setUploadQueue(prevQueue => prevQueue.slice(1));
      processFile(fileToProcess);
    } else if (uploadQueue.length === 0 && !isLoading && fileUploadStates.length > 0) {
      const allSuccessfullyCompleted = fileUploadStates.every(f => f.status === 'Completed' || f.status === 'Skipped');
      const hasErrors = fileUploadStates.some(f => f.status === 'Error');

      if (allSuccessfullyCompleted && !hasErrors) {
        // All files completed successfully, no errors
        const timer = setTimeout(() => {
          // Check again before clearing, in case new files were added
          if (uploadQueue.length === 0 && fileUploadStates.every(f => f.status === 'Completed' || f.status === 'Skipped') && !fileUploadStates.some(f => f.status === 'Error')) {
            setFileUploadStates([]); // Auto-hide modal
          }
        }, 5000); // Hide after 5 seconds
        return () => clearTimeout(timer);
      }
      // If there are errors, or still processing, the modal remains visible.
    }
  }, [uploadQueue, isLoading, fileUploadStates]);


  const updateFileStatus = (fileName, newStatus) => {
    setFileUploadStates(prevStates =>
      prevStates.map(fileState =>
        fileState.name === fileName ? { ...fileState, ...newStatus } : fileState
      )
    );
  };

  const addToHistory = (conversionData) => {
    const historyItem = {
      id: Date.now(),
      filename: conversionData.filename,
      markdown: conversionData.markdown,
      fileSize: conversionData.fileSize,
      pageCount: conversionData.pageCount,
      timestamp: conversionData.timestamp
    };

    setHistory(prevHistory => {
      const newHistory = [historyItem, ...prevHistory];
      return newHistory.slice(0, 50);
    });

    // For multi-file, we might not want to auto-select the last converted item's markdown immediately
    // setSelectedHistoryId(historyItem.id); 
  };

  // Helper function to get the backend URL
  const getBackendUrl = () => {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;

    if (hostname === 'localhost') {
      // Scenario 1: Localhost development (e.g., http://localhost:3000)
      return 'http://localhost:6201';
    } else if (hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      // Scenario 2: Direct IP access (e.g., http://192.168.X.Y:3000)
      // Backend is on the same IP, but port 6201
      return `${protocol}//${hostname}:6201`;
    } else {
      // Scenario 3: Domain name access (e.g., http://pdf2md.local/)
      // Assumes reverse proxy routes /api to the backend on port 6201
      return `${protocol}//${hostname}/api`;
    }
  };

  const pollProgress = async (conversionId, fileName) => {
    activeConversionId.current = conversionId;
    const pollInterval = setInterval(async () => {
      if (activeConversionId.current !== conversionId) {
        clearInterval(pollInterval); // Stop polling if a new conversion has started
        return;
      }
      try {
        const response = await fetch(`${getBackendUrl()}/progress/${conversionId}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const progressData = await response.json();

        setLoadingProgress(progressData.progress || 0);
        setLoadingStage(progressData.stage || 'Processing...');
        setTotalPages(progressData.total_pages || 0);
        setCurrentPage(progressData.current_page || 0);
        updateFileStatus(fileName, { 
          progress: progressData.progress || 0, 
          stage: progressData.stage || 'Processing...',
          totalPages: progressData.total_pages || 0,
          currentPage: progressData.current_page || 0,
        });

        if (progressData.status === 'completed' && progressData.result) {
          clearInterval(pollInterval);
          activeConversionId.current = null;
          setMarkdown(progressData.result.markdown); // Display the latest markdown
          setMarkdownFilename(progressData.result.filename || fileName);
          addToHistory(progressData.result);
          updateFileStatus(fileName, { status: 'Completed', markdown: progressData.result.markdown, progress: 100 });
          
          // Reset for next file or finish
          setIsLoading(false); // This will trigger the useEffect to process next file in queue
          setCurrentFile(null); 
          // Don't reset global loading progress/stage here if queue has items
          if (uploadQueue.length === 0) {
            setLoadingProgress(0);
            setLoadingStage('');
            setTotalPages(0);
            setCurrentPage(0);
          }
        } else if (progressData.status === 'error') {
          clearInterval(pollInterval);
          activeConversionId.current = null;
          // alert(`Conversion failed for ${fileName}: ${progressData.error}`); // Removed alert for better UX with multi-upload
          console.error(`Conversion failed for ${fileName}:`, progressData.error);
          updateFileStatus(fileName, { 
            status: 'Error', 
            error: progressData.error || 'Unknown conversion error', 
            progress: 0, 
            stage: 'Error' 
          });
          setIsLoading(false); // Allow next file in queue to process
          setCurrentFile(null);
          if (uploadQueue.length === 0) {
            setLoadingProgress(0);
            setLoadingStage('');
            setTotalPages(0);
            setCurrentPage(0);
          }
        }
      } catch (error) {
        console.error('Error polling progress:', error);
        clearInterval(pollInterval);
        activeConversionId.current = null;
        // alert(`Error checking conversion progress for ${fileName}. Please try again.`); // Removed alert
        console.error(`Error polling progress for ${fileName}:`, error.message);
        updateFileStatus(fileName, { 
          status: 'Error', 
          error: `Polling failed: ${error.message}`, 
          progress: 0,
          stage: 'Error' 
        });
        setIsLoading(false);
        setCurrentFile(null);
        if (uploadQueue.length === 0) {
            setLoadingProgress(0);
            setLoadingStage('');
            setTotalPages(0);
            setCurrentPage(0);
          }
      }
    }, 500);
    return pollInterval;
  };

  const processFile = async (file) => {
    if (!file) return;

    const isPdf = file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
    const isDocx = file.type.includes('vnd.openxmlformats-officedocument.wordprocessingml.document') || file.name.toLowerCase().endsWith('.docx');

    if (!isPdf && !isDocx) {
      alert(`Skipping unsupported file: ${file.name}. Only PDF and DOCX files are supported.`);
      updateFileStatus(file.name, { status: 'Skipped', error: 'Unsupported file type' });
      // Process next file if any
      if (uploadQueue.length > 0) {
        const nextFile = uploadQueue[0];
        setUploadQueue(prev => prev.slice(1));
        processFile(nextFile);
      } else {
        setIsLoading(false); // No more files
      }
      return;
    }

    setIsLoading(true); // Global loading state for the current file
    setCurrentFile(file); // Set current file being processed
    setLoadingProgress(0);
    setLoadingStage('Uploading file...');
    updateFileStatus(file.name, { status: 'Uploading', progress: 0, stage: 'Uploading file...' });

    const formData = new FormData();
    let endpoint = '';
    let fileKey = '';

    if (isPdf) {
      formData.append('pdf', file);
      endpoint = `/convert`;
      fileKey = 'pdf';
    } else if (isDocx) {
      formData.append('document', file);
      endpoint = `/convert-word-to-markdown`;
      fileKey = 'document';
    }

    try {
      const response = await fetch(`${getBackendUrl()}${endpoint}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const data = await response.json();

      if (isPdf) {
        if (data.success && data.conversion_id) {
          updateFileStatus(file.name, { status: 'Processing', stage: 'Waiting for conversion...' });
          pollProgress(data.conversion_id, file.name);
        } else {
          throw new Error(data.error || 'PDF conversion failed to start');
        }
      } else if (isDocx) {
        // DOCX conversion is synchronous
        if (data.success && data.markdown) {
          setMarkdown(data.markdown); // Display the markdown
          setMarkdownFilename(data.filename || file.name);
          addToHistory(data); // Add to history (data should match history item structure)
          updateFileStatus(file.name, { status: 'Completed', markdown: data.markdown, progress: 100, stage: 'Completed' });
          setIsLoading(false);
          setCurrentFile(null);
          // Reset progress/stage/page counts if queue is empty or if it was a DOCX file
          if (uploadQueue.length === 0 || isDocx) { 
            setLoadingProgress(0);
            setLoadingStage('');
            setTotalPages(0); 
            setCurrentPage(0);
          }
        } else {
          throw new Error(data.error || 'Word to Markdown conversion failed');
        }
      }
    } catch (err) {
      console.error(`Error during ${isPdf ? 'PDF' : 'Word'} conversion for ${file.name}:`, err);
      alert(`Error starting ${isPdf ? 'PDF' : 'Word'} conversion for ${file.name}. Please try again.`);
      updateFileStatus(file.name, { status: 'Error', error: err.message || `Failed to start ${isPdf ? 'PDF' : 'Word'} conversion` });
      setIsLoading(false); // Allow next file in queue to process
      setCurrentFile(null);
       if (uploadQueue.length === 0) { // Reset global progress if queue is empty
        setLoadingProgress(0);
        setLoadingStage('');
        setTotalPages(0); // Ensure totalPages is reset for non-PDFs or errors
        setCurrentPage(0); // Ensure currentPage is reset
      }
    }
  };

  const handleFilesSelected = (selectedFiles) => {
    if (selectedFiles.length === 0) return;

    const newFileEntries = Array.from(selectedFiles)
      .filter(file => {
        const isPdf = file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
        const isDocx = file.type.includes('vnd.openxmlformats-officedocument.wordprocessingml.document') || file.name.toLowerCase().endsWith('.docx');
        return isPdf || isDocx;
      })
      .map(file => ({
        name: file.name,
        size: file.size,
        type: file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx', // Store type
        status: 'Queued', // Initial status
        progress: 0,
        stage: 'Queued',
        totalPages: 0, // Will be updated by PDF polling
        currentPage: 0, // Will be updated by PDF polling
        markdown: null,
        error: null,
        originalFile: file // Keep original file object for processing
      }));

    if (newFileEntries.length === 0 && selectedFiles.length > 0) {
      alert('No PDF or DOCX files selected, or all files were invalid.');
      return;
    }
    
    // If there are already files being processed or in queue, add to existing, otherwise start new batch
    setFileUploadStates(prevStates => {
        // If the previous batch is fully done, replace. Otherwise, append.
        const isPreviousBatchDone = prevStates.every(f => f.status === 'Completed' || f.status === 'Error' || f.status === 'Skipped');
        return isPreviousBatchDone ? newFileEntries : [...prevStates, ...newFileEntries];
    });
    setUploadQueue(prevQueue => [...prevQueue, ...newFileEntries.map(entry => entry.originalFile)]); // Add original files to processing queue
    
    // Clear main markdown display when new files are added
    setMarkdown('');
    setMarkdownFilename('');
    setSelectedHistoryId(null);
  };

  const handleClearCompletedStatuses = () => {
    setFileUploadStates([]); 
  };

  const handleRetryFile = (fileToRetry) => {
    // Find the file in the current states to get its original details if needed
    // For simplicity, we assume fileToRetry is the original file object
    // or an object that can be directly processed by processFile.
    
    // Update its status to 'Queued' and add to the processing queue
    setFileUploadStates(prevStates =>
      prevStates.map(fs => 
        fs.name === fileToRetry.name 
        ? { ...fs, status: 'Queued', stage: 'Queued', progress: 0, error: null } 
        : fs
      )
    );
    setUploadQueue(prevQueue => [fileToRetry, ...prevQueue]); // Add to front of queue for immediate retry
  };

  const handleRemoveFileStatus = (fileNameToRemove) => {
    setFileUploadStates(prevStates => prevStates.filter(f => f.name !== fileNameToRemove));
    // If the removed file was in the uploadQueue, it should also be removed,
    // but current logic processes queue first. This action is mostly for display cleanup post-processing.
  };


  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFilesSelected(files);
    }
  };

  const handleFileInput = (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFilesSelected(files);
    }
    // Reset file input to allow selecting the same file(s) again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault()
  }

  const handleDragEnter = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleSelectHistory = (historyItem) => {
    // Display history item's markdown
    setMarkdown(historyItem.markdown);
    setMarkdownFilename(historyItem.filename || '');
    setSelectedHistoryId(historyItem.id);

    // DO NOT interfere with ongoing uploads.
    // The main loading indicator's visibility will be controlled
    // by a combination of `isLoading` and whether `markdown` is set.
    // setCurrentFile(null); // No longer clearing this, as it's for active upload
    // setIsLoading(false);  // No longer setting this, to allow uploads to continue
    // setLoadingProgress(0); 
    // setLoadingStage('');
    // setTotalPages(0);
    // setCurrentPage(0);
    
    // Close sidebar on mobile after selecting an item
    if (isMobile) {
      setSidebarOpen(false);
    }
  };

  const handleClearHistory = () => {
    if (window.confirm('Are you sure you want to clear all conversion history? This action cannot be undone.')) {
      setHistory([])
      setSelectedHistoryId(null)
      localStorage.removeItem('pdf3md-history')
    }
  }

  const handleDeleteHistory = (itemId) => {
    setHistory(prevHistory => {
      const newHistory = prevHistory.filter(item => item.id !== itemId)
      return newHistory
    })
    
    // If the deleted item was selected, clear the selection
    if (selectedHistoryId === itemId) {
      setSelectedHistoryId(null)
      setMarkdown('')
      setMarkdownFilename('')
    }
  }

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen)
  }

  const copyToClipboard = () => {
    try {
      // Create temporary textarea
      const textArea = document.createElement('textarea');
      textArea.value = markdown;
      
      // Make it invisible but keep it in the document flow
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      
      // Select and copy
      textArea.select();
      document.execCommand('copy');
      
      // Clean up
      document.body.removeChild(textArea);
      
      // Show feedback
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard: ' + err.message);
    }
  };

  // Turn an original source filename (e.g. "Report.pdf") into "Report.md".
  const mdNameFor = (sourceName) => `${(sourceName || 'document').replace(/\.[^/.]+$/, '')}.md`;

  // Trigger a browser download of markdown text under the given filename.
  const triggerMdDownload = (filename, mdText) => {
    const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  // Resolve the .md filename for the currently displayed markdown, named
  // after the original source file (PDF or DOCX).
  const getMarkdownFilename = () => {
    const match = fileUploadStates.find(f => f.markdown === markdown);
    const source = markdownFilename || match?.name || currentFile?.name || 'document';
    return mdNameFor(source);
  };

  const downloadMarkdown = () => {
    try {
      triggerMdDownload(getMarkdownFilename(), markdown);
    } catch (err) {
      console.error('Failed to download markdown:', err);
      alert('Failed to download markdown: ' + err.message);
    }
  };

  // Download a single history item as <originalName>.md
  const handleDownloadHistory = (item) => {
    try {
      triggerMdDownload(mdNameFor(item.filename), item.markdown);
    } catch (err) {
      console.error('Failed to download markdown:', err);
      alert('Failed to download markdown: ' + err.message);
    }
  };

  // Download every history item as its own .md file, deduplicating
  // identical filenames with a numeric suffix.
  const handleDownloadAllHistory = () => {
    if (!history.length) return;
    const usedNames = {};
    history.forEach((item, i) => {
      let name = mdNameFor(item.filename);
      if (usedNames[name]) {
        const n = ++usedNames[name];
        name = name.replace(/\.md$/, `-${n}.md`);
      } else {
        usedNames[name] = 1;
      }
      // Stagger slightly so the browser reliably processes multiple downloads.
      setTimeout(() => triggerMdDownload(name, item.markdown), i * 200);
    });
  };

  const handleMarkdownToWord = async () => {
    if (!markdownInput.trim()) {
      alert('Please enter some markdown content to convert');
      return;
    }

    setIsConverting(true);

    try {
        const response = await fetch(`${getBackendUrl()}/convert-markdown-to-word`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          markdown: markdownInput,
          filename: 'markdown-document'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Get the blob from the response
      const blob = await response.blob();
      
      // Create a download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      
      // Get filename from response headers or use default
      const contentDisposition = response.headers.get('content-disposition');
      let filename = 'document.docx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      
      // Clean up
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
    } catch (err) {
      console.error('Error converting markdown to Word:', err);
      alert('Error converting markdown to Word. Please try again.');
    } finally {
      setIsConverting(false);
    }
  };

  return (
    <div className="app-layout">
      {mode === 'pdf-to-md' && (
        <Sidebar
          isOpen={sidebarOpen}
          history={history}
          onSelectHistory={handleSelectHistory}
          selectedHistoryId={selectedHistoryId}
          onClearHistory={handleClearHistory}
          onDeleteHistory={handleDeleteHistory}
          onDownloadHistory={handleDownloadHistory}
          onDownloadAll={handleDownloadAllHistory}
          onClose={() => setSidebarOpen(false)}
        />
      )}
      
      <div className={`main-content ${mode === 'pdf-to-md' && sidebarOpen ? 'with-sidebar' : ''}`}>
        {/* Multi-file upload status modal */}
        {fileUploadStates.length > 0 && mode === 'pdf-to-md' && (
          <MultiFileUploadStatus
            fileStates={fileUploadStates}
            onClearCompleted={handleClearCompletedStatuses}
            onRetryFile={handleRetryFile}
            onRemoveFile={handleRemoveFileStatus}
          />
        )}

        <div className="top-bar">
          {mode === 'pdf-to-md' && (
            <button 
              className="sidebar-toggle"
              onClick={toggleSidebar}
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
          )}
          <div className="app-title">
            <h1>{mode === 'pdf-to-md' ? 'PDF to Markdown Converter' : 'Markdown to Word Converter'}</h1>
          </div>
          <div className="top-bar-controls">
            {mode === 'pdf-to-md' && (
              <button 
                className="file-select-btn"
                onClick={() => fileInputRef.current?.click()} // Allow click even if loading to add to queue
                // disabled={isLoading} // Removed: Allow adding to queue even when loading
                title="Select PDF file"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                Select File
              </button>
            )}
            <div
              className="mode-switcher"
              onClick={() => setMode(prevMode => prevMode === 'pdf-to-md' ? 'md-to-word' : 'pdf-to-md')}
              title={mode === 'pdf-to-md' ? "Current mode: PDF to Markdown. Click to switch to Markdown to Word." : "Current mode: Markdown to Word. Click to switch to PDF to Markdown."}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault(); // Prevent default space scroll
                  setMode(prevMode => prevMode === 'pdf-to-md' ? 'md-to-word' : 'pdf-to-md');
                }
              }}
              style={{ cursor: 'pointer' }} // Add cursor pointer to the div
            >
              <div
                className={`mode-btn ${mode === 'pdf-to-md' ? 'active' : ''}`}
                // Removed title here as parent has comprehensive title
              >
                PDF → MD
              </div>
              <div
                className={`mode-btn ${mode === 'md-to-word' ? 'active' : ''}`}
                // Removed title here as parent has comprehensive title
              >
                MD → Word
              </div>
            </div>
          </div>
        </div>

        <div 
          className={`container universal-drop-zone ${isDragging ? 'dragging' : ''} ${isLoading ? 'loading' : ''} ${showPreview && widePreview ? 'wide' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
        >
          <input 
            type="file" 
            ref={fileInputRef}
            onChange={handleFileInput}
            accept=".pdf,.docx" // Accept both PDF and DOCX files
            style={{ display: 'none' }}
            // disabled={isLoading && uploadQueue.length > 0} // Removed: Allow adding to queue
            multiple // Allow multiple file selection
          />
          
          <div className="app-wrapper">
            {/* Welcome message: Show if not loading, no history markdown selected, and PDF-to-MD mode */}
            {mode === 'pdf-to-md' && !markdown && !isLoading && fileUploadStates.length === 0 && (
              <div className="welcome-content">
                <div className="welcome-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                  </svg>
                </div>
                <h2>Drop your PDF or Word file anywhere to convert</h2>
                <p>Drag and drop a PDF or Word (.docx) file anywhere on this page, or use the "Select File" button in the top right corner</p>
              </div>
            )}

            {mode === 'md-to-word' && (
              <div className="markdown-to-word-container">
                <div className="markdown-input-section">
                  <div className="input-header">
                    <h3>Enter your Markdown content</h3>
                    <p>Type or paste your Markdown text below and convert it to a Word document</p>
                  </div>
                  <textarea
                    className="markdown-input"
                    value={markdownInput}
                    onChange={(e) => setMarkdownInput(e.target.value)}
                    placeholder="# Your Markdown Here"
                    disabled={isConverting}
                  />
                  <div className="input-actions">
                    <button
                      className={`convert-btn ${isConverting ? 'converting' : ''}`}
                      onClick={handleMarkdownToWord}
                      disabled={isConverting || !markdownInput.trim()}
                    >
                      {isConverting ? (
                        <>
                          <div className="spinner"></div>
                          Converting...
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                          Download as Word
                        </>
                      )}
                    </button>
                    <button
                      className="clear-btn"
                      onClick={() => setMarkdownInput('')}
                      disabled={isConverting || !markdownInput.trim()}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Main loading indicator: Show if actively processing a file AND no history markdown is being viewed */}
            {isLoading && !markdown && ( 
              <div className="loading-content">
                <div className="loading-visual">
                  <div className="progress-ring">
                    <svg className="progress-circle" viewBox="0 0 120 120">
                      <circle
                        className="progress-circle-bg"
                        cx="60"
                        cy="60"
                        r="50"
                        fill="none"
                        stroke="rgba(59, 130, 246, 0.1)"
                        strokeWidth="8"
                      />
                      <circle
                        className="progress-circle-fill"
                        cx="60"
                        cy="60"
                        r="50"
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={`${2 * Math.PI * 50}`}
                        strokeDashoffset={`${2 * Math.PI * 50 * (1 - loadingProgress / 100)}`}
                        transform="rotate(-90 60 60)"
                      />
                    </svg>
                    <div className="progress-percentage">{loadingProgress}%</div>
                  </div>
                </div>
                <div className="loading-text">
                  <p>{loadingStage || "Preparing..."}</p>
                  {currentFile && ( 
                    <div className="file-info">
                      <span className="filename">📄 {currentFile.name}</span>
                      <span className="file-size">
                        {(currentFile.size / (1024 * 1024)).toFixed(1)} MB
                      </span>
                      {/* Conditional page info: only for PDFs (totalPages will be > 0 for PDFs during polling) */}
                      {(currentFile.type.includes('pdf') || currentFile.name.toLowerCase().endsWith('.pdf')) && totalPages > 0 && (
                        <span className="page-info">
                          {currentPage > 0 ? `Page ${currentPage} of ${totalPages}` : `${totalPages} pages total`}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="progress-bar">
                    <div 
                      className="progress-fill" 
                      style={{ width: `${loadingProgress}%` }}
                    ></div>
                  </div>
                   {fileUploadStates.length > 1 && (
                    <div className="batch-info">
                      Processing file {fileUploadStates.findIndex(f => f.name === currentFile?.name) + 1} of {fileUploadStates.length}
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* Display area for markdown (from history or a fresh conversion if queue is empty and not loading) */}
            {mode === 'pdf-to-md' && markdown && (
              // Condition to show markdown:
              // - If isLoading is false (meaning no active file processing for the main display)
              // - OR if isLoading is true, but we are viewing a history item (markdown is set, selectedHistoryId is set)
              // This allows viewing history while uploads happen in the modal.
              (!isLoading || (isLoading && selectedHistoryId)) &&
              <div className="markdown-container">
                <div className="markdown-header">
                  <h3>Converted Markdown</h3>
                  <div className="markdown-actions">
                    {showPreview && (
                      <button
                        onClick={() => setWidePreview(w => !w)}
                        className={`copy-button ${widePreview ? 'active' : ''}`}
                        title={widePreview ? 'Use normal width' : 'Use full window width'}
                      >
                        {widePreview ? (
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9 4.5 4.5M9 9v-3.75M9 9H5.25M15 9l4.5-4.5M15 9v-3.75M15 9h3.75M9 15l-4.5 4.5M9 15v3.75M9 15H5.25M15 15l4.5 4.5M15 15v3.75M15 15h3.75" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                          </svg>
                        )}
                        {widePreview ? 'Narrow' : 'Wide'}
                      </button>
                    )}
                    <button
                      onClick={() => setShowPreview(p => !p)}
                      className={`copy-button ${showPreview ? 'active' : ''}`}
                      title={showPreview ? 'Show raw Markdown' : 'Show rendered preview'}
                    >
                      {showPreview ? (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
                          </svg>
                          Raw
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                          </svg>
                          Preview
                        </>
                      )}
                    </button>
                    <button
                      onClick={downloadMarkdown}
                      className="copy-button"
                      title={`Download ${getMarkdownFilename()}`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      Download .md
                    </button>
                    <button
                      onClick={copyToClipboard}
                      className={`copy-button ${isCopied ? 'copied' : ''}`}
                    >
                      {isCopied ? (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                          </svg>
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <div className="markdown-content">
                  {showPreview ? (
                    <div
                      className="markdown-preview"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(marked.parse(markdown, { breaks: true }))
                      }}
                    />
                  ) : (
                    <pre>{markdown}</pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
