# IMOU RTSP DVR

A Node.js CLI tool to record RTSP streams from IMOU cameras with optional S3-compatible storage upload.

## Prerequisites

- **Node.js** (22.23.4 or a newer patched Node 22 release)
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

## Environment Variables

You can configure the DVR using environment variables. Create a `.env` file in the project root:

### IMOU Cloud API Credentials

| Variable | Description | Required |
|----------|-------------|----------|
| `IMOU_APP_ID` | IMOU Open Platform App ID | For cloud commands |
| `IMOU_APP_SECRET` | IMOU Open Platform App Secret | For cloud commands |

### Recording Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SEGMENT_SECONDS` | Duration of each recording segment in seconds | `3600` (1 hour) |
| `RETENTION_DAYS` | Number of days to keep recordings before auto-deletion | `90` (90 days) |
| `RTSP_URL` | RTSP stream URL (for `url` command) | - |
| `RTSP_USERNAME` | RTSP username (will be URL-encoded automatically) | - |
| `RTSP_PASSWORD` | RTSP password (will be URL-encoded automatically) | - |

### S3-Compatible Storage Upload

Configure these variables to automatically upload completed recording segments to S3-compatible storage (AWS S3, MinIO, DigitalOcean Spaces, Backblaze B2, etc.):

| Variable | Description | Required |
|----------|-------------|----------|
| `S3_ENDPOINT` | S3 endpoint URL (e.g., `https://s3.amazonaws.com`, `https://minio.example.com`) | Yes |
| `S3_BUCKET` | S3 bucket name | Yes |
| `S3_ACCESS_KEY_ID` | S3 access key ID | Yes |
| `S3_SECRET_ACCESS_KEY` | S3 secret access key | Yes |
| `S3_REGION` | S3 region (e.g., `us-east-1`) | No (default: `us-east-1`) |
| `S3_PREFIX` | Prefix/folder for uploaded files (e.g., `recordings/camera1`) | No |
| `S3_DELETE_AFTER_UPLOAD` | Delete local files after successful S3 upload (`true`/`false`) | No (default: `true`) |

**Example `.env` file:**
```bash
# IMOU Cloud credentials
IMOU_APP_ID=your_app_id
IMOU_APP_SECRET=your_app_secret

# Recording settings
SEGMENT_SECONDS=1800
RETENTION_DAYS=30

# RTSP URL configuration (for 'url' command)
RTSP_URL=rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0
RTSP_USERNAME=admin
RTSP_PASSWORD=your_password_with_special@chars!

# S3 Upload (MinIO example)
S3_ENDPOINT=https://minio.example.com
S3_BUCKET=camera-recordings
S3_ACCESS_KEY_ID=your_access_key
S3_SECRET_ACCESS_KEY=your_secret_key
S3_REGION=us-east-1
S3_PREFIX=office-camera

# S3 Upload (AWS S3 example)
# S3_ENDPOINT=https://s3.amazonaws.com
# S3_BUCKET=my-recordings-bucket
# S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
# S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# S3_REGION=us-west-2
# S3_PREFIX=cameras/front-door
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
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: `SEGMENT_SECONDS` env var or 3600)

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
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: `SEGMENT_SECONDS` env var or 3600)

**Note:** The password is usually the "Safety Code" found on the camera label or in the IMOU app.

### 3. Direct RTSP URL

If you already have the RTSP URL:

```bash
node index.js url \
  --rtsp "rtsp://admin:password@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0" \
  --output ./recordings
```

**Recommended: Use separate credentials (handles special characters automatically):**
```bash
node index.js url \
  --rtsp "rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0" \
  --username admin \
  --password "your_password_with_special@chars!" \
  --output ./recordings
```

**Using environment variables (best for automation/docker):**
```bash
# Set in .env file or export:
export RTSP_URL="rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0"
export RTSP_USERNAME="admin"
export RTSP_PASSWORD="your_password_with_special@chars!"

# Then just run:
node index.js url --output ./recordings
```

Options:
- `--rtsp <url>` - RTSP URL (or set `RTSP_URL` env var)
- `--username <username>` - Camera username (or set `RTSP_USERNAME` env var, will be URL-encoded)
- `--password <password>` - Camera password (or set `RTSP_PASSWORD` env var, will be URL-encoded)
- `-p, --prefix <prefix>` - Output file prefix (default: recording)
- `-s, --segment-time <seconds>` - Duration of each recording segment (default: `SEGMENT_SECONDS` env var or 3600)

### Handling Special Characters in Credentials

If your password contains special characters like `@`, `:`, `#`, `!`, `%`, etc., you have two options:

1. **Recommended:** Use the `--username` and `--password` options separately (credentials will be URL-encoded automatically):
   ```bash
   node index.js url \
     --rtsp "rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0" \
     --username admin \
     --password "p@ss:word#123!"
   ```

2. **Alternative:** Manually URL-encode special characters in the URL:
   - `@` → `%40`
   - `:` → `%3A`
   - `#` → `%23`
   - `!` → `%21`
   - `%` → `%25`

   Example: Password `p@ss:word` becomes `p%40ss%3Aword`:
   ```bash
   node index.js url \
     --rtsp "rtsp://admin:p%40ss%3Aword@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0"
   ```

## Recording Retention

The DVR automatically deletes old recordings based on the `RETENTION_DAYS` setting (default: 90 days).

- Cleanup runs immediately on startup and every hour thereafter
- Only `.mp4` files in the output directory are considered
- Files older than the retention period are automatically deleted
- Freed disk space is logged

**Example output:**
```
🗓️  Retention policy: 30 days
🗑️  Initial cleanup: deleted 5 file(s), freed 1024.50 MB
```

## S3 Upload Behavior

When S3 environment variables are configured, the DVR will:

1. **Monitor** the output directory for completed segment files
2. **Detect** when a segment file is complete (file size stops changing)
3. **Upload** completed segments to the configured S3 bucket
4. **Log** upload progress and any errors

The upload happens in the background and does not block recording. Files are uploaded with the content type `video/mp4`.

**Example output with S3 enabled:**
```
🎥 Starting recording...
📁 Output directory: ./recordings
⏱️  Segment duration: 1800 seconds
🔗 RTSP URL: rtsp://admin:****@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0
☁️  S3 upload enabled: s3://camera-recordings/office-camera
☁️  Uploading cam_192-168-1-100_2024-01-15T10-30-00-000Z_000.mp4 to S3...
✅ Uploaded cam_192-168-1-100_2024-01-15T10-30-00-000Z_000.mp4 to s3://camera-recordings/office-camera/cam_192-168-1-100_2024-01-15T10-30-00-000Z_000.mp4
```

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

## Docker Deployment

### Build the Docker image

```bash
docker build -t imou-rtsp-dvr .
```

### Run with Docker

```bash
docker run -d \
  --name imou-dvr \
  --restart unless-stopped \
  -e RTSP_URL="rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0" \
  -e RTSP_USERNAME="admin" \
  -e RTSP_PASSWORD="your_password" \
  -e SEGMENT_SECONDS="1800" \
  -e RETENTION_DAYS="30" \
  -e S3_ENDPOINT="https://minio.example.com" \
  -e S3_BUCKET="camera-recordings" \
  -e S3_ACCESS_KEY_ID="your_access_key" \
  -e S3_SECRET_ACCESS_KEY="your_secret_key" \
  -e S3_PREFIX="camera1" \
  -v /path/to/local/recordings:/app/recordings \
  imou-rtsp-dvr
```

### Run with Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3.8'

services:
  dvr:
    build: .
    image: imou-rtsp-dvr
    container_name: imou-dvr
    restart: unless-stopped
    environment:
      - RTSP_URL=rtsp://192.168.1.100:554/cam/realmonitor?channel=1&subtype=0
      - RTSP_USERNAME=admin
      - RTSP_PASSWORD=your_password
      - SEGMENT_SECONDS=1800
      - RETENTION_DAYS=30
      - S3_ENDPOINT=https://minio.example.com
      - S3_BUCKET=camera-recordings
      - S3_ACCESS_KEY_ID=your_access_key
      - S3_SECRET_ACCESS_KEY=your_secret_key
      - S3_PREFIX=camera1
    volumes:
      - ./recordings:/app/recordings
```

Then run:
```bash
docker-compose up -d
```

### Graceful Shutdown

The container handles shutdown signals (SIGINT, SIGTERM, SIGHUP) gracefully:
1. Stops FFmpeg recording
2. Waits for files to finalize
3. Uploads any remaining segments to S3
4. Exits cleanly

To stop the container gracefully:
```bash
docker stop imou-dvr
```

## License

MIT
