const { MediaConvertClient, CreateJobCommand, DescribeEndpointsCommand } = require('@aws-sdk/client-mediaconvert');
const { S3Client, CopyObjectCommand } = require('@aws-sdk/client-s3');

const JOB_TEMPLATE = {
  Queue: process.env.MEDIA_CONVERT_QUEUE_ARN,
  UserMetadata: {},
  Role: process.env.MEDIA_CONVERT_ROLE_ARN,
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
            Destination: '',
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
        FileInput: ''
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

let mediaConvertClient = null;
let mediaConvertEndpoint = null;

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1'
});

function getOriginalKey(key) {
  return key.replace(/\.mp4$/i, '_original.mp4');
}

async function createBackup(bucket, originalKey) {
  const originalKeyWithSuffix = getOriginalKey(originalKey);
  
  console.log(`Creating backup: ${originalKey} → ${originalKeyWithSuffix}`);
  try {
    await s3Client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${originalKey}`,
      Key: originalKeyWithSuffix
    }));
    console.log(`Backup created successfully`);
    return originalKeyWithSuffix;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      throw new Error(`Source file does not exist: ${originalKey}`);
    }
    console.error(`Backup creation failed: ${error.message}`);
    throw new Error(`Failed to create backup ${originalKey} to ${originalKeyWithSuffix}: ${error.message}`);
  }
}

async function getMediaConvertEndpoint() {
  if (mediaConvertEndpoint) {
    return mediaConvertEndpoint;
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  
  try {
    const tempClient = new MediaConvertClient({
      region: region
    });
    
    const command = new DescribeEndpointsCommand({ MaxResults: 1 });
    const response = await tempClient.send(command);
    
    if (response.Endpoints && response.Endpoints.length > 0) {
      mediaConvertEndpoint = response.Endpoints[0].Url;
      console.log(`Found MediaConvert endpoint: ${mediaConvertEndpoint}`);
      return mediaConvertEndpoint;
    } else {
      throw new Error('No MediaConvert endpoints found');
    }
  } catch (error) {
    console.error('Error fetching MediaConvert endpoint:', error.message);
    throw error;
  }
}

async function getMediaConvertClient() {
  if (mediaConvertClient) {
    return mediaConvertClient;
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  const endpoint = await getMediaConvertEndpoint();
  
  mediaConvertClient = new MediaConvertClient({
    region: region,
    endpoint: endpoint
  });
  
  return mediaConvertClient;
}

async function createMediaConvertJob(inputS3Url, outputS3Url) {
  const client = await getMediaConvertClient();
  const jobConfig = JSON.parse(JSON.stringify(JOB_TEMPLATE));
  
  jobConfig.Settings.Inputs[0].FileInput = inputS3Url;
  
  const outputDestination = outputS3Url.replace(/\.mp4$/i, '');
  jobConfig.Settings.OutputGroups[0].OutputGroupSettings.FileGroupSettings.Destination = outputDestination;
  
  jobConfig.UserMetadata = {
    'input-file': inputS3Url,
    'output-file': outputS3Url,
    'source': 's3-eventbridge-lambda'
  };

  try {
    const command = new CreateJobCommand(jobConfig);
    const response = await client.send(command);
    return response.Job?.Id;
  } catch (error) {
    console.error(`Error creating job: ${error.message}`);
    throw error;
  }
}

exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  try {
    const bucketName = event.detail.bucket.name;
    const objectKey = event.detail.object.key;

    if(!objectKey.includes('webroot_test/assets/video/')) {
      console.log(`Skipping non-test file: ${objectKey}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped: Not a test file' })
      };
    }
    
    if (!objectKey.toLowerCase().endsWith('.mp4')) {
      console.log(`Skipping non-MP4 file: ${objectKey}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped: Not an MP4 file' })
      };
    }

    const originalKeyWithSuffix = await createBackup(bucketName, objectKey);
    const inputS3Url = `s3://${bucketName}/${originalKeyWithSuffix}`;
    const outputS3Url = `s3://${bucketName}/${objectKey}`;

    console.log(`Processing: ${inputS3Url}`);
    console.log(`Output: ${outputS3Url}`);

    const jobId = await createMediaConvertJob(inputS3Url, outputS3Url);
    
    console.log(`✅ MediaConvert job created successfully! Job ID: ${jobId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'MediaConvert job created successfully',
        jobId: jobId,
        inputFile: inputS3Url,
        outputFile: outputS3Url
      })
    };
  } catch (error) {
    console.error('Error processing event:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error creating MediaConvert job',
        error: error.message
      })
    };
  }
};

