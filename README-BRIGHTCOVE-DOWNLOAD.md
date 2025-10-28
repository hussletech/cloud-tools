# Brightcove Video Download Tool

## Overview

This tool downloads all videos from a Brightcove account using a **two-phase approach** to avoid memory overhead with large video libraries (15,000+ videos).

## Two-Phase Architecture

### Phase 1: Discovery
- Discovers ALL videos from Brightcove using CMS API pagination
- Streams results directly to CSV file (no memory overhead)
- Saves video metadata: ID, name, creation date, duration, tags, description
- Creates tracking CSV with `is_downloaded` flag for resumable downloads

### Phase 2: Download
- Reads from discovery CSV
- Downloads only videos marked as NOT downloaded
- Updates CSV flag after each successful download
- **Fully resumable** - if interrupted, just run again
- Organizes videos by creation date: `/base/YYYY/MM/`

## Usage

### 1. Discover all videos (first time)
```bash
node app.js discover
```

This will:
- Connect to Brightcove CMS API
- Paginate through all videos (100 per request)
- Save to: `/home/ec2-user/assets.soundconcepts.com/brightcove-videos/brightcove-discovery.csv`
- Memory efficient: videos are streamed to CSV as discovered

### 2. Download videos (resumable)
```bash
node app.js download
```

This will:
- Read videos from discovery CSV
- Skip videos already marked as downloaded
- Download videos with 20 concurrent connections
- Organize by date: `/home/ec2-user/assets.soundconcepts.com/brightcove-videos/YYYY/MM/`
- Update CSV flag after each successful download

### 3. Run both phases
```bash
node app.js all
```

Runs discovery followed by download in one command.

## Resuming Interrupted Downloads

If download is interrupted (network issue, timeout, etc.):

```bash
# Just run download again - it will skip completed videos
node app.js download
```

The tool automatically:
- Reads the discovery CSV
- Filters out videos with `is_downloaded=true`
- Continues from where it left off

## Directory Structure

```
/home/ec2-user/assets.soundconcepts.com/brightcove-videos/
├── brightcove-discovery.csv          # Discovery tracking (all videos)
├── output-bc-migration.csv           # Download log (completed downloads)
├── 2023/
│   ├── 01/
│   │   ├── 6234567890001.mp4
│   │   ├── 6234567890001.json
│   │   ├── 6234567890002.mp4
│   │   └── 6234567890002.json
│   └── 02/
│       └── ...
└── 2024/
    └── ...
```

## CSV Files

### brightcove-discovery.csv (Tracking Database)
```csv
"brightcove_id","video_name","created_at","duration","tags","description","is_downloaded","download_date","file_name","container"
"6234567890001","My Video","2023-01-15T10:30:00Z","120000","tag1; tag2","Description","true","2025-10-28T12:34:56Z","6234567890001.mp4","mp4"
"6234567890002","Another Video","2023-01-16T11:00:00Z","180000","tag3","Desc 2","false","","",""
```

### output-bc-migration.csv (Download Log)
```csv
"brightcove_id","download_date","file_name","video_name","created_at","duration","container"
"6234567890001","2025-10-28T12:34:56Z","6234567890001.mp4","My Video","2023-01-15T10:30:00Z","120000","mp4"
```

## Configuration

Edit constants in `app.js`:

```javascript
const OUTPUT_BASE_PATH = '/home/ec2-user/assets.soundconcepts.com/brightcove-videos';
const MAX_CONCURRENT_VIDEOS = 20;           // Concurrent downloads
const MAX_PROCESSING_TIME_MS = 10 * 60 * 1000;  // Timeout per video (10 min)
const SKIP_EXISTING_FILES = true;           // Skip if video file exists
```

## Environment Variables

Create `.env` file:

```env
API_KEY=your_brightcove_api_key
API_SECRET=your_brightcove_api_secret
```

## Benefits of Two-Phase Approach

1. **Memory Efficient**: Discovery streams to CSV, doesn't load 15,000 videos into memory
2. **Resumable**: Interrupted downloads can resume from exact point
3. **Flexible**: Can run discovery once, then download in batches
4. **Trackable**: CSV provides clear audit trail of what's downloaded
5. **Safe**: Network issues don't require re-downloading completed videos

## Monitoring Progress

During download phase, you'll see:
```
[2025-10-28T12:34:56Z] Starting video 1/15000: 6234567890001 (20 in progress)
[2025-10-28T12:35:02Z] ✓ Completed 1/15000: 6234567890001 (19 still in progress)
...
```

At completion:
```
=== Download Complete ===
Total: 500 videos
Successful: 495
Failed: 5
  - Timeouts (>10 min): 3
  - Other errors: 2
Videos skipped (already exist): 120

⚠️  14500 videos still need to be downloaded.
Run the download phase again to resume: node app.js download
```

## Troubleshooting

### "Discovery CSV not found"
Run discovery phase first:
```bash
node app.js discover
```

### High failure rate
- Check network connectivity
- Increase `MAX_PROCESSING_TIME_MS` for large videos
- Reduce `MAX_CONCURRENT_VIDEOS` if rate limited

### Need to restart discovery
Delete and regenerate:
```bash
rm /home/ec2-user/assets.soundconcepts.com/brightcove-videos/brightcove-discovery.csv
node app.js discover
```

## Performance

- **Discovery**: ~15,000 videos in 5-10 minutes
- **Download**: Depends on video sizes and network speed
  - With 20 concurrent downloads
  - Average 2-3 videos per minute
  - 15,000 videos ≈ 5-7 days continuous download

## API Rate Limits

Brightcove CMS API limits:
- Default: 20 requests per second
- Script stays well under limits with 20 concurrent downloads

