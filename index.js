#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import axios from 'axios';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const program = new Command();

// Default segment time in seconds (1 hour)
const DEFAULT_SEGMENT_SECONDS = 3600;

// Default retention in days (90 days)
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Get segment time from env var or default
 */
function getSegmentSeconds() {
  const envValue = process.env.SEGMENT_SECONDS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(`⚠️  Invalid SEGMENT_SECONDS value "${envValue}", using default ${DEFAULT_SEGMENT_SECONDS}`);
  }
  return DEFAULT_SEGMENT_SECONDS;
}

/**
 * Get retention days from env var or default
 */
function getRetentionDays() {
  const envValue = process.env.RETENTION_DAYS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(`⚠️  Invalid RETENTION_DAYS value "${envValue}", using default ${DEFAULT_RETENTION_DAYS}`);
  }
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Clean up old recordings based on retention policy
 * Also removes invalid small files (< 1KB) which indicate failed recordings
 */
function cleanupOldRecordings(outputDir, retentionDays) {
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;
  let freedBytes = 0;
  let invalidCount = 0;

  try {
    if (!fs.existsSync(outputDir)) {
      return { deletedCount, freedBytes, invalidCount };
    }

    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => path.join(outputDir, f));

    for (const filePath of files) {
      try {
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;

        // Delete invalid small files (< 1KB) that are older than 1 minute
        // (give ffmpeg time to write data before considering it invalid)
        if (stats.size < 1024 && fileAge > 60000) {
          fs.unlinkSync(filePath);
          invalidCount++;
          console.log(`🗑️  Deleted invalid recording: ${path.basename(filePath)} (${stats.size} bytes)`);
          continue;
        }

        if (fileAge > maxAgeMs) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          freedBytes += fileSize;
          console.log(`🗑️  Deleted old recording: ${path.basename(filePath)}`);
        }
      } catch (err) {
        console.error(`⚠️  Error checking/deleting ${filePath}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`⚠️  Error cleaning up recordings: ${err.message}`);
  }

  return { deletedCount, freedBytes, invalidCount };
}

/**
 * Start periodic cleanup of old recordings
 */
function startRetentionCleanup(outputDir, retentionDays) {
  console.log(`🗓️  Retention policy: ${retentionDays} days`);

  // Run cleanup immediately on start
  const initial = cleanupOldRecordings(outputDir, retentionDays);
  if (initial.deletedCount > 0 || initial.invalidCount > 0) {
    const freedMB = (initial.freedBytes / 1024 / 1024).toFixed(2);
    const parts = [];
    if (initial.deletedCount > 0) parts.push(`${initial.deletedCount} old file(s)`);
    if (initial.invalidCount > 0) parts.push(`${initial.invalidCount} invalid file(s)`);
    console.log(`🗑️  Initial cleanup: deleted ${parts.join(', ')}${initial.freedBytes > 0 ? `, freed ${freedMB} MB` : ''}`);
  }

  // Run cleanup every hour
  const cleanupInterval = setInterval(() => {
    const result = cleanupOldRecordings(outputDir, retentionDays);
    if (result.deletedCount > 0 || result.invalidCount > 0) {
      const freedMB = (result.freedBytes / 1024 / 1024).toFixed(2);
      const parts = [];
      if (result.deletedCount > 0) parts.push(`${result.deletedCount} old file(s)`);
      if (result.invalidCount > 0) parts.push(`${result.invalidCount} invalid file(s)`);
      console.log(`🗑️  Cleanup: deleted ${parts.join(', ')}${result.freedBytes > 0 ? `, freed ${freedMB} MB` : ''}`);
    }
  }, 60 * 60 * 1000); // Every hour

  return () => clearInterval(cleanupInterval);
}

/**
 * Get S3 client configuration from env vars
 */
function getS3Config() {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION || 'us-east-1';
  const prefix = process.env.S3_PREFIX || '';
  // Delete local files after upload (default: true)
  const deleteAfterUpload = process.env.S3_DELETE_AFTER_UPLOAD !== 'false';

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
    prefix,
    deleteAfterUpload,
  };
}

/**
 * Create S3 client from config
 */
function createS3Client(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // Required for S3-compatible services like MinIO
  });
}

/**
 * Upload file to S3-compatible storage
 */
async function uploadToS3(filePath, s3Config, deleteAfterUpload = true) {
  const s3Client = createS3Client(s3Config);
  const fileName = path.basename(filePath);
  const key = s3Config.prefix ? `${s3Config.prefix}/${fileName}` : fileName;

  console.log(`☁️  Uploading ${fileName} to S3...`);

  try {
    const fileContent = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: fileContent,
      ContentType: 'video/mp4',
    });

    await s3Client.send(command);
    console.log(`✅ Uploaded ${fileName} to s3://${s3Config.bucket}/${key}`);

    // Delete local file after successful upload
    if (deleteAfterUpload) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️  Deleted local file: ${fileName}`);
      } catch (deleteError) {
        console.error(`⚠️  Failed to delete local file ${fileName}: ${deleteError.message}`);
      }
    }

    return true;
  } catch (error) {
    console.error(`❌ Failed to upload ${fileName}: ${error.message}`);
    return false;
  }
}

/**
 * Watch directory for new segment files and upload them
 * Returns an object with stop() and finalUpload() methods
 */
function watchAndUploadSegments(outputDir, s3Config, prefix) {
  const uploadedFiles = new Set();
  const pendingFiles = new Map();
  let isRunning = true;

  console.log(`☁️  S3 upload enabled: s3://${s3Config.bucket}/${s3Config.prefix || ''}`);

  // Function to scan and upload files
  const scanAndUpload = async (forceUpload = false) => {
    try {
      const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.mp4'))
        .map(f => path.join(outputDir, f));

      for (const filePath of files) {
        if (uploadedFiles.has(filePath)) continue;

        try {
          const stats = fs.statSync(filePath);
          const previousSize = pendingFiles.get(filePath);

          // File is still being written if size changed (unless forceUpload)
          if (!forceUpload && previousSize !== stats.size) {
            pendingFiles.set(filePath, stats.size);
            continue;
          }

          // Delete empty or very small files (less than 1KB) - these are invalid
          if (stats.size < 1024) {
            console.log(`🗑️  Deleting invalid file: ${path.basename(filePath)} (${stats.size} bytes)`);
            try {
              fs.unlinkSync(filePath);
            } catch (err) {
              console.error(`⚠️  Failed to delete invalid file: ${err.message}`);
            }
            uploadedFiles.add(filePath);
            continue;
          }

          // File size stable or forced, upload it
          pendingFiles.delete(filePath);
          uploadedFiles.add(filePath);
          await uploadToS3(filePath, s3Config, s3Config.deleteAfterUpload);
        } catch (err) {
          // File might be locked or deleted
          console.error(`⚠️  Error processing ${filePath}: ${err.message}`);
        }
      }
    } catch (err) {
      // Directory might not exist yet
    }
  };

  // Check for completed segments periodically
  const checkInterval = setInterval(() => {
    if (isRunning) {
      scanAndUpload(false);
    }
  }, 5000); // Check every 5 seconds

  return {
    // Stop the periodic check
    stop: () => {
      isRunning = false;
      clearInterval(checkInterval);
    },
    // Final upload - wait a bit for ffmpeg to finish writing, then force upload all
    finalUpload: async () => {
      isRunning = false;
      clearInterval(checkInterval);
      console.log('☁️  Waiting for files to finalize...');
      // Wait 2 seconds for ffmpeg to finish writing
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('☁️  Uploading remaining files...');
      await scanAndUpload(true);
      console.log('☁️  Final upload complete');
    }
  };
}

// IMOU Open Platform API base URL
const IMOU_API_BASE = 'https://openapi.easy4ip.com';

/**
 * Generate IMOU API signature
 * Format: MD5("time:{time},nonce:{nonce},appSecret:{appSecret}")
 */
function generateSign(time, nonce, appSecret) {
  const signStr = `time:${time},nonce:${nonce},appSecret:${appSecret}`;
  return crypto.createHash('md5').update(signStr).digest('hex');
}

/**
 * Get access token from IMOU API
 */
async function getAccessToken(appId, appSecret) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const sign = generateSign(time, nonce, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/accessToken`, {
    system: {
      time,
      nonce,
      appId,
      sign,
      ver: '1.0',
    },
    id: nonce,
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to get access token: ${response.data.result?.msg || 'Unknown error'}`);
  }

  const tokenData = response.data.result.data;
  return tokenData.accessToken;
}

/**
 * Get device list from IMOU API
 */
async function getDeviceList(appId, appSecret, accessToken) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const sign = generateSign(time, nonce, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/deviceBaseList`, {
    system: {
      time,
      nonce,
      appId,
      sign,
      ver: '1.0',
      token: accessToken,
    },
    params: {
      bindId: '',
      limit: '50',
      type: 'bindAndShare',
      needApInfo: true,
    },
    id: nonce,
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to get device list: ${response.data.result?.msg || 'Unknown error'}`);
  }

  return response.data.result.data.devices || [];
}

/**
 * Bind device to get live stream access
 */
async function bindDeviceLive(appId, appSecret, accessToken, deviceId, channelId = '0') {
  const time = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const sign = generateSign(time, nonce, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/bindDeviceLive`, {
    system: {
      time,
      nonce,
      appId,
      sign,
      ver: '1.0',
      token: accessToken,
    },
    params: {
      deviceId,
      channelId,
    },
    id: nonce,
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to bind device live: ${response.data.result?.msg || 'Unknown error'}`);
  }

  return response.data.result.data;
}

/**
 * Get live stream info (RTSP URL) from IMOU API
 */
async function getLiveStreamInfo(appId, appSecret, accessToken, deviceId, channelId = '0', streamId = '0') {
  const time = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const sign = generateSign(time, nonce, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/getLiveStreamInfo`, {
    system: {
      time,
      nonce,
      appId,
      sign,
      ver: '1.0',
      token: accessToken,
    },
    params: {
      deviceId,
      channelId,
      streamId,
    },
    id: nonce,
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to get live stream info: ${response.data.result?.msg || 'Unknown error'}`);
  }

  return response.data.result.data;
}

/**
 * Construct local RTSP URL for direct camera access
 * URL-encodes username and password to handle special characters
 */
function constructLocalRtspUrl(ip, username, password, channel = 1, subtype = 0, port = 554) {
  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);
  return `rtsp://${encodedUsername}:${encodedPassword}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}

/**
 * Inject credentials into an RTSP URL
 * Handles URLs with or without existing credentials
 */
function injectCredentials(rtspUrl, username, password) {
  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);

  // Check if URL already has credentials (user:pass@host pattern after rtsp://)
  const hasCredentials = /^rtsp:\/\/[^\/]+@/.test(rtspUrl);

  if (hasCredentials) {
    // Remove existing credentials and add new ones
    const urlWithoutCreds = rtspUrl.replace(/^rtsp:\/\/[^@]+@/, 'rtsp://');
    return urlWithoutCreds.replace('rtsp://', `rtsp://${encodedUsername}:${encodedPassword}@`);
  } else {
    // Insert credentials after rtsp://
    return rtspUrl.replace('rtsp://', `rtsp://${encodedUsername}:${encodedPassword}@`);
  }
}

/**
 * Format bytes to human readable size
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Get file size safely (returns 0 if file doesn't exist)
 */
function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

/**
 * Generate output filename for a segment
 */
function generateOutputFilename(outputDir, prefix, segmentIndex) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const paddedIndex = String(segmentIndex).padStart(3, '0');
  return path.join(outputDir, `${prefix}_${timestamp}_${paddedIndex}.mp4`);
}

/**
 * Start a single ffmpeg recording process
 * Returns a promise that resolves when the process exits
 */
function startFfmpegProcess(rtspUrl, outputFile, options = {}) {
  const { onProgress } = options;

  const ffmpegArgs = [
    // Input options - use TCP for more reliable RTSP streaming
    '-rtsp_transport', 'tcp',
    '-rtsp_flags', 'prefer_tcp',
    '-i', rtspUrl,
    // Output options
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-flush_packets', '1',  // Flush packets to disk immediately
    '-fflags', '+flush_packets',  // Ensure packets are flushed
    '-y',  // Overwrite output file if exists
    outputFile,
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  let lastFrameLog = 0;

  ffmpeg.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  ffmpeg.stderr.on('data', (data) => {
    const message = data.toString();
    // Log important messages and connection info
    if (message.includes('Error') || message.includes('error') ||
      message.includes('Opening') || message.includes('Stream') ||
      message.includes('Input') || message.includes('Output') ||
      message.includes('Duration') || message.includes('Video:') ||
      message.includes('Audio:') || message.includes('frame=')) {
      // For frame progress, only show occasionally
      if (message.includes('frame=')) {
        const now = Date.now();
        if (now - lastFrameLog > 10000) {
          lastFrameLog = now;
          const frameMatch = message.match(/frame=\s*(\d+)/);
          const timeMatch = message.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (frameMatch && timeMatch) {
            // Get current file size
            const fileSize = getFileSize(outputFile);
            console.log(`📹 Recording: frame ${frameMatch[1]}, time ${timeMatch[1]}, size ${formatFileSize(fileSize)}`);
            if (onProgress) onProgress({ frame: frameMatch[1], time: timeMatch[1], size: fileSize });
          }
        }
      } else {
        console.log(message.trim());
      }
    }
  });

  ffmpeg.on('error', (error) => {
    console.error(`❌ FFmpeg error: ${error.message}`);
    console.error('Make sure FFmpeg is installed and available in your PATH');
  });

  return ffmpeg;
}

/**
 * Stop ffmpeg process gracefully
 * Returns a promise that resolves when the process has exited
 */
function stopFfmpegProcess(ffmpeg, forceTimeout = 2000) {
  return new Promise((resolve) => {
    if (!ffmpeg || ffmpeg.killed) {
      resolve(0);
      return;
    }

    let forceKillTimer = null;

    // Set up exit handler before sending signal
    ffmpeg.once('close', (code) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve(code);
    });

    // Send SIGTERM for graceful shutdown (allows ffmpeg to finalize the file)
    ffmpeg.kill('SIGTERM');

    // Force kill after timeout if still running
    forceKillTimer = setTimeout(() => {
      if (!ffmpeg.killed) {
        console.log('⚠️  Force killing ffmpeg...');
        ffmpeg.kill('SIGKILL');
      }
    }, forceTimeout);
  });
}

/**
 * Record RTSP stream using FFmpeg with manual segment management
 * Stops and restarts ffmpeg at segment boundaries for precise timing
 */
function recordStream(rtspUrl, outputDir, options = {}) {
  const defaultSegmentTime = getSegmentSeconds();
  const { segmentTime = defaultSegmentTime, prefix = 'recording' } = options;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`🎥 Starting recording...`);
  console.log(`📁 Output directory: ${outputDir}`);
  console.log(`⏱️  Segment duration: ${segmentTime} seconds`);
  console.log(`🔗 RTSP URL: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`); // Hide password

  // Debug: show full URL if DEBUG env var is set
  if (process.env.DEBUG) {
    console.log(`🔧 DEBUG - Full RTSP URL: ${rtspUrl}`);
  }

  // Setup S3 upload if configured
  const s3Config = getS3Config();
  let s3Watcher = null;
  if (s3Config) {
    s3Watcher = watchAndUploadSegments(outputDir, s3Config, prefix);
  }

  // Setup retention cleanup
  const retentionDays = getRetentionDays();
  const stopRetentionCleanup = startRetentionCleanup(outputDir, retentionDays);

  // State management
  let currentFfmpeg = null;
  let currentOutputFile = null;
  let segmentIndex = 0;
  let segmentTimer = null;
  let isShuttingDown = false;
  let isRotating = false;

  /**
   * Start recording a new segment
   */
  const startNewSegment = () => {
    if (isShuttingDown) return;

    currentOutputFile = generateOutputFilename(outputDir, prefix, segmentIndex);
    console.log(`\n📼 Starting segment ${segmentIndex}: ${path.basename(currentOutputFile)}`);

    currentFfmpeg = startFfmpegProcess(rtspUrl, currentOutputFile);

    // Handle unexpected ffmpeg exit (crash, connection lost, etc.)
    currentFfmpeg.once('close', (code) => {
      if (isShuttingDown || isRotating) return;

      if (code !== 0) {
        console.log(`⚠️  FFmpeg exited unexpectedly with code ${code}, restarting in 5 seconds...`);
        // Clear the segment timer since we're restarting
        if (segmentTimer) {
          clearTimeout(segmentTimer);
          segmentTimer = null;
        }
        // Restart after a delay
        setTimeout(() => {
          if (!isShuttingDown) {
            segmentIndex++;
            startNewSegment();
          }
        }, 5000);
      }
    });

    // Schedule segment rotation
    segmentTimer = setTimeout(async () => {
      await rotateSegment();
    }, segmentTime * 1000);

    segmentIndex++;
  };

  /**
   * Rotate to a new segment (stop current, start new)
   */
  const rotateSegment = async () => {
    if (isShuttingDown || isRotating) return;

    isRotating = true;
    console.log(`\n🔄 Rotating segment...`);

    // Clear existing timer
    if (segmentTimer) {
      clearTimeout(segmentTimer);
      segmentTimer = null;
    }

    // Stop current ffmpeg process
    const oldFfmpeg = currentFfmpeg;
    const oldOutputFile = currentOutputFile;
    currentFfmpeg = null;
    currentOutputFile = null;

    if (oldFfmpeg) {
      await stopFfmpegProcess(oldFfmpeg);
      // Log file size after ffmpeg has finalized
      const fileSize = getFileSize(oldOutputFile);
      console.log(`✅ Segment finalized: ${path.basename(oldOutputFile)} (${formatFileSize(fileSize)})`);
    }

    isRotating = false;

    // Start new segment
    startNewSegment();
  };

  /**
   * Graceful shutdown - stops recording and uploads immediately
   */
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n🛑 Received ${signal}, stopping recording immediately...`);

    // Clear segment timer immediately
    if (segmentTimer) {
      clearTimeout(segmentTimer);
      segmentTimer = null;
    }

    // Stop current ffmpeg process
    if (currentFfmpeg) {
      const ffmpegToStop = currentFfmpeg;
      const finalOutputFile = currentOutputFile;
      currentFfmpeg = null;
      currentOutputFile = null;
      const code = await stopFfmpegProcess(ffmpegToStop);
      if (code === 0 || code === 255 || code === null) {
        const fileSize = getFileSize(finalOutputFile);
        console.log(`✅ Final segment saved: ${path.basename(finalOutputFile)} (${formatFileSize(fileSize)})`);
      } else {
        console.log(`⚠️  FFmpeg exited with code ${code}`);
      }
    }

    // Stop retention cleanup
    stopRetentionCleanup();

    // Perform final S3 upload immediately
    if (s3Watcher) {
      console.log('☁️  Uploading final segments to S3...');
      await s3Watcher.finalUpload();
    }

    console.log('👋 Recording stopped');
    process.exit(0);
  };

  // Signal handler wrapper to properly handle async shutdown
  const handleSignal = (signal) => {
    // Prevent default behavior and handle shutdown ourselves
    gracefulShutdown(signal).catch((err) => {
      console.error(`❌ Error during shutdown: ${err.message}`);
      process.exit(1);
    });
  };

  // Handle shutdown signals - use 'once' to prevent multiple handlers
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('SIGHUP', () => handleSignal('SIGHUP'));

  // Start the first segment
  startNewSegment();

  // Return control object
  return {
    stop: () => gracefulShutdown('manual'),
    rotate: () => rotateSegment(),
  };
}

// Main program setup
program
  .name('imou-rtsp-dvr')
  .description('IMOU Camera RTSP Stream DVR Recorder')
  .version('1.0.0');

// Record command using IMOU Cloud API
program
  .command('cloud')
  .description('Record stream using IMOU Cloud API to get RTSP URL')
  .option('--app-id <appId>', 'IMOU Open Platform App ID (or set IMOU_APP_ID env var)')
  .option('--app-secret <appSecret>', 'IMOU Open Platform App Secret (or set IMOU_APP_SECRET env var)')
  .requiredOption('--device-id <deviceId>', 'Device ID to record')
  .option('--channel-id <channelId>', 'Channel ID', '0')
  .option('--stream-id <streamId>', 'Stream ID (0=main, 1=sub)', '0')
  .option('-o, --output <directory>', 'Output directory', './recordings')
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds (or set SEGMENT_SECONDS env var)', String(getSegmentSeconds()))
  .action(async (options) => {
    try {
      const appId = options.appId || process.env.IMOU_APP_ID;
      const appSecret = options.appSecret || process.env.IMOU_APP_SECRET;

      if (!appId || !appSecret) {
        console.error('❌ Error: App ID and App Secret are required.');
        console.error('   Provide via --app-id/--app-secret or set IMOU_APP_ID/IMOU_APP_SECRET env vars');
        process.exit(1);
      }

      console.log('🔐 Authenticating with IMOU Cloud API...');
      const accessToken = await getAccessToken(appId, appSecret);
      console.log('✅ Authentication successful');

      console.log('📡 Binding device for live stream...');
      await bindDeviceLive(appId, appSecret, accessToken, options.deviceId, options.channelId);
      console.log('✅ Device bound successfully');

      console.log('🔍 Getting live stream info...');
      const streamInfo = await getLiveStreamInfo(
        appId,
        appSecret,
        accessToken,
        options.deviceId,
        options.channelId,
        options.streamId
      );

      const rtspUrl = streamInfo.streams?.[0]?.url || streamInfo.url;
      if (!rtspUrl) {
        throw new Error('No RTSP URL found in stream info');
      }

      console.log('✅ Got stream URL');

      recordStream(rtspUrl, options.output, {
        segmentTime: parseInt(options.segmentTime, 10),
        prefix: `cam_${options.deviceId}`,
      });
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

// Record command using direct local RTSP URL
program
  .command('local')
  .description('Record stream using direct local camera RTSP URL')
  .requiredOption('--ip <ip>', 'Camera IP address')
  .requiredOption('--username <username>', 'Camera username (usually "admin")')
  .requiredOption('--password <password>', 'Camera password (Safety Code)')
  .option('--port <port>', 'RTSP port', '554')
  .option('--channel <channel>', 'Camera channel', '1')
  .option('--subtype <subtype>', 'Stream subtype (0=main, 1=sub)', '0')
  .option('-o, --output <directory>', 'Output directory', './recordings')
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds (or set SEGMENT_SECONDS env var)', String(getSegmentSeconds()))
  .action((options) => {
    const rtspUrl = constructLocalRtspUrl(
      options.ip,
      options.username,
      options.password,
      parseInt(options.channel, 10),
      parseInt(options.subtype, 10),
      parseInt(options.port, 10)
    );

    recordStream(rtspUrl, options.output, {
      segmentTime: parseInt(options.segmentTime, 10),
      prefix: `cam_${options.ip.replace(/\./g, '-')}`,
    });
  });

// Record command using direct RTSP URL
program
  .command('url')
  .description('Record stream using a direct RTSP URL')
  .option('--rtsp <url>', 'Full RTSP URL (or set RTSP_URL env var)')
  .option('--username <username>', 'Camera username (or set RTSP_USERNAME env var, will be URL-encoded)')
  .option('--password <password>', 'Camera password (or set RTSP_PASSWORD env var, will be URL-encoded)')
  .option('-o, --output <directory>', 'Output directory', './recordings')
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds (or set SEGMENT_SECONDS env var)', String(getSegmentSeconds()))
  .option('-p, --prefix <prefix>', 'Output file prefix', 'recording')
  .action((options) => {
    // Get RTSP URL from option or env var
    let rtspUrl = options.rtsp || process.env.RTSP_URL;
    const username = options.username || process.env.RTSP_USERNAME;
    const password = options.password || process.env.RTSP_PASSWORD;

    if (!rtspUrl) {
      console.error('❌ Error: RTSP URL is required.');
      console.error('   Provide via --rtsp or set RTSP_URL env var');
      process.exit(1);
    }

    // If username and password are provided, inject them into the URL
    if (username && password) {
      rtspUrl = injectCredentials(rtspUrl, username, password);
    } else if (username || password) {
      console.error('❌ Error: Both username and password must be provided together');
      console.error('   Use --username/--password or RTSP_USERNAME/RTSP_PASSWORD env vars');
      process.exit(1);
    }

    recordStream(rtspUrl, options.output, {
      segmentTime: parseInt(options.segmentTime, 10),
      prefix: options.prefix,
    });
  });

// List devices command
program
  .command('list-devices')
  .description('List all devices from IMOU Cloud account')
  .option('--app-id <appId>', 'IMOU Open Platform App ID (or set IMOU_APP_ID env var)')
  .option('--app-secret <appSecret>', 'IMOU Open Platform App Secret (or set IMOU_APP_SECRET env var)')
  .action(async (options) => {
    try {
      const appId = options.appId || process.env.IMOU_APP_ID;
      const appSecret = options.appSecret || process.env.IMOU_APP_SECRET;

      if (!appId || !appSecret) {
        console.error('❌ Error: App ID and App Secret are required.');
        console.error('   Provide via --app-id/--app-secret or set IMOU_APP_ID/IMOU_APP_SECRET env vars');
        process.exit(1);
      }

      console.log('🔐 Authenticating with IMOU Cloud API...');
      const accessToken = await getAccessToken(appId, appSecret);
      console.log('✅ Authentication successful\n');

      console.log('📡 Fetching device list...');
      const devices = await getDeviceList(appId, appSecret, accessToken);

      if (devices.length === 0) {
        console.log('No devices found');
        return;
      }

      console.log(`\n📷 Found ${devices.length} device(s):\n`);
      devices.forEach((device, index) => {
        console.log(`${index + 1}. ${device.deviceName || 'Unnamed Device'}`);
        console.log(`   Device ID: ${device.deviceId}`);
        console.log(`   Model: ${device.deviceModel || 'N/A'}`);
        console.log(`   Status: ${device.status === '1' ? '🟢 Online' : '🔴 Offline'}`);
        console.log(`   Channels: ${device.channelNum || '1'}`);
        console.log('');
      });
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
