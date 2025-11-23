const { MediaConvertClient, CreateJobCommand, DescribeEndpointsCommand } = require('@aws-sdk/client-mediaconvert');
const { S3Client, CopyObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Environment variables - read once at module load
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MEDIA_CONVERT_QUEUE_ARN = process.env.MEDIA_CONVERT_QUEUE_ARN;
const MEDIA_CONVERT_ROLE_ARN = process.env.MEDIA_CONVERT_ROLE_ARN;
const DAILY_JOB_LIMIT = parseInt(process.env.DAILY_JOB_LIMIT || '100', 10);
const COUNTER_BUCKET = 'assets.soundconcepts.com';
const COUNTER_KEY_PREFIX = `brightcove-videos/mediaconvert-daily-counter/`;
const COUNTER_EXPIRATION_DAYS = 2;

const JOB_TEMPLATE = {
  Queue: MEDIA_CONVERT_QUEUE_ARN,
  UserMetadata: {},
  Role: MEDIA_CONVERT_ROLE_ARN,
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
                StorageClass: 'INTELLIGENT_TIERING'
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
  region: AWS_REGION
});


function getTodayDateKey() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD format
  return `${COUNTER_KEY_PREFIX}${dateStr}.txt`;
}

async function getDailyCounter(bucket, dateKey) {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: dateKey
    }));
    
    const body = await response.Body.transformToString();
    const count = parseInt(body.trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch (error) {
    // Handle case where counter file doesn't exist yet (first job of the day)
    const isNotFound = 
      error.name === 'NoSuchKey' || 
      error.name === 'NotFound' ||
      error.$metadata?.httpStatusCode === 404;
    
    if (isNotFound) {
      return 0; // First job of the day - counter file doesn't exist yet
    }
    throw error;
  }
}

async function incrementDailyCounter(bucket, dateKey, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Read current count
      const currentCount = await getDailyCounter(bucket, dateKey);
      
      // Check if we've hit the limit
      if (currentCount >= DAILY_JOB_LIMIT) {
        return { success: false, count: currentCount, limit: DAILY_JOB_LIMIT };
      }
      
      // Increment and write back
      const newCount = currentCount + 1;
      // Calculate expiration date (2 days from now)
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + COUNTER_EXPIRATION_DAYS);
      
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: dateKey,
        Body: newCount.toString(),
        ContentType: 'text/plain',
        Metadata: {
          'expires-after-days': COUNTER_EXPIRATION_DAYS.toString(),
          'expiration-date': expirationDate.toISOString()
        }
      }));
      
      return { success: true, count: newCount, limit: DAILY_JOB_LIMIT };
    } catch (error) {
      // If it's a race condition (concurrent writes), retry
      if (attempt < maxRetries - 1) {
        // Exponential backoff: wait 50ms * 2^attempt
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Failed to increment counter after retries');
}

async function cleanupOldCounterFiles(bucket) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - COUNTER_EXPIRATION_DAYS);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    
    // List all counter files
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: COUNTER_KEY_PREFIX
    });
    
    const response = await s3Client.send(listCommand);
    
    if (!response.Contents || response.Contents.length === 0) {
      return;
    }
    
    // Delete files older than retention period
    const deletePromises = [];
    for (const object of response.Contents) {
      // Extract date from filename: .mediaconvert-daily-counter/YYYY-MM-DD.txt
      const match = object.Key.match(/(\d{4}-\d{2}-\d{2})\.txt$/);
      if (match && match[1] < cutoffDateStr) {
        deletePromises.push(
          s3Client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: object.Key
          })).catch(err => {
            console.warn(`Failed to delete old counter file ${object.Key}: ${err.message}`);
          })
        );
      }
    }
    
    if (deletePromises.length > 0) {
      await Promise.all(deletePromises);
      console.log(`Cleaned up ${deletePromises.length} old counter file(s) older than ${COUNTER_EXPIRATION_DAYS} days`);
    }
  } catch (error) {
    // Don't fail the main operation if cleanup fails
    console.warn(`Counter cleanup failed (non-critical): ${error.message}`);
  }
}

function getOriginalKey(key) {
  return key.replace(/\.mp4$/i, '_original.mp4');
}

async function checkOriginalExists(bucket, originalKey) {
  const originalKeyWithSuffix = getOriginalKey(originalKey);
  
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: originalKeyWithSuffix
    }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function createBackup(bucket, originalKey) {
  const originalKeyWithSuffix = getOriginalKey(originalKey);
  
  console.log(`Creating backup: ${originalKey} → ${originalKeyWithSuffix}`);
  try {
    await s3Client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${originalKey}`,
      Key: originalKeyWithSuffix,
      StorageClass: 'INTELLIGENT_TIERING'
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
  
  try {
    const tempClient = new MediaConvertClient({
      region: AWS_REGION
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

  const endpoint = await getMediaConvertEndpoint();
  
  mediaConvertClient = new MediaConvertClient({
    region: AWS_REGION,
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

    // const CLIENT = ['webroot_amare/assets/video/', "webroot_ambit/assets/video/", "webroot_beyondslim/assets/video/"];
    const CLIENT = [
      "webroot_acetbn/assets/video/",
      "webroot_amare/assets/video/",
      "webroot_ambit/assets/video/",
      "webroot_amshomes/assets/video/",
      "webroot_arbonne/assets/video/",
      "webroot_arieyl/assets/video/",
      "webroot_arkshire/assets/video/",
      "webroot_asea/assets/video/",
      "webroot_australiana/assets/video/",
      "webroot_avere/assets/video/",
      "webroot_b3science/assets/video/",
      "webroot_bedroom/assets/video/",
      "webroot_bemer/assets/video/",
      "webroot_beyondslim/assets/video/",
      "webroot_boncook/assets/video/",
      "webroot_cili/assets/video/",
      "webroot_cirrus/assets/video/",
      "webroot_clubo/assets/video/",
      "webroot_demo/assets/video/",
      "webroot_dswa/assets/video/",
      "webroot_dynomic/assets/video/",
      "webroot_engage/assets/video/",
      "webroot_evolv/assets/video/",
      "webroot_galexxy/assets/video/",
      "webroot_gofinity/assets/video/",
      "webroot_hellobrightools/assets/video/",
      "webroot_inkling/assets/video/",
      "webroot_isapulse/assets/video/",
      "webroot_itworks/assets/video/",
      "webroot_jbloom/assets/video/",
      "webroot_juiceplus/assets/video/",
      "webroot_juuva/assets/video/",
      "webroot_kannaway/assets/video/",
      "webroot_kyani/assets/video/",
      "webroot_lbri/assets/video/",
      "webroot_legalshield/assets/video/",
      "webroot_level/assets/video/",
      "webroot_livepure/assets/video/",
      "webroot_lync/assets/video/",
      "webroot_magnolia/assets/video/",
      "webroot_makeimpact/assets/video/",
      "webroot_mannago/assets/video/",
      "webroot_marketamer/assets/video/",
      "webroot_mentor/assets/video/",
      "webroot_merryvital/assets/video/",
      "webroot_missthis/assets/video/",
      "webroot_mojilife/assets/video/",
      "webroot_monavie/assets/video/",
      "webroot_morinda/assets/video/",
      "webroot_nerium/assets/video/",
      "webroot_newuconnect/assets/video/",
      "webroot_onehope/assets/video/",
      "webroot_origamiowl/assets/video/",
      "webroot_paparazzi/assets/video/",
      "webroot_prife/assets/video/",
      "webroot_purium/assets/video/",
      "webroot_rainmobile/assets/video/",
      "webroot_savvi/assets/video/",
      "webroot_seint/assets/video/",
      "webroot_sendoutcards/assets/video/",
      "webroot_shaklee/assets/video/",
      "webroot_shiftpro/assets/video/",
      "webroot_sisel/assets/video/",
      "webroot_spotless/assets/video/",
      "webroot_syona/assets/video/",
      "webroot_thinkapp/assets/video/",
      "webroot_threeapp/assets/video/",
      "webroot_thrivelife/assets/video/",
      "webroot_touchstone/assets/video/",
      "webroot_towergarden/assets/video/",
      "webroot_tranont2020/assets/video/",
      "webroot_truaura/assets/video/",
      "webroot_verb/assets/video/",
      "webroot_verbcrm/assets/video/",
      "webroot_verbpilot/assets/video/",
      "webroot_verbsales/assets/video/",
      "webroot_vidafy/assets/video/",
      "webroot_viridian/assets/video/",
      "webroot_vni/assets/video/",
      "webroot_wisebuildr/assets/video/",
      "webroot_xyngularapp/assets/video/",
      "webroot_yoli/assets/video/",
      "webroot_youngevity/assets/video/",
      "webroot_zilisconnect/assets/video/",
      "webroot_zyia/assets/video/"
    ];

    if(!CLIENT.some(key => objectKey.includes(key)) || (objectKey.includes("_original"))) {
      console.log(`Skipping file: ${objectKey} because it is not a webroot file or original file`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped: Not a test file or original file' })
      };
    }
    
    if (!objectKey.toLowerCase().endsWith('.mp4')) {
      console.log(`Skipping non-MP4 file: ${objectKey}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped: Not an MP4 file' })
      };
    }

    // Check daily job limit at the beginning (before any expensive operations)
    const dateKey = getTodayDateKey();
    const currentCount = await getDailyCounter(COUNTER_BUCKET, dateKey);
    
    if (currentCount >= DAILY_JOB_LIMIT) {
      console.log(`Daily job limit reached: ${currentCount}/${DAILY_JOB_LIMIT}`);
      return {
        statusCode: 429,
        body: JSON.stringify({
          message: 'Daily job limit reached',
          currentCount: currentCount,
          limit: DAILY_JOB_LIMIT,
          retryAfter: 'tomorrow'
        })
      };
    }

    const originalKeyWithSuffix = getOriginalKey(objectKey);
    const originalExists = await checkOriginalExists(bucketName, objectKey);
    
    if (originalExists) {
      console.log(`Skipping: _original file already exists: ${originalKeyWithSuffix}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Skipped: _original file already exists, processing may already be in progress' })
      };
    }

    await createBackup(bucketName, objectKey);
    const inputS3Url = `s3://${bucketName}/${originalKeyWithSuffix}`;
    const outputS3Url = `s3://${bucketName}/${objectKey}`;

    console.log(`Processing: ${inputS3Url}`);
    console.log(`Output: ${outputS3Url}`);

    // Increment counter (we already checked the limit above)
    const counterResult = await incrementDailyCounter(COUNTER_BUCKET, dateKey);
    
    if (!counterResult.success) {
      // This should rarely happen since we checked above, but handle race condition
      console.log(`Daily job limit reached during increment: ${counterResult.count}/${counterResult.limit}`);
      return {
        statusCode: 429,
        body: JSON.stringify({
          message: 'Daily job limit reached',
          currentCount: counterResult.count,
          limit: counterResult.limit,
          retryAfter: 'tomorrow'
        })
      };
    }
    
    console.log(`Daily job count: ${counterResult.count}/${counterResult.limit}`);

    const jobId = await createMediaConvertJob(inputS3Url, outputS3Url);
    
    console.log(`✅ MediaConvert job created successfully! Job ID: ${jobId}`);

    // // Cleanup old counter files asynchronously (non-blocking)
    // cleanupOldCounterFiles(COUNTER_BUCKET).catch(err => {
    //   console.warn(`Background cleanup failed (non-critical): ${err.message}`);
    // });

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

