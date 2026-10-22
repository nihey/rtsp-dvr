# RTSP DVR

Use npm and patched Node.js 22 (minimum 22.23.4). Keep `.nvmrc`, `engines.node`,
and the Debian Bookworm Slim Docker base aligned. Rebuild for runtime updates.
Preserve FFmpeg, recording volumes, retention, uploads and the startup command.
Validate with `npm ci`, `node --check index.js`, and `node index.js --help`.
Camera recordings and S3 uploads require a separate isolated integration check.
