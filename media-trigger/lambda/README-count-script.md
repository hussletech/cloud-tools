# Client Object Count Script

## Overview

This script counts the number of objects in each client directory within the S3 bucket `assets.soundconcepts.com` and exports the results to a CSV file.

## Features

- **Read-only operations**: The script only uses S3 LIST operations. It does not modify, delete, copy, or move any objects.
- **Comprehensive counting**: Processes all client directories defined in the `CLIENTS` array.
- **CSV export**: Generates a CSV file with client directory identifiers and object counts.

## Prerequisites

1. **Node.js**: Ensure Node.js is installed (v14 or higher recommended)
2. **AWS Credentials**: Configure AWS credentials with read access to the S3 bucket `assets.soundconcepts.com`
   - Can be configured via:
     - AWS CLI: `aws configure`
     - Environment variables: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
     - IAM role (if running on EC2/Lambda)
     - AWS credentials file (`~/.aws/credentials`)
3. **Dependencies**: Install required packages:
   ```bash
   npm install
   ```

## Required IAM Permissions

The script requires the following S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::assets.soundconcepts.com"
    }
  ]
}
```

**Note**: The script does NOT require `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, or any write permissions.

## Usage

### Running the Script

From the `lambda` directory:

```bash
node count-client-objects.js
```

### Output

The script will:
1. Display progress as it processes each client directory
2. Show a summary with total objects and list requests
3. Generate a CSV file: `client-object-counts.csv` in the same directory

### CSV Output Format

The generated CSV file contains:
- **Client Directory**: Full S3 prefix (e.g., `webroot_amare/assets/video/`)
- **Client Name**: Extracted client identifier (e.g., `amare`)
- **Object Count**: Number of objects found in that directory

Example:
```csv
Client Directory,Client Name,Object Count
"webroot_amare/assets/video/","amare",1250
"webroot_ambit/assets/video/","ambit",890
...
```

## Cost Estimation

### S3 LIST Request Pricing

Based on AWS S3 pricing (as of 2024):
- **LIST requests**: $0.005 per 1,000 requests

### Calculation for ~30,000 Objects

Assuming the bucket contains approximately 30,000 objects distributed across client directories:

1. **List Requests per Directory**:
   - S3 `ListObjectsV2` returns up to 1,000 objects per request
   - For 30,000 objects across ~80 client directories:
     - Average: ~375 objects per directory
     - Most directories: 1 LIST request
     - Some directories: 2-3 LIST requests (if >1,000 objects)

2. **Estimated Total Requests**:
   - Minimum: ~80 requests (1 per directory)
   - Maximum: ~240 requests (if many directories have >1,000 objects)
   - Realistic estimate: **~100-150 LIST requests**

3. **Cost Calculation**:
   - 100 requests: 100 / 1,000 × $0.005 = **$0.0005** (~$0.00)
   - 150 requests: 150 / 1,000 × $0.005 = **$0.00075** (~$0.00)
   - 240 requests: 240 / 1,000 × $0.005 = **$0.0012** (~$0.00)

### Summary

**Estimated cost for ~30,000 objects: Less than $0.01 (essentially free)**

The script is designed to be cost-effective:
- Only uses LIST operations (no data transfer costs)
- No GET operations (no data retrieval costs)
- No write operations (no PUT/COPY costs)
- Minimal API calls (batches up to 1,000 objects per request)

### Monitoring Actual Costs

To monitor actual costs:
1. Check AWS CloudWatch metrics for S3 API requests
2. Review AWS Cost Explorer for S3 LIST request charges
3. The script outputs the total number of LIST requests used

## Error Handling

- If a client directory cannot be accessed, the error is logged and included in the CSV
- The script continues processing remaining directories
- Fatal errors (e.g., authentication failures) will stop execution

## Script Safety

This script is **strictly read-only**:
- ✅ Only uses `ListObjectsV2Command` (read metadata)
- ❌ Does NOT use `PutObjectCommand`, `DeleteObjectCommand`, `CopyObjectCommand`
- ❌ Does NOT modify bucket configuration
- ❌ Does NOT create or update any S3 objects

## Troubleshooting

### Authentication Errors

```
Error: Unable to locate credentials
```

**Solution**: Configure AWS credentials using one of the methods listed in Prerequisites.

### Permission Denied

```
Error: Access Denied
```

**Solution**: Ensure the IAM user/role has `s3:ListBucket` permission for `assets.soundconcepts.com`.

### Network/Timeout Issues

If the script times out or encounters network errors:
- Check AWS region configuration (defaults to `us-east-1`)
- Verify network connectivity
- Consider running with increased timeout settings

## Example Output

```
Starting object count for bucket: assets.soundconcepts.com
Processing 80 client directories...

[1/80] Counting webroot_acetbn/assets/video/... 245 objects (1 list request(s))
[2/80] Counting webroot_amare/assets/video/... 1250 objects (2 list request(s))
[3/80] Counting webroot_ambit/assets/video/... 890 objects (1 list request(s))
...

============================================================
Summary:
  Total client directories processed: 80
  Total objects found: 28,450
  Total S3 LIST requests: 95
  Results exported to: /path/to/lambda/client-object-counts.csv
============================================================
```

