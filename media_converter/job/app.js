const { MediaConvertClient, CreateJobCommand, DescribeEndpointsCommand } = require('@aws-sdk/client-mediaconvert');
const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const CSV_FILE = process.env.CSV_FILE || path.join(__dirname, './s3-mp4-files.csv');
const MEDIACONVERT_ENDPOINT = process.env.MEDIACONVERT_ENDPOINT; // Will be fetched if not provided
const QUEUE_ARN = process.env.QUEUE_ARN || 'arn:aws:mediaconvert:us-east-1:964957925184:queues/Default';
const ROLE_ARN = process.env.ROLE_ARN || 'arn:aws:iam::964957925184:role/service-role/MediaConvert_Default_Role';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// MediaConvert job template
const JOB_TEMPLATE = {
  Queue: QUEUE_ARN,
  UserMetadata: {},
  Role: ROLE_ARN,
  Settings: {
    TimecodeConfig: {
      Source: 'ZEROBASED'
    },
    OutputGroups: [
      {
        Name: 'File Group',
        Outputs: [
          {
            ContainerSettings: {
              Container: 'MP4',
              Mp4Settings: {}
            },
            VideoDescription: {
              Width: 1280,
              Height: 720,
              CodecSettings: {
                Codec: 'H_264',
                H264Settings: {
                  MaxBitrate: 3000000,
                  RateControlMode: 'QVBR',
                  CodecProfile: 'MAIN',
                  CodecLevel: 'AUTO',
                  SceneChangeDetect: 'TRANSITION_DETECTION'
                }
              }
            },
            AudioDescriptions: [
              {
                AudioSourceName: 'Audio Selector 1',
                CodecSettings: {
                  Codec: 'AAC',
                  AacSettings: {
                    Bitrate: 96000,
                    CodingMode: 'CODING_MODE_2_0',
                    SampleRate: 48000
                  }
                }
              }
            ]
          }
        ],
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: {
            Destination: '', // Will be set per job
            DestinationSettings: {
              S3Settings: {
                StorageClass: 'STANDARD'
              }
            }
          }
        }
      }
    ],
    FollowSource: 1,
    Inputs: [
      {
        AudioSelectors: {
          'Audio Selector 1': {
            DefaultSelection: 'DEFAULT'
          }
        },
        TimecodeSource: 'ZEROBASED',
        FileInput: '' // Will be set per job
      }
    ]
  },
  BillingTagsSource: 'JOB',
  AccelerationSettings: {
    Mode: 'DISABLED'
  },
  StatusUpdateInterval: 'SECONDS_60',
  Priority: 0
};

// Initialize S3 client
const s3Client = new S3Client({
  region: AWS_REGION
});

// Initialize MediaConvert client (endpoint will be set after fetching)
let mediaConvertClient;

// Get MediaConvert endpoint
async function getMediaConvertEndpoint() {
  if (MEDIACONVERT_ENDPOINT && !MEDIACONVERT_ENDPOINT.includes('qjqjqjqjq')) {
    return MEDIACONVERT_ENDPOINT;
  }

  console.log('MediaConvert endpoint not configured. Fetching from AWS...');
  
  try {
    // Create a temporary client without endpoint to call DescribeEndpoints
    const tempClient = new MediaConvertClient({
      region: AWS_REGION
    });
    
    const command = new DescribeEndpointsCommand({ MaxResults: 1 });
    const response = await tempClient.send(command);
    
    if (response.Endpoints && response.Endpoints.length > 0) {
      const endpoint = response.Endpoints[0].Url;
      console.log(`✅ Found MediaConvert endpoint: ${endpoint}`);
      return endpoint;
    } else {
      throw new Error('No MediaConvert endpoints found');
    }
  } catch (error) {
    console.error('❌ Error fetching MediaConvert endpoint:', error.message);
    console.error('\nPlease set MEDIACONVERT_ENDPOINT in your .env file or environment variables.');
    console.error('You can get it by running:');
    console.error(`  aws mediaconvert describe-endpoints --region ${AWS_REGION}`);
    throw error;
  }
}

// Parse S3 URL to extract bucket and key
function parseS3Url(s3Url) {
  const match = s3Url.match(/^s3:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URL: ${s3Url}`);
  }
  return {
    bucket: match[1],
    key: match[2]
  };
}

// Generate original filename (add _original before .mp4)
function getOriginalKey(key) {
  return key.replace(/\.mp4$/i, '_original.mp4');
}

// Check if file exists in S3
async function fileExists(bucket, key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

// Rename file by copying to _original and deleting original
async function renameToOriginal(bucket, originalKey) {
  const originalKeyWithSuffix = getOriginalKey(originalKey);
  
  // Check if _original already exists
  const originalExists = await fileExists(bucket, originalKeyWithSuffix);
  if (originalExists) {
    console.log(`  ⚠️  Original file already exists: ${originalKeyWithSuffix}`);
    return originalKeyWithSuffix;
  }

  // Copy original to _original
  console.log(`  📋 Copying ${originalKey} to ${originalKeyWithSuffix}`);
  await s3Client.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${originalKey}`,
    Key: originalKeyWithSuffix
  }));

  // Delete original
  console.log(`  🗑️  Deleting original file: ${originalKey}`);
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: originalKey
  }));

  return originalKeyWithSuffix;
}

// Create MediaConvert job
async function createMediaConvertJob(inputS3Url, outputS3Url, index) {
  const jobConfig = JSON.parse(JSON.stringify(JOB_TEMPLATE));
  
  // Update input and output paths
  jobConfig.Settings.Inputs[0].FileInput = inputS3Url;
  jobConfig.Settings.OutputGroups[0].OutputGroupSettings.FileGroupSettings.Destination = outputS3Url;
  
  // Add metadata
  jobConfig.UserMetadata = {
    'input-file': inputS3Url,
    'output-file': outputS3Url,
    'job-index': index.toString()
  };

  try {
    const command = new CreateJobCommand(jobConfig);
    const response = await mediaConvertClient.send(command);
    return response.Job?.Id;
  } catch (error) {
    console.error(`  ❌ Error creating job: ${error.message}`);
    throw error;
  }
}

// Process a single video
async function processVideo(s3Url, index, total) {
  console.log(`\n[${index}/${total}] Processing: ${s3Url}`);
  
  try {
    const { bucket, key } = parseS3Url(s3Url);
    
    // Step 1: Rename original file to _original
    const originalKey = await renameToOriginal(bucket, key);
    const originalS3Url = `s3://${bucket}/${originalKey}`;
    
    // Step 2: Create MediaConvert job
    // Input: _original file, Output: original filename
    const outputS3Url = s3Url; // Output should be the original filename
    console.log(`  🎬 Creating MediaConvert job...`);
    console.log(`     Input:  ${originalS3Url}`);
    console.log(`     Output: ${outputS3Url}`);
    
    const jobId = await createMediaConvertJob(originalS3Url, outputS3Url, index);
    console.log(`  ✅ Job created successfully! Job ID: ${jobId}`);
    
    return { success: true, jobId, s3Url, originalS3Url, outputS3Url };
  } catch (error) {
    console.error(`  ❌ Failed to process: ${error.message}`);
    return { success: false, error: error.message, s3Url };
  }
}

// Main function
async function main() {
  console.log('MediaConvert Job Processor');
  console.log('==========================\n');
  console.log(`CSV File: ${CSV_FILE}`);
  console.log(`Region: ${AWS_REGION}`);
  console.log(`Queue: ${QUEUE_ARN}\n`);

  // Get MediaConvert endpoint
  const endpoint = await getMediaConvertEndpoint();
  
  // Initialize MediaConvert client with the endpoint
  mediaConvertClient = new MediaConvertClient({
    region: AWS_REGION,
    endpoint: endpoint
  });
  
  console.log(`MediaConvert Endpoint: ${endpoint}\n`);

  // Read and parse CSV
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`Error: CSV file not found: ${CSV_FILE}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(CSV_FILE, 'utf8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Found ${records.length} videos to process\n`);

  const results = {
    successful: [],
    failed: []
  };

  // Process each video
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const s3Url = record.S3_URL?.replace(/^"|"$/g, ''); // Remove quotes if present
    
    if (!s3Url) {
      console.log(`[${i + 1}/${records.length}] ⚠️  Skipping row: No S3_URL found`);
      continue;
    }

    const result = await processVideo(s3Url, i + 1, records.length);
    
    if (result.success) {
      results.successful.push(result);
    } else {
      results.failed.push(result);
    }

    // Add a small delay to avoid rate limiting
    if (i < records.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Summary
  console.log('\n\n==========================');
  console.log('Processing Summary');
  console.log('==========================');
  console.log(`Total videos: ${records.length}`);
  console.log(`✅ Successful: ${results.successful.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log('\nFailed videos:');
    results.failed.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.s3Url} - ${result.error}`);
    });
  }

  // Save results to JSON file
  const resultsFile = path.join(__dirname, 'processing-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

// Run the application
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

