require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const OUTPUT_BASE_PATH = '/home/ec2-user/assets.soundconcepts.com/brightcove-videos';
const MAX_CONCURRENT_VIDEOS = 30;
const MAX_PROCESSING_TIME_MS = 10 * 60 * 1000; // 10 minutes timeout
const SKIP_EXISTING_FILES = true;
const DISCOVERY_CSV_PATH = path.join(OUTPUT_BASE_PATH, 'brightcove-discovery.csv');
const OUTPUT_CSV_PATH = path.join(OUTPUT_BASE_PATH, 'output-bc-migration.csv');
const BRIGHTCOVE_OAUTH_URL = 'https://oauth.brightcove.com/v4/access_token';
const BRIGHTCOVE_CMS_URL = 'https://cms.api.brightcove.com/v1';
const BRIGHTCOVE_ACCOUNT_ID = '659677170001';

const getAuthHeader = () => {
  const credentials = Buffer.from(`${process.env.API_KEY}:${process.env.API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
};

const getAccessToken = async () => {
  const response = await axios.post(
    BRIGHTCOVE_OAUTH_URL,
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getAuthHeader()
      }
    }
  );
  return response.data.access_token;
};

const escapeCsvField = (field) => {
  if (field === null || field === undefined) return '""';
  let stringField = String(field);
  
  // Clean up the field content
  stringField = stringField
    .replace(/\r\n/g, ' ')  // Replace Windows line breaks
    .replace(/\n/g, ' ')    // Replace Unix line breaks
    .replace(/\r/g, ' ')    // Replace Mac line breaks
    .replace(/\s+/g, ' ')   // Replace multiple spaces with single space
    .trim();                // Trim whitespace
  
  // Always quote fields to avoid parsing issues
  return `"${stringField.replace(/"/g, '""')}"`;
};

const discoverAndSaveAllVideos = async (accessToken, maxVideos = null) => {
  let offset = 0;
  const limit = 100; // Brightcove API max per request
  let hasMoreVideos = true;
  let totalDiscovered = 0;

  console.log('Starting video discovery from Brightcove...');
  if (maxVideos) {
    console.log(`Discovery limit: ${maxVideos} videos (for testing)`);
  }
  console.log(`Saving discovery results to: ${DISCOVERY_CSV_PATH}`);
  
  // Ensure output directory exists
  const outputDir = path.dirname(DISCOVERY_CSV_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create CSV header
  const headerFields = ['brightcove_id', 'video_name', 'created_at', 'duration', 'tags', 'description', 'is_downloaded', 'download_date', 'file_name', 'container'];
  const header = headerFields.map(field => escapeCsvField(field)).join(',') + '\n';
  fs.writeFileSync(DISCOVERY_CSV_PATH, header, 'utf-8');

  while (hasMoreVideos) {
    try {
      const response = await axios.get(
        `${BRIGHTCOVE_CMS_URL}/accounts/${BRIGHTCOVE_ACCOUNT_ID}/videos`,
        {
          params: { limit, offset },
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      const videos = response.data;
      
      if (videos.length === 0) {
        hasMoreVideos = false;
      } else {
        // Write videos to CSV immediately (streaming approach)
        for (const video of videos) {
          // Check if we've reached the limit
          if (maxVideos && totalDiscovered >= maxVideos) {
            hasMoreVideos = false;
            break;
          }
          
          const name = video.name || 'Untitled';
          const created_at = video.created_at || '';
          const duration = video.duration || 0;
          const tags = video.tags ? video.tags.join('; ') : '';
          const description = (video.description || '').substring(0, 500); // Limit description length
          
          const csvLine = `${escapeCsvField(video.id)},${escapeCsvField(name)},${escapeCsvField(created_at)},${escapeCsvField(duration)},${escapeCsvField(tags)},${escapeCsvField(description)},${escapeCsvField('false')},${escapeCsvField('')},${escapeCsvField('')},${escapeCsvField('')}\n`;
          fs.appendFileSync(DISCOVERY_CSV_PATH, csvLine, 'utf-8');
          
          totalDiscovered++;
        }
        
        offset += videos.length;
        console.log(`Discovered ${totalDiscovered} videos so far...`);
        
        // Check if we've reached the limit after processing the batch
        if (maxVideos && totalDiscovered >= maxVideos) {
          hasMoreVideos = false;
        }
      }
    } catch (error) {
      console.error(`Error fetching videos at offset ${offset}:`, error.message);
      throw error;
    }
  }

  console.log(`\nTotal videos discovered and saved: ${totalDiscovered}`);
  return totalDiscovered;
};

const parseCsvLine = (line) => {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        field += '"';
        i += 2;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(field);
      field = '';
      i++;
    } else {
      field += char;
      i++;
    }
  }
  
  // Add the last field
  fields.push(field);
  
  return fields;
};

const readDiscoveryCsv = () => {
  if (!fs.existsSync(DISCOVERY_CSV_PATH)) {
    throw new Error(`Discovery CSV not found at ${DISCOVERY_CSV_PATH}. Please run discovery phase first.`);
  }

  const fileContent = fs.readFileSync(DISCOVERY_CSV_PATH, 'utf-8');
  const lines = fileContent.split('\n').filter(line => line.trim());
  
  // Skip header
  const videoLines = lines.slice(1);
  
  const videos = [];
  for (const line of videoLines) {
    try {
      const fields = parseCsvLine(line);
      
      if (fields.length >= 10) {
        const [bc_id, name, created_at, duration, tags, description, is_downloaded, download_date, file_name, container] = fields;
        
        // Only include videos that haven't been downloaded yet
        if (is_downloaded !== 'true') {
          videos.push({
            bc_id: bc_id.trim(),
            name: name.trim(),
            created_at: created_at.trim(),
            duration: parseInt(duration.trim(), 10) || 0,
            tags: tags.trim(),
            description: description.trim(),
            is_downloaded: is_downloaded.trim() === 'true',
            download_date: download_date.trim(),
            file_name: file_name.trim(),
            container: container.trim()
          });
        }
      }
    } catch (error) {
      console.warn(`Failed to parse CSV line: ${line.substring(0, 100)}...`);
    }
  }
  
  return videos;
};

const updateDiscoveryCsvAfterDownload = (bc_id, fileName, container) => {
  const fileContent = fs.readFileSync(DISCOVERY_CSV_PATH, 'utf-8');
  const lines = fileContent.split('\n');
  
  const updatedLines = lines.map(line => {
    if (line.trim() && line.includes(bc_id)) {
      try {
        const fields = parseCsvLine(line);
        if (fields.length >= 10 && fields[0] === bc_id) {
          // Update the is_downloaded flag, download_date, file_name, and container
          const downloadDate = new Date().toISOString();
          fields[6] = 'true';          // is_downloaded
          fields[7] = downloadDate;    // download_date
          fields[8] = fileName;        // file_name
          fields[9] = container;       // container
          
          // Rebuild the line with proper escaping
          return fields.map(field => escapeCsvField(field)).join(',');
        }
      } catch (error) {
        console.warn(`Failed to update CSV line for ${bc_id}: ${error.message}`);
      }
    }
    return line;
  });
  
  fs.writeFileSync(DISCOVERY_CSV_PATH, updatedLines.join('\n'), 'utf-8');
};

const getVideoMetadata = async (bcId, accessToken) => {
  const response = await axios.get(
    `${BRIGHTCOVE_CMS_URL}/accounts/${BRIGHTCOVE_ACCOUNT_ID}/videos/${bcId}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );
  return response.data;
};

const getVideoSources = async (bcId, accessToken) => {
  const response = await axios.get(
    `${BRIGHTCOVE_CMS_URL}/accounts/${BRIGHTCOVE_ACCOUNT_ID}/videos/${bcId}/sources`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );
  return response.data;
};

const saveMetadataFile = (bcId, metadata, container, outputDir, thumbnailPath = null) => {
  const metadataPath = path.join(outputDir, `${bcId}.json`);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(metadataPath)) {
    console.log(`Metadata file already exists, skipping: ${metadataPath}`);
    return { path: metadataPath, skipped: true };
  }
  
  const metadataWithContainer = {
    ...metadata,
    container: container,
    local_files: {
      video: `${bcId}.${container}`,
      thumbnail: thumbnailPath ? path.basename(thumbnailPath) : null,
      metadata: `${bcId}.json`
    }
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadataWithContainer, null, 2));
  return { path: metadataPath, skipped: false };
};

const downloadVideo = async (videoUrl, bcId, container, outputDir) => {
  const extension = container.toLowerCase();
  const videoFileName = `${bcId}.${extension}`;
  const videoPath = path.join(outputDir, videoFileName);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(videoPath)) {
    console.log(`Video file already exists, skipping download: ${videoPath}`);
    return { path: videoPath, skipped: true };
  }
  
  const response = await axios({
    method: 'get',
    url: videoUrl,
    responseType: 'stream'
  });

  await pipeline(response.data, fs.createWriteStream(videoPath));
  return { path: videoPath, skipped: false };
};

const downloadThumbnail = async (thumbnailUrl, bcId, outputDir) => {
  if (!thumbnailUrl) {
    return { path: null, skipped: true };
  }
  
  // Extract file extension from URL or default to jpg
  const urlParts = thumbnailUrl.split('.');
  const extension = urlParts.length > 1 ? urlParts[urlParts.length - 1].split('?')[0] : 'jpg';
  const thumbnailFileName = `${bcId}_thumbnail.${extension}`;
  const thumbnailPath = path.join(outputDir, thumbnailFileName);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(thumbnailPath)) {
    console.log(`Thumbnail already exists, skipping download: ${thumbnailPath}`);
    return { path: thumbnailPath, skipped: true };
  }
  
  try {
    const response = await axios({
      method: 'get',
      url: thumbnailUrl,
      responseType: 'stream'
    });

    await pipeline(response.data, fs.createWriteStream(thumbnailPath));
    return { path: thumbnailPath, skipped: false };
  } catch (error) {
    console.warn(`Failed to download thumbnail for ${bcId}: ${error.message}`);
    return { path: null, skipped: false, error: error.message };
  }
};

const ensureDirectoryExists = (dirPath) => {
  try {
    // Using recursive: true makes this safe even if directory exists
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    // Ignore error if directory already exists (race condition)
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

const getLastVideoSource = (sources) => {
  if (sources.length === 0) {
    return null;
  }
  const lastSource = sources[sources.length - 1];
  return {
    src: lastSource.src,
    container: lastSource.container || 'mp4'
  };
};

const getThumbnailUrl = (metadata) => {
  try {
    return metadata?.images?.thumbnail?.src || null;
  } catch (error) {
    console.warn('Failed to extract thumbnail URL from metadata:', error.message);
    return null;
  }
};

const processVideo = async (videoInfo, accessToken) => {
  const { bc_id, name, created_at, description, duration, tags } = videoInfo;

  if (!bc_id || bc_id === "") {
    console.log(`Skipping video with empty bc_id: bc_id=${bc_id}`);
    return null;
  }

  console.log(`Processing video: ${bc_id} - ${name}`);
  
  // Extract year and month from created_at date
  const createdDate = new Date(created_at);
  const year = createdDate.getFullYear();
  const month = String(createdDate.getMonth() + 1).padStart(2, '0');
  
  // Create date-based directory structure: /base/YYYY/MM/
  const outputDir = path.join(OUTPUT_BASE_PATH, String(year), month);
  ensureDirectoryExists(outputDir);
  
  const jsonFilePath = path.join(outputDir, `${bc_id}.json`);
  if (fs.existsSync(jsonFilePath)) {
    console.log(`Skipping video ${bc_id}: JSON file already exists at ${jsonFilePath}`);
    return null;
  }
  
  const metadata = await getVideoMetadata(bc_id, accessToken);
  
  const sources = await getVideoSources(bc_id, accessToken);
  const videoSource = getLastVideoSource(sources);
  
  if (!videoSource || !videoSource.src) {
    throw new Error(`No video source found for ${bc_id}`);
  }
  
  const videoResult = await downloadVideo(videoSource.src, bc_id, videoSource.container, outputDir);
  if (videoResult.skipped) {
    console.log(`Video already exists for ${bc_id}, skipped download`);
  } else {
    console.log(`Video downloaded for ${bc_id} (${videoSource.container})`);
  }
  
  // Download thumbnail
  const thumbnailUrl = getThumbnailUrl(metadata);
  const thumbnailResult = await downloadThumbnail(thumbnailUrl, bc_id, outputDir);
  if (thumbnailResult.skipped) {
    console.log(`Thumbnail already exists for ${bc_id}, skipped download`);
  } else if (thumbnailResult.path) {
    console.log(`Thumbnail downloaded for ${bc_id}`);
  } else {
    console.log(`No thumbnail available or failed to download for ${bc_id}`);
  }
  
  const metadataResult = saveMetadataFile(bc_id, metadata, videoSource.container, outputDir, thumbnailResult.path);
  if (metadataResult.skipped) {
    console.log(`Metadata already exists for ${bc_id}, skipped`);
  } else {
    console.log(`Metadata saved for ${bc_id}`);
  }
  
  const fileName = `${bc_id}.${videoSource.container}`;
  
  // Update discovery CSV to mark this video as downloaded
  updateDiscoveryCsvAfterDownload(bc_id, fileName, videoSource.container);
  
  return { 
    bc_id,
    name,
    created_at,
    description,
    duration,
    tags,
    fileName,
    outputDir, 
    container: videoSource.container,
    videoSkipped: videoResult.skipped,
    thumbnailSkipped: thumbnailResult.skipped,
    thumbnailPath: thumbnailResult.path,
    metadataSkipped: metadataResult.skipped
  };
};

const isTokenExpiredError = (error) => {
  return error.response && error.response.status === 401;
};

const csvWriteLock = { locked: false, queue: [] };

const writeToCsv = async (record) => {
  // Simple lock mechanism to prevent race conditions
  while (csvWriteLock.locked) {
    await new Promise(resolve => csvWriteLock.queue.push(resolve));
  }
  
  csvWriteLock.locked = true;
  
  try {
    const { bc_id, fileName, name, created_at, duration, container } = record;
    const downloadDate = new Date().toISOString();
    
    const fields = [bc_id, downloadDate, fileName, name, created_at, duration, container];
    const csvLine = fields.map(field => escapeCsvField(field)).join(',') + '\n';
    
    // Use appendFileSync for atomic write operation
    fs.appendFileSync(OUTPUT_CSV_PATH, csvLine, 'utf-8');
  } finally {
    csvWriteLock.locked = false;
    if (csvWriteLock.queue.length > 0) {
      const resolve = csvWriteLock.queue.shift();
      resolve();
    }
  }
};

const initializeOutputCsv = () => {
  // Write header if file doesn't exist
  if (!fs.existsSync(OUTPUT_CSV_PATH)) {
    const headerFields = ['brightcove_id', 'download_date', 'file_name', 'video_name', 'created_at', 'duration', 'container'];
    const header = headerFields.map(field => escapeCsvField(field)).join(',') + '\n';
    fs.writeFileSync(OUTPUT_CSV_PATH, header, 'utf-8');
    console.log(`Created output CSV file: ${OUTPUT_CSV_PATH}`);
  } else {
    console.log(`Output CSV file already exists: ${OUTPUT_CSV_PATH}`);
  }
};

const processVideoWithRetry = async (videoInfo, accessToken, getNewToken) => {
  try {
    return await processVideo(videoInfo, accessToken);
  } catch (error) {
    if (!isTokenExpiredError(error)) {
      throw error;
    }
    
    console.log(`Token expired, refreshing...`);
    const newToken = await getNewToken();
    console.log(`Token refreshed, retrying ${videoInfo.bc_id}`);
    
    return await processVideo(videoInfo, newToken);
  }
};

const createTokenManager = (initialToken) => {
  let token = initialToken;
  return {
    getToken: () => token,
    refreshToken: async () => {
      token = await getAccessToken();
      return token;
    }
  };
};

const processSingleVideo = async (videoInfo, tokenManager) => {
  try {
    const result = await processVideoWithRetry(
      videoInfo,
      tokenManager.getToken(),
      () => tokenManager.refreshToken()
    );
    
    // Write to output CSV if processing was successful and not null (not skipped)
    if (result && result.fileName) {
      await writeToCsv({
        bc_id: result.bc_id,
        fileName: result.fileName,
        name: result.name,
        created_at: result.created_at,
        duration: result.duration,
        container: result.container
      });
    }
    
    return { success: true, ...result };
  } catch (error) {
    console.error(`Failed to process ${videoInfo.bc_id}:`, error.message);
    return { success: false, bc_id: videoInfo.bc_id, error: error.message };
  }
};

const processVideoWithTimeout = async (videoInfo, tokenManager) => {
  return Promise.race([
    processSingleVideo(videoInfo, tokenManager),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: Video ${videoInfo.bc_id} exceeded ${MAX_PROCESSING_TIME_MS / 1000 / 60} minutes`)), MAX_PROCESSING_TIME_MS)
    )
  ]);
};

const processAllVideos = async (videoList, initialAccessToken) => {
  const tokenManager = createTokenManager(initialAccessToken);
  const results = [];
  let inProgress = 0;
  let currentIndex = 0;
  let completedCount = 0;
  const totalVideos = videoList.length;
  
  return new Promise((resolve) => {
    const processNext = async () => {
      // Check if we're completely done
      if (currentIndex >= totalVideos && inProgress === 0) {
        console.log(`\nAll ${totalVideos} videos processed!`);
        resolve(results);
        return;
      }
      
      // Fill empty slots up to MAX_CONCURRENT_VIDEOS
      while (inProgress < MAX_CONCURRENT_VIDEOS && currentIndex < totalVideos) {
        const videoInfo = videoList[currentIndex];
        const videoIndex = currentIndex;
        currentIndex++;
        inProgress++;
        
        console.log(`[${new Date().toISOString()}] Starting video ${videoIndex + 1}/${totalVideos}: ${videoInfo.bc_id} (${inProgress} in progress)`);
        
        // Start processing this video with timeout (non-blocking)
        processVideoWithTimeout(videoInfo, tokenManager)
          .then(result => {
            results.push(result);
            inProgress--;
            completedCount++;
            
            const successStr = result.success ? '✓' : '✗';
            console.log(`[${new Date().toISOString()}] ${successStr} Completed ${completedCount}/${totalVideos}: ${videoInfo.bc_id} (${inProgress} still in progress)`);
            
            // Immediately try to start the next video
            processNext();
          })
          .catch(error => {
            const errorType = error.message.includes('Timeout') ? '⏱ TIMEOUT' : '✗ ERROR';
            console.error(`[${new Date().toISOString()}] ${errorType} processing video ${videoIndex + 1}: ${videoInfo.bc_id} - ${error.message}`);
            results.push({ success: false, bc_id: videoInfo.bc_id, error: error.message });
            inProgress--;
            completedCount++;
            
            // Continue processing even after error
            processNext();
          });
      }
    };
    
    // Kick off the initial batch
    console.log(`Starting rolling queue with MAX_CONCURRENT_VIDEOS=${MAX_CONCURRENT_VIDEOS}`);
    processNext();
  });
};

const runDiscovery = async (maxVideos = null) => {
  console.log('=== PHASE 1: VIDEO DISCOVERY ===');
  console.log(`Output path: ${OUTPUT_BASE_PATH}/`);
  console.log(`Discovery CSV: ${DISCOVERY_CSV_PATH}`);
  
  const accessToken = await getAccessToken();
  console.log('Access token obtained');
  
  // Discover all videos and save to CSV (streaming, no memory overhead)
  const totalVideos = await discoverAndSaveAllVideos(accessToken, maxVideos);
  
  console.log('\n=== Discovery Complete ===');
  console.log(`Total videos discovered: ${totalVideos}`);
  if (maxVideos && totalVideos >= maxVideos) {
    console.log(`⚠️  Discovery was limited to ${maxVideos} videos for testing purposes`);
  }
  console.log(`Discovery saved to: ${DISCOVERY_CSV_PATH}`);
  console.log('\nNext step: Run download phase with: node app.js download');
};

const runDownload = async () => {
  console.log('=== PHASE 2: VIDEO DOWNLOAD ===');
  console.log(`Skip existing files: ${SKIP_EXISTING_FILES ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Max concurrent videos: ${MAX_CONCURRENT_VIDEOS}`);
  console.log(`Processing timeout: ${MAX_PROCESSING_TIME_MS / 1000 / 60} minutes per video`);
  console.log(`Output path: ${OUTPUT_BASE_PATH}/YYYY/MM/`);
  
  // Initialize output CSV file
  initializeOutputCsv();
  
  const accessToken = await getAccessToken();
  console.log('Access token obtained');
  
  // Read videos from discovery CSV (only non-downloaded ones)
  console.log(`\nReading from discovery CSV: ${DISCOVERY_CSV_PATH}`);
  const videoList = readDiscoveryCsv();
  console.log(`Found ${videoList.length} videos to download (excluding already downloaded)`);
  
  if (videoList.length === 0) {
    console.log('\nAll videos have already been downloaded!');
    return [];
  }
  
  const results = await processAllVideos(videoList, accessToken);
  
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.filter(r => !r.success).length;
  const timeoutCount = results.filter(r => !r.success && r.error && r.error.includes('Timeout')).length;
  const videoSkippedCount = results.filter(r => r.success && r.videoSkipped).length;
  const thumbnailSkippedCount = results.filter(r => r.success && r.thumbnailSkipped).length;
  const metadataSkippedCount = results.filter(r => r.success && r.metadataSkipped).length;
  
  console.log(`\n=== Download Complete ===`);
  console.log(`Total: ${results.length} videos`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`  - Timeouts (>${MAX_PROCESSING_TIME_MS / 1000 / 60} min): ${timeoutCount}`);
  console.log(`  - Other errors: ${failedCount - timeoutCount}`);
  console.log(`Videos skipped (already exist): ${videoSkippedCount}`);
  console.log(`Thumbnails skipped (already exist): ${thumbnailSkippedCount}`);
  console.log(`Metadata skipped (already exist): ${metadataSkippedCount}`);
  
  // Show remaining videos
  const remainingVideos = readDiscoveryCsv();
  if (remainingVideos.length > 0) {
    console.log(`\n⚠️  ${remainingVideos.length} videos still need to be downloaded.`);
    console.log('Run the download phase again to resume: node app.js download');
  } else {
    console.log('\n✅ All videos have been downloaded!');
  }
  
  return results;
};

const main = async () => {
  try {
    const mode = process.argv[2] || 'discover';
    const maxVideosArg = process.argv[3];
    
    if (mode === 'discover' || mode === 'discovery') {
      const maxVideos = maxVideosArg ? parseInt(maxVideosArg, 10) : null;
      if (maxVideosArg && (isNaN(maxVideos) || maxVideos <= 0)) {
        console.error('Error: Max videos parameter must be a positive number');
        process.exit(1);
      }
      await runDiscovery(maxVideos);
    } else if (mode === 'download') {
      await runDownload();
    } else if (mode === 'all') {
      // Run both phases sequentially
      const maxVideos = maxVideosArg ? parseInt(maxVideosArg, 10) : null;
      if (maxVideosArg && (isNaN(maxVideos) || maxVideos <= 0)) {
        console.error('Error: Max videos parameter must be a positive number');
        process.exit(1);
      }
      await runDiscovery(maxVideos);
      console.log('\n\n');
      await runDownload();
    } else {
      console.log('Usage:');
      console.log('  node app.js discover [maxVideos]  - Discover videos and save to CSV');
      console.log('                                      Optional: limit number of videos for testing');
      console.log('  node app.js download              - Download videos, thumbnails, and metadata from CSV (resumable)');
      console.log('  node app.js all [maxVideos]       - Run both phases sequentially');
      console.log('');
      console.log('Downloads include:');
      console.log('  - Video files (*.mp4, *.mov, etc.)');
      console.log('  - Thumbnail images (*_thumbnail.jpg)');
      console.log('  - Metadata JSON files (*.json)');
      console.log('');
      console.log('Examples:');
      console.log('  node app.js discover              - Discover all videos');
      console.log('  node app.js discover 50           - Discover only 50 videos for testing');
      console.log('  node app.js all 100               - Discover 100 videos then download them');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
};

main();

