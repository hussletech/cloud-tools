# MediaConvert Job Processor

This script processes videos from a CSV file by:
1. Renaming the original video file to add `_original` suffix
2. Creating a MediaConvert job to process the `_original` file
3. Outputting the processed video with the original filename

## Prerequisites

- Node.js installed
- AWS credentials configured
- MediaConvert endpoint URL
- Access to the S3 bucket and MediaConvert service

## Installation

```bash
npm install
```

## Configuration

Set environment variables (via `.env` file or system environment):

- `CSV_FILE` - Path to CSV file with S3 URLs (default: `../get_objects/s3-mp4-files.csv`)
- `MEDIACONVERT_ENDPOINT` - MediaConvert endpoint URL
- `QUEUE_ARN` - MediaConvert queue ARN (default: `arn:aws:mediaconvert:us-east-1:964957925184:queues/Default`)
- `ROLE_ARN` - IAM role ARN for MediaConvert (default: `arn:aws:iam::964957925184:role/service-role/MediaConvert_Default_Role`)
- `AWS_REGION` - AWS region (default: `us-east-1`)

Example `.env` file:
```
CSV_FILE=../get_objects/s3-mp4-files.csv
MEDIACONVERT_ENDPOINT=https://qjqjqjqjq.mediaconvert.us-east-1.amazonaws.com
QUEUE_ARN=arn:aws:mediaconvert:us-east-1:964957925184:queues/Default
ROLE_ARN=arn:aws:iam::964957925184:role/service-role/MediaConvert_Default_Role
AWS_REGION=us-east-1
```

## Usage

```bash
node app.js
```

## How It Works

For each video in the CSV:

1. **Rename Original**: 
   - Original: `s3://bucket/path/video.mp4`
   - Renamed to: `s3://bucket/path/video_original.mp4`

2. **Create MediaConvert Job**:
   - Input: `s3://bucket/path/video_original.mp4`
   - Output: `s3://bucket/path/video.mp4` (original filename)

3. **Result**: The processed video replaces the original file name

## Output

- Console logs for each video processed
- `processing-results.json` file with success/failure details

## Notes

- The script checks if `_original` file already exists before renaming
- A 500ms delay is added between jobs to avoid rate limiting
- Failed jobs are logged and saved to the results file

