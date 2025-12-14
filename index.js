#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import axios from 'axios';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();

// IMOU Open Platform API base URL
const IMOU_API_BASE = 'https://openapi.easy4ip.com';

/**
 * Generate IMOU API signature
 */
function generateSign(params, appSecret) {
  const sortedKeys = Object.keys(params).sort();
  let signStr = '';
  for (const key of sortedKeys) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
      signStr += `${key}:${params[key]},`;
    }
  }
  signStr = signStr.slice(0, -1); // Remove trailing comma
  const hmac = crypto.createHmac('md5', appSecret);
  hmac.update(signStr);
  return hmac.digest('hex').toUpperCase();
}

/**
 * Get access token from IMOU API
 */
async function getAccessToken(appId, appSecret) {
  const params = {
    time: Math.floor(Date.now() / 1000),
    appId,
    id: crypto.randomUUID(),
  };

  const sign = generateSign(params, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/accessToken`, {
    system: {
      ...params,
      sign,
      ver: '1.0',
    },
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to get access token: ${response.data.result?.msg || 'Unknown error'}`);
  }

  return response.data.result.data.accessToken;
}

/**
 * Get device list from IMOU API
 */
async function getDeviceList(appId, appSecret, accessToken) {
  const params = {
    time: Math.floor(Date.now() / 1000),
    appId,
    id: crypto.randomUUID(),
    accessToken,
  };

  const sign = generateSign(params, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/deviceBaseList`, {
    system: {
      ...params,
      sign,
      ver: '1.0',
    },
    params: {
      bindId: '',
      limit: '50',
      type: 'bindAndShare',
      needApInfo: true,
    },
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
  const params = {
    time: Math.floor(Date.now() / 1000),
    appId,
    id: crypto.randomUUID(),
    accessToken,
  };

  const sign = generateSign(params, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/bindDeviceLive`, {
    system: {
      ...params,
      sign,
      ver: '1.0',
    },
    params: {
      deviceId,
      channelId,
    },
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
  const params = {
    time: Math.floor(Date.now() / 1000),
    appId,
    id: crypto.randomUUID(),
    accessToken,
  };

  const sign = generateSign(params, appSecret);

  const response = await axios.post(`${IMOU_API_BASE}/openapi/getLiveStreamInfo`, {
    system: {
      ...params,
      sign,
      ver: '1.0',
    },
    params: {
      deviceId,
      channelId,
      streamId,
    },
  });

  if (response.data.result?.code !== '0') {
    throw new Error(`Failed to get live stream info: ${response.data.result?.msg || 'Unknown error'}`);
  }

  return response.data.result.data;
}

/**
 * Construct local RTSP URL for direct camera access
 */
function constructLocalRtspUrl(ip, username, password, channel = 1, subtype = 0, port = 554) {
  return `rtsp://${username}:${password}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}

/**
 * Record RTSP stream using FFmpeg
 */
function recordStream(rtspUrl, outputDir, options = {}) {
  const { segmentTime = 3600, prefix = 'recording' } = options;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPattern = path.join(outputDir, `${prefix}_${timestamp}_%03d.mp4`);

  console.log(`🎥 Starting recording...`);
  console.log(`📁 Output directory: ${outputDir}`);
  console.log(`⏱️  Segment duration: ${segmentTime} seconds`);
  console.log(`🔗 RTSP URL: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`); // Hide password

  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'segment',
    '-segment_time', String(segmentTime),
    '-segment_format', 'mp4',
    '-reset_timestamps', '1',
    '-strftime', '0',
    outputPattern,
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  ffmpeg.stderr.on('data', (data) => {
    const message = data.toString();
    // Only log important messages, not frame progress
    if (message.includes('Error') || message.includes('error') ||
      message.includes('Opening') || message.includes('Stream')) {
      console.log(message.trim());
    }
  });

  ffmpeg.on('error', (error) => {
    console.error(`❌ FFmpeg error: ${error.message}`);
    console.error('Make sure FFmpeg is installed and available in your PATH');
  });

  ffmpeg.on('close', (code) => {
    if (code === 0) {
      console.log('✅ Recording finished successfully');
    } else {
      console.log(`⚠️  FFmpeg exited with code ${code}`);
    }
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping recording...');
    ffmpeg.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Stopping recording...');
    ffmpeg.kill('SIGTERM');
  });

  return ffmpeg;
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
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds', '3600')
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
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds', '3600')
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
  .requiredOption('--rtsp <url>', 'Full RTSP URL')
  .option('-o, --output <directory>', 'Output directory', './recordings')
  .option('-s, --segment-time <seconds>', 'Segment duration in seconds', '3600')
  .option('-p, --prefix <prefix>', 'Output file prefix', 'recording')
  .action((options) => {
    recordStream(options.rtsp, options.output, {
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

