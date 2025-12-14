# IMOU RTSP DVR

A Node.js CLI tool to record RTSP streams from IMOU cameras.

## Prerequisites

- **Node.js** (v18 or higher)
- **FFmpeg** installed and available in your PATH

### Installing FFmpeg

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH.

## Installation

```bash
npm install
```

## Usage

The tool supports three methods of recording:

### 1. Cloud API (IMOU Open Platform)

Use this method if you have IMOU Open Platform credentials (App ID and App Secret).

**Set credentials via `.env` file (recommended):**
```bash
# Create a .env file in the project root
echo "IMOU_APP_ID=your_app_id" >> .env
echo "IMOU_APP_SECRET=your_app_secret" >> .env
```

Or export as environment variables:
```bash
export IMOU_APP_ID=your_app_id
export IMOU_APP_SECRET=your_app_secret
```

First, list your devices:
```bash
node index.js list-devices
```

Then start recording:
```bash
node index.js cloud --device-id YOUR_DEVICE_ID --output ./recordings
```

**Or pass credentials directly:**
```bash
node index.js list-devices --app-id YOUR_APP_ID --app-secret YOUR_APP_SECRET
node index.js cloud --app-id YOUR_APP_ID --app-secret YOUR_APP_SECRET --device-id YOUR_DEVICE_ID
```

Options:
- `--channel-id <id>` - Channel ID (default: 0)
- `--stream-id <id>` - Stream ID: 0=main stream, 1=sub stream (default: 0)
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: 3600)

### 2. Local Network (Direct RTSP)

Use this method to connect directly to a camera on your local network:

```bash
node index.js local \
  --ip 192.168.1.100 \
  --username admin \
  --password YOUR_SAFETY_CODE \
  --output ./recordings
```

Options:
- `--port <port>` - RTSP port (default: 554)
- `--channel <channel>` - Camera channel (default: 1)
- `--subtype <type>` - Stream subtype: 0=main, 1=sub (default: 0)
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: 3600)

**Note:** The password is usually the "Safety Code" found on the camera label or in the IMOU app.

### 3. Direct RTSP URL

If you already have the RTSP URL:

```bash
node index.js url \
  --rtsp "rtsp://admin:password@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0" \
  --output ./recordings
```

Options:
- `-p, --prefix <prefix>` - Output file prefix (default: recording)
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: 3600)

## Output

Recordings are saved as MP4 files in the specified output directory. Files are automatically segmented based on the `--segment-time` option (default: 1 hour).

File naming format: `{prefix}_{timestamp}_{segment}.mp4`

## Stopping Recording

Press `Ctrl+C` to gracefully stop the recording.

## Getting IMOU Open Platform Credentials

1. Visit [IMOU Open Platform](https://open.imoulife.com/)
2. Register for a developer account
3. Create an application to get your App ID and App Secret
4. Bind your camera to the application

## License

MIT

