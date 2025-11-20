# Media Trigger - S3 to MediaConvert via EventBridge

This CDK project automatically triggers AWS MediaConvert jobs when MP4 files are uploaded to an S3 bucket, following the AWS-recommended pattern:

**S3 → EventBridge → Lambda → MediaConvert**

## Architecture

1. **S3**: MP4 file is uploaded to the bucket
2. **EventBridge**: S3 sends an "Object Created" event to EventBridge
3. **Lambda**: EventBridge triggers a Lambda function
4. **MediaConvert**: Lambda creates a MediaConvert job using the predefined template

## Prerequisites

- Node.js 20.x or later
- AWS CDK CLI v2 (`npm install -g aws-cdk`)
- AWS CLI configured with appropriate credentials
- AWS account with MediaConvert access

## Setup

1. **Install dependencies:**

```bash
cd media-trigger
npm install
cd lambda
npm install
cd ..
```

2. **Configure your environment:**

Edit `lib/media-trigger-stack.ts` to customize:
- `mediaConvertQueueArn`: Your MediaConvert queue ARN
- `mediaConvertRoleArn`: IAM role ARN for MediaConvert
- `existingBucketName`: If you want to use an existing S3 bucket instead of creating a new one

Or pass these as CDK context:

```bash
cdk deploy --context mediaConvertQueueArn=arn:aws:mediaconvert:... \
           --context mediaConvertRoleArn=arn:aws:iam::... \
           --context existingBucketName=my-existing-bucket
```

3. **Bootstrap CDK (first time only):**

```bash
cdk bootstrap
```

4. **Deploy the stack:**

```bash
npm run deploy
# or
cdk deploy
```

## Usage

Once deployed, simply upload an MP4 file to the S3 bucket:

```bash
aws s3 cp video.mp4 s3://<bucket-name>/path/to/video.mp4
```

The system will automatically:
1. Detect the upload via EventBridge
2. Trigger the Lambda function
3. Create a MediaConvert job
4. Process the video and overwrite the original file with the processed version

## MediaConvert Job Template

The job template is defined in `lambda/index.js` and matches the template from `media_converter/job/app.js`:

- **Output**: 1280x720 MP4
- **Video Codec**: H.264 (QVBR, max 3 Mbps)
- **Audio Codec**: AAC (96 kbps, stereo)
- **Output Location**: Same as input (overwrites original file)

## Stack Outputs

After deployment, the stack outputs:
- `InputBucketName`: S3 bucket name for uploads
- `LambdaFunctionArn`: Lambda function ARN
- `EventBridgeRuleArn`: EventBridge rule ARN

## Customization

### Use Existing S3 Bucket

Modify `bin/media-trigger.ts`:

```typescript
new MediaTriggerStack(app, 'MediaTriggerStack', {
  existingBucketName: 'my-existing-bucket',
  // ... other props
});
```

### Change MediaConvert Settings

Edit the `JOB_TEMPLATE` object in `lambda/index.js`.

### Filter Specific Paths

Modify the EventBridge rule in `lib/media-trigger-stack.ts` to add path filters:

```typescript
detail: {
  object: {
    key: [
      {
        prefix: 'videos/',
        suffix: '.mp4',
      },
    ],
  },
},
```

## Cleanup

To remove all resources:

```bash
cdk destroy
```

## Troubleshooting

### MediaConvert Endpoint

The Lambda function automatically fetches the MediaConvert endpoint. If you encounter issues, you can set it manually:

```bash
aws mediaconvert describe-endpoints --region us-east-1
```

### Lambda Logs

View Lambda execution logs:

```bash
aws logs tail /aws/lambda/MediaTriggerStack-MediaConvertLambda-<id> --follow
```

### EventBridge Events

Check EventBridge events in CloudWatch:

```bash
aws events list-rules --name-prefix S3MP4UploadRule
```

## License

ISC

