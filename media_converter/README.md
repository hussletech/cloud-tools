# Media Converter - S3 MP4 File Lister

This Node.js application lists S3 objects that are `.mp4` files and were uploaded in the last 7 days, then outputs their S3 URLs to a CSV file. By default, it filters objects with the `webroot_` prefix.

## Prerequisites

- Node.js installed
- AWS credentials configured (via AWS CLI, environment variables, or IAM role)
- Access to the S3 bucket you want to query

## Installation

```bash
npm install
```

## Usage

### Command Line Arguments

```bash
node app.js <bucket-name> [output-file]
```

Example:
```bash
node app.js my-media-bucket output.csv
```

### Environment Variables

You can also use environment variables (via `.env` file or system environment):

- `S3_BUCKET_NAME` - The S3 bucket name to query
- `S3_PREFIX` - Prefix filter for objects (default: `webroot_`)
- `S3_START_AFTER` - Optional: Start listing after this key (useful for skipping certain prefixes or resuming)
- `OUTPUT_FILE` - Output CSV file name (default: `s3-mp4-files.csv`)
- `AWS_REGION` - AWS region (default: `us-east-1`)

Example `.env` file:
```
S3_BUCKET_NAME=assets.soundconcepts.com
S3_PREFIX=webroot_
S3_START_AFTER=webroot_amare/assets/video/
OUTPUT_FILE=s3-mp4-files.csv
AWS_REGION=us-east-1
```

**Note:** `S3_START_AFTER` is useful when you want to skip certain prefixes. For example, if your objects are structured like `webroot_amare/assets/video/` and `webroot_df/assets/video/`, you can set `S3_START_AFTER=webroot_amare/assets/video/` to start listing from that point onwards.

## Output

The application generates a CSV file with the following format:

```csv
S3_URL
"s3://bucket-name/path/to/file1.mp4"
"s3://bucket-name/path/to/file2.mp4"
```

## AWS Credentials

The application uses the AWS SDK's default credential provider chain, which will look for credentials in this order:

1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. AWS credentials file (`~/.aws/credentials`)
3. IAM role (if running on EC2/ECS/Lambda)

Make sure your credentials have the `s3:ListBucket` permission for the target bucket.

