const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// Configuration
const BUCKET_NAME = 'assets.soundconcepts.com';
const OUTPUT_FILE = 's3-mp4-files.csv';
const CLIENT = [
  "webroot_acetbn",
  "webroot_amare",
  "webroot_ambit",
  "webroot_amshomes",
  "webroot_arbonne",
  "webroot_arieyl",
  "webroot_arkshire",
  "webroot_asea",
  "webroot_australiana",
  "webroot_avere",
  "webroot_b3science",
  "webroot_bedroom",
  "webroot_bemer",
  "webroot_beyondslim",
  "webroot_boncook",
  "webroot_cili",
  "webroot_cirrus",
  "webroot_clubo",
  "webroot_demo",
  "webroot_dswa",
  "webroot_dynomic",
  "webroot_engage",
  "webroot_evolv",
  "webroot_galexxy",
  "webroot_gofinity",
  "webroot_hellobrightools",
  "webroot_inkling",
  "webroot_isapulse",
  "webroot_itworks",
  "webroot_jbloom",
  "webroot_juiceplus",
  "webroot_juuva",
  "webroot_kannaway",
  "webroot_kyani",
  "webroot_lbri",
  "webroot_legalshield",
  "webroot_level",
  "webroot_livepure",
  "webroot_lync",
  "webroot_magnolia",
  "webroot_makeimpact",
  "webroot_mannago",
  "webroot_marketamer",
  "webroot_mentor",
  "webroot_merryvital",
  "webroot_missthis",
  "webroot_mojilife",
  "webroot_monavie",
  "webroot_morinda",
  "webroot_nerium",
  "webroot_newuconnect",
  "webroot_onehope",
  "webroot_origamiowl",
  "webroot_paparazzi",
  "webroot_prife",
  "webroot_purium",
  "webroot_rainmobile",
  "webroot_savvi",
  "webroot_seint",
  "webroot_sendoutcards",
  "webroot_shaklee",
  "webroot_shiftpro",
  "webroot_sisel",
  "webroot_spotless",
  "webroot_syona",
  "webroot_thinkapp",
  "webroot_threeapp",
  "webroot_thrivelife",
  "webroot_touchstone",
  "webroot_towergarden",
  "webroot_tranont2020",
  "webroot_truaura",
  "webroot_verb",
  "webroot_verbcrm",
  "webroot_verbpilot",
  "webroot_verbsales",
  "webroot_vidafy",
  "webroot_viridian",
  "webroot_vni",
  "webroot_wisebuildr",
  "webroot_xyngularapp",
  "webroot_yoli",
  "webroot_youngevity",
  "webroot_zilisconnect",
  "webroot_zyia"
];

const DAYS_AGO = 10;

if (!BUCKET_NAME) {
  console.error('Error: S3 bucket name is required');
  console.error('Usage: node app.js <bucket-name> [output-file]');
  console.error('Or set S3_BUCKET_NAME environment variable');
  process.exit(1);
}

// Initialize S3 client (uses default credential provider chain)
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1'
});

// Calculate the date 7 days ago
function getDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

// Check if file is .mp4 and uploaded within the cutoff date
function shouldIncludeObject(object, cutoffDate) {
  // Check if file ends with .mp4
  if (!object.Key.toLowerCase().endsWith('.mp4')) {
    return false;
  }

  // Check if uploaded within the cutoff date
  const lastModified = new Date(object.LastModified);
  
  return lastModified >= cutoffDate;
}

// Generate S3 URL
function getS3Url(bucket, key) {
  return `s3://${bucket}/${key}`;
}

// List and filter objects in bucket with prefix filter
async function listAndFilterObjects(bucketName, prefix, daysAgo) {
  const filteredObjects = [];
  let totalObjects = 0;
  let continuationToken = undefined;
  const cutoffDate = getDateDaysAgo(daysAgo);

  do {
    const commandParams = {
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken
    };

    const command = new ListObjectsV2Command(commandParams);

    try {
      const response = await s3Client.send(command);
      
      // Log response details
      const objectsInBatch = response.Contents ? response.Contents.length : 0;
      const hasMore = !!response.NextContinuationToken;
      console.log(`  Response: ${objectsInBatch} objects${hasMore ? ' (more pages available)' : ' (last page)'}`);
      
      if (response.Contents) {
        totalObjects += response.Contents.length;
        
        // Filter objects before adding to array to reduce memory usage
        let filteredInBatch = 0;
        for (const obj of response.Contents) {
          if (shouldIncludeObject(obj, cutoffDate)) {
            filteredObjects.push({
              key: obj.Key,
              lastModified: obj.LastModified,
              size: obj.Size,
              s3Url: getS3Url(bucketName, obj.Key)
            });
            filteredInBatch++;
          }
        }
        if (filteredInBatch > 0) {
          console.log(`    Filtered: ${filteredInBatch} matching .mp4 files in this batch`);
        }
      }

      continuationToken = response.NextContinuationToken;
    } catch (error) {
      console.error('Error listing objects:', error);
      throw error;
    }
  } while (continuationToken);

  return { filteredObjects, totalObjects };
}

// Write results to CSV
function writeToCSV(objects, outputFile) {
  const csvHeader = 'S3_URL,LastModified,Size\n';
  const csvRows = objects.map(obj => {
    const lastModified = obj.lastModified instanceof Date 
      ? obj.lastModified.toISOString() 
      : new Date(obj.lastModified).toISOString();
    return `"${obj.s3Url}","${lastModified}",${obj.size}`;
  }).join('\n');
  const csvContent = csvHeader + csvRows;

  fs.writeFileSync(outputFile, csvContent, 'utf8');
  console.log(`\nOutput written to: ${path.resolve(outputFile)}`);
}

// Main function
async function main() {
  console.log(`Listing .mp4 files from bucket: ${BUCKET_NAME}`);
  console.log(`Clients: ${CLIENT.join(', ')}`);
  console.log(`Prefix pattern: <client>/assets/video/`);
  console.log(`Filtering files uploaded in the last ${DAYS_AGO} days...`);
  console.log(`Cutoff date: ${getDateDaysAgo(DAYS_AGO).toISOString()}\n`);

  try {
    const allFilteredObjects = [];
    let totalObjectsCount = 0;

    // Process each client prefix
    for (const client of CLIENT) {
      const prefix = `${client}/assets/video/`;
      
      console.log(`\nProcessing client: ${client}`);
      console.log(`  Prefix: ${prefix}`);
      
      const { filteredObjects, totalObjects } = await listAndFilterObjects(
        BUCKET_NAME, 
        prefix, 
        DAYS_AGO
      );
      
      console.log(`  Found ${totalObjects} total objects`);
      console.log(`  Found ${filteredObjects.length} matching .mp4 files`);
      
      allFilteredObjects.push(...filteredObjects);
      totalObjectsCount += totalObjects;
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total objects scanned: ${totalObjectsCount}`);
    console.log(`Total matching .mp4 files: ${allFilteredObjects.length}`);

    if (allFilteredObjects.length === 0) {
      console.log('No matching files found.');
      return;
    }

    // Write to CSV
    writeToCSV(allFilteredObjects, OUTPUT_FILE);
    console.log(`Output file: ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Error:', error.message);
    if (error.name === 'NoSuchBucket') {
      console.error(`Bucket "${BUCKET_NAME}" does not exist or you don't have access to it.`);
    } else if (error.name === 'AccessDenied') {
      console.error('Access denied. Please check your AWS credentials and permissions.');
    }
    process.exit(1);
  }
}

// Run the application
main();

