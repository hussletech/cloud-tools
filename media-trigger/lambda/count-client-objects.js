const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// Fixed bucket name
const BUCKET_NAME = 'assets.soundconcepts.com';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Clients array from index.js (lines 336-422)
const CLIENTS = [
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

// Initialize S3 client (read-only operations only)
const s3Client = new S3Client({
  region: AWS_REGION
});

/**
 * Count objects in a specific client directory prefix
 * This function is strictly read-only - only uses ListObjectsV2Command
 * @param {string} prefix - The S3 key prefix (e.g., "webroot_amare/assets/video/")
 * @returns {Promise<number>} - The count of objects in the directory
 */
async function countObjectsInPrefix(prefix) {
  let objectCount = 0;
  let continuationToken = undefined;
  let listRequestCount = 0;

  do {
    try {
      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: 1000, // Maximum allowed per request
        ContinuationToken: continuationToken
      });

      const response = await s3Client.send(command);
      listRequestCount++;

      if (response.Contents) {
        objectCount += response.Contents.length;
      }

      continuationToken = response.NextContinuationToken;
    } catch (error) {
      console.error(`Error listing objects for prefix "${prefix}": ${error.message}`);
      throw error;
    }
  } while (continuationToken);

  return { count: objectCount, listRequests: listRequestCount };
}

/**
 * Main function to count objects for all clients and export to CSV
 */
async function main() {
  console.log(`Starting object count for bucket: ${BUCKET_NAME}`);
  console.log(`Processing ${CLIENTS.length} client directories...\n`);

  const results = [];
  let totalObjects = 0;
  let totalListRequests = 0;

  for (let i = 0; i < CLIENTS.length; i++) {
    const clientPrefix = CLIENTS[i];
    const clientName = clientPrefix.replace(/^webroot_/, '').replace(/\/assets\/video\/$/, '');
    
    process.stdout.write(`[${i + 1}/${CLIENTS.length}] Counting ${clientPrefix}... `);
    
    try {
      const { count, listRequests } = await countObjectsInPrefix(clientPrefix);
      totalObjects += count;
      totalListRequests += listRequests;
      
      results.push({
        clientDirectory: clientPrefix,
        clientName: clientName,
        objectCount: count
      });
      
      console.log(`${count} objects (${listRequests} list request(s))`);
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      results.push({
        clientDirectory: clientPrefix,
        clientName: clientName,
        objectCount: 'ERROR',
        error: error.message
      });
    }
  }

  // Generate CSV content
  const csvHeader = 'Client Directory,Client Name,Object Count\n';
  const csvRows = results.map(result => {
    const count = result.objectCount === 'ERROR' ? result.error : result.objectCount;
    return `"${result.clientDirectory}","${result.clientName}",${count}`;
  }).join('\n');
  const csvContent = csvHeader + csvRows;

  // Write CSV file to the same directory as the script
  const scriptDir = __dirname;
  const outputPath = path.join(scriptDir, 'client-object-counts.csv');
  
  fs.writeFileSync(outputPath, csvContent, 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log(`  Total client directories processed: ${CLIENTS.length}`);
  console.log(`  Total objects found: ${totalObjects.toLocaleString()}`);
  console.log(`  Total S3 LIST requests: ${totalListRequests}`);
  console.log(`  Results exported to: ${outputPath}`);
  console.log('='.repeat(60));
}

// Run the script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

