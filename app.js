require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pipeline } = require('stream/promises');

// const CSV_FILE_PATH = './bc-video-all.csv';
const CSV_FILE_PATH = './bc-video-all-new.csv';

const OUTPUT_BASE_PATH = '/home/ec2-user/assets.soundconcepts.com';
// const OUTPUT_BASE_PATH = './s3';

const OUTPUT_SUFFIX_PATH = 'assets/video';
const MAX_CONCURRENT_VIDEOS = 120;
const MAX_CONCURRENT_POSTERS = 120;
const MAX_PROCESSING_TIME_MS = 10 * 60 * 1000; // 10 minutes timeout
const MAX_POSTER_PROCESSING_TIME_MS = 5 * 60 * 1000; // 5 minutes timeout for posters
const SKIP_EXISTING_FILES = true;
const OUTPUT_CSV_PATH = './output-bc-migration.csv';
const BRIGHTCOVE_OAUTH_URL = 'https://oauth.brightcove.com/v4/access_token';
const BRIGHTCOVE_CMS_URL = 'https://cms.api.brightcove.com/v1';
const BRIGHTCOVE_ACCOUNT_ID = '659677170001';

const getAuthHeader = () => {
  const credentials = Buffer.from(`${process.env.API_KEY}:${process.env.API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
};

const cleanCsvValue = (value) => {
  return value
    .replace(/^"/, '')
    .replace(/"$/, '')
    .replace(/\r/g, '')
    .trim();
};

const parseCsvLine = (line) => {
  const cleaned = line.replace(/^"/, '').replace(/"$/, '').replace(/\r/g, '');
  const parts = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const nextChar = cleaned[i + 1];
    
    if (char === '"' && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      parts.push(cleanCsvValue(current));
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(cleanCsvValue(current));
  
  return parts;
};

const readCsvFile = (filePath) => {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n').filter(line => line.trim());
  
  const headers = parseCsvLine(lines[0]);
  const records = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] || '';
    });
    records.push(record);
  }
  
  return records.map(record => ({
    db_name: record.db_name,
    video_id: record.video_id,
    site_id: record.site_id,
    web_root: record.webroot,
    bc_id: record.bc_id
  }));
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

const saveMetadataFile = (bcId, metadata, container, outputDir) => {
  const metadataPath = path.join(outputDir, `${bcId}.json`);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(metadataPath)) {
    console.log(`Metadata file already exists, skipping: ${metadataPath}`);
    return { path: metadataPath, skipped: true };
  }
  
  const metadataWithContainer = {
    ...metadata,
    container: container
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

const processVideo = async (videoInfo, accessToken) => {
  const { bc_id, web_root, db_name, video_id, site_id } = videoInfo;

  if (!bc_id || bc_id === "" || !web_root || web_root === "") {
    console.log(`Skipping video with empty bc_id or web_root: bc_id=${bc_id}, web_root=${web_root}`);
    return null;
  }

  console.log(`Processing video: ${bc_id} for ${web_root}`);
  
  const outputDir = path.join(OUTPUT_BASE_PATH, web_root, OUTPUT_SUFFIX_PATH);
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
  
  const metadataResult = saveMetadataFile(bc_id, metadata, videoSource.container, outputDir);
  if (metadataResult.skipped) {
    console.log(`Metadata already exists for ${bc_id}, skipped`);
  } else {
    console.log(`Metadata saved for ${bc_id}`);
  }
  
  const fileName = `${bc_id}.${videoSource.container}`;
  
  return { 
    db_name,
    video_id,
    site_id,
    web_root,
    bc_id, 
    fileName,
    outputDir, 
    container: videoSource.container,
    videoSkipped: videoResult.skipped,
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
    const { db_name, video_id, site_id, web_root, bc_id, fileName } = record;
    // Format to match input CSV: db_name,video_id,site_id,webroot,"bc_id","fileName"
    const csvLine = `${db_name},${video_id},${site_id},${web_root},"${bc_id}","${fileName}"\n`;
    
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
    const header = 'db_name,"video_id","site_id","webroot","bc_id","fileName"\n';
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
        db_name: result.db_name,
        video_id: result.video_id,
        site_id: result.site_id,
        web_root: result.web_root,
        bc_id: result.bc_id,
        fileName: result.fileName
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

// ==================== POSTER DOWNLOAD FUNCTIONS ====================

const getExtensionFromUrl = (url) => {
  try {
    // Extract extension from URL, default to jpg if not found
    const urlPath = new URL(url).pathname;
    const match = urlPath.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    return match ? match[1].toLowerCase() : 'jpg';
  } catch (error) {
    // Default to jpg if URL parsing fails
    return 'jpg';
  }
};

const getPosterUrlFromMetadata = (metadata) => {
  if (!metadata || !metadata.images || !metadata.images.poster) {
    return null;
  }
  
  // Use the src property from images.poster
  if (metadata?.images?.poster?.src) {
    return metadata.images.poster.src;
  }
  
  // Fallback to first source if available
  if (metadata.images.poster.sources && metadata.images.poster.sources.length > 0) {
    return metadata.images.poster.sources[0].src;
  }
  
  return null;
};

const getThumbnailUrlFromMetadata = (metadata) => {
  if (!metadata || !metadata.images || !metadata.images.thumbnail) {
    return null;
  }
  
  // Use the src property from images.thumbnail
  if (metadata?.images?.thumbnail?.src) {
    return metadata.images.thumbnail.src;
  }
  
  // Fallback to first source if available
  if (metadata.images.thumbnail.sources && metadata.images.thumbnail.sources.length > 0) {
    return metadata.images.thumbnail.sources[0].src;
  }
  
  return null;
};

const readMetadataFile = (metadataPath) => {
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Metadata file not found: ${metadataPath}`);
  }
  
  const fileContent = fs.readFileSync(metadataPath, 'utf-8');
  return JSON.parse(fileContent);
};

const downloadPoster = async (posterUrl, bcId, extension, outputDir) => {
  const posterFileName = `${bcId}_poster.${extension}`;
  const posterPath = path.join(outputDir, posterFileName);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(posterPath)) {
    console.log(`Poster file already exists, skipping download: ${posterPath}`);
    return { path: posterPath, skipped: true };
  }
  
  const response = await axios({
    method: 'get',
    url: posterUrl,
    responseType: 'stream'
  });

  await pipeline(response.data, fs.createWriteStream(posterPath));
  return { path: posterPath, skipped: false };
};

const downloadThumbnail = async (thumbnailUrl, bcId, extension, outputDir) => {
  const thumbnailFileName = `${bcId}_thumbnail.${extension}`;
  const thumbnailPath = path.join(outputDir, thumbnailFileName);
  
  if (SKIP_EXISTING_FILES && fs.existsSync(thumbnailPath)) {
    console.log(`Thumbnail file already exists, skipping download: ${thumbnailPath}`);
    return { path: thumbnailPath, skipped: true };
  }
  
  const response = await axios({
    method: 'get',
    url: thumbnailUrl,
    responseType: 'stream'
  });

  await pipeline(response.data, fs.createWriteStream(thumbnailPath));
  return { path: thumbnailPath, skipped: false };
};

const processPoster = async (videoInfo) => {
  const { bc_id, web_root } = videoInfo;

  if (!bc_id || bc_id === "" || !web_root || web_root === "") {
    console.log(`Skipping images with empty bc_id or web_root: bc_id=${bc_id}, web_root=${web_root}`);
    return null;
  }

  console.log(`Processing images (poster & thumbnail): ${bc_id} for ${web_root}`);
  
  const outputDir = path.join(OUTPUT_BASE_PATH, web_root, OUTPUT_SUFFIX_PATH);
  const metadataPath = path.join(outputDir, `${bc_id}.json`);
  
  if (!fs.existsSync(metadataPath)) {
    console.log(`Metadata file not found for ${bc_id}, skipping image download: ${metadataPath}`);
    return null;
  }
  
  // Read metadata file
  const metadata = readMetadataFile(metadataPath);
  
  const result = {
    bc_id,
    web_root,
    posterDownloaded: false,
    posterSkipped: false,
    thumbnailDownloaded: false,
    thumbnailSkipped: false,
    skipped: true
  };
  
  // Extract and download poster
  const posterUrl = getPosterUrlFromMetadata(metadata);
  if (posterUrl) {
    const posterExtension = getExtensionFromUrl(posterUrl);
    const posterResult = await downloadPoster(posterUrl, bc_id, posterExtension, outputDir);
    result.posterPath = posterResult.path;
    result.posterSkipped = posterResult.skipped;
    result.posterDownloaded = !posterResult.skipped;
    if (posterResult.skipped) {
      console.log(`Poster already exists for ${bc_id}, skipped download`);
    } else {
      console.log(`Poster downloaded for ${bc_id} (${posterExtension})`);
    }
    result.skipped = false; // At least one image was processed
  } else {
    console.log(`No poster URL found in metadata for ${bc_id}`);
  }
  
  // Extract and download thumbnail
  const thumbnailUrl = getThumbnailUrlFromMetadata(metadata);
  if (thumbnailUrl) {
    const thumbnailExtension = getExtensionFromUrl(thumbnailUrl);
    const thumbnailResult = await downloadThumbnail(thumbnailUrl, bc_id, thumbnailExtension, outputDir);
    result.thumbnailPath = thumbnailResult.path;
    result.thumbnailSkipped = thumbnailResult.skipped;
    result.thumbnailDownloaded = !thumbnailResult.skipped;
    if (thumbnailResult.skipped) {
      console.log(`Thumbnail already exists for ${bc_id}, skipped download`);
    } else {
      console.log(`Thumbnail downloaded for ${bc_id} (${thumbnailExtension})`);
    }
    result.skipped = false; // At least one image was processed
  } else {
    console.log(`No thumbnail URL found in metadata for ${bc_id}`);
  }
  
  // If neither poster nor thumbnail was found, mark as skipped
  if (!posterUrl && !thumbnailUrl) {
    result.reason = 'No poster or thumbnail URL in metadata';
    return result;
  }
  
  return result;
};

const processSinglePoster = async (videoInfo) => {
  try {
    const result = await processPoster(videoInfo);
    
    return { success: true, ...result };
  } catch (error) {
    console.error(`Failed to process images for ${videoInfo.bc_id}:`, error.message);
    return { success: false, bc_id: videoInfo.bc_id, error: error.message };
  }
};

const processPosterWithTimeout = async (videoInfo) => {
  return Promise.race([
    processSinglePoster(videoInfo),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: Images ${videoInfo.bc_id} exceeded ${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} minutes`)), MAX_POSTER_PROCESSING_TIME_MS)
    )
  ]);
};

const processAllPosters = async (videoList) => {
  const results = [];
  let inProgress = 0;
  let currentIndex = 0;
  let completedCount = 0;
  const totalVideos = videoList.length;
  
  return new Promise((resolve) => {
    const processNext = async () => {
      // Check if we're completely done
      if (currentIndex >= totalVideos && inProgress === 0) {
        console.log(`\nAll ${totalVideos} videos processed for images!`);
        resolve(results);
        return;
      }
      
      // Fill empty slots up to MAX_CONCURRENT_POSTERS
      while (inProgress < MAX_CONCURRENT_POSTERS && currentIndex < totalVideos) {
        const videoInfo = videoList[currentIndex];
        const videoIndex = currentIndex;
        currentIndex++;
        inProgress++;
        
        console.log(`[${new Date().toISOString()}] Starting images ${videoIndex + 1}/${totalVideos}: ${videoInfo.bc_id} (${inProgress} in progress)`);
        
        // Start processing this video's images with timeout (non-blocking)
        processPosterWithTimeout(videoInfo)
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
            console.error(`[${new Date().toISOString()}] ${errorType} processing images ${videoIndex + 1}: ${videoInfo.bc_id} - ${error.message}`);
            results.push({ success: false, bc_id: videoInfo.bc_id, error: error.message });
            inProgress--;
            completedCount++;
            
            // Continue processing even after error
            processNext();
          });
      }
    };
    
    // Kick off the initial batch
    console.log(`Starting rolling queue with MAX_CONCURRENT_POSTERS=${MAX_CONCURRENT_POSTERS}`);
    processNext();
  });
};

// ==================== THUMBNAIL ONLY DOWNLOAD FUNCTIONS ====================

const processThumbnail = async (videoInfo) => {
  const { bc_id, web_root } = videoInfo;

  if (!bc_id || bc_id === "" || !web_root || web_root === "") {
    console.log(`Skipping thumbnail with empty bc_id or web_root: bc_id=${bc_id}, web_root=${web_root}`);
    return null;
  }

  console.log(`Processing thumbnail: ${bc_id} for ${web_root}`);
  
  const outputDir = path.join(OUTPUT_BASE_PATH, web_root, OUTPUT_SUFFIX_PATH);
  const metadataPath = path.join(outputDir, `${bc_id}.json`);
  
  if (!fs.existsSync(metadataPath)) {
    console.log(`Metadata file not found for ${bc_id}, skipping thumbnail download: ${metadataPath}`);
    return null;
  }
  
  // Read metadata file
  const metadata = readMetadataFile(metadataPath);
  
  const result = {
    bc_id,
    web_root,
    thumbnailDownloaded: false,
    thumbnailSkipped: false,
    skipped: true
  };
  
  // Extract and download thumbnail only
  const thumbnailUrl = getThumbnailUrlFromMetadata(metadata);
  if (thumbnailUrl) {
    const thumbnailExtension = getExtensionFromUrl(thumbnailUrl);
    const thumbnailResult = await downloadThumbnail(thumbnailUrl, bc_id, thumbnailExtension, outputDir);
    result.thumbnailPath = thumbnailResult.path;
    result.thumbnailSkipped = thumbnailResult.skipped;
    result.thumbnailDownloaded = !thumbnailResult.skipped;
    if (thumbnailResult.skipped) {
      console.log(`Thumbnail already exists for ${bc_id}, skipped download`);
    } else {
      console.log(`Thumbnail downloaded for ${bc_id} (${thumbnailExtension})`);
    }
    result.skipped = false; // At least one thumbnail was processed
  } else {
    console.log(`No thumbnail URL found in metadata for ${bc_id}`);
    result.reason = 'No thumbnail URL in metadata';
  }
  
  return result;
};

const processSingleThumbnail = async (videoInfo) => {
  try {
    const result = await processThumbnail(videoInfo);
    
    return { success: true, ...result };
  } catch (error) {
    console.error(`Failed to process thumbnail for ${videoInfo.bc_id}:`, error.message);
    return { success: false, bc_id: videoInfo.bc_id, error: error.message };
  }
};

const processThumbnailWithTimeout = async (videoInfo) => {
  return Promise.race([
    processSingleThumbnail(videoInfo),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: Thumbnail ${videoInfo.bc_id} exceeded ${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} minutes`)), MAX_POSTER_PROCESSING_TIME_MS)
    )
  ]);
};

const processAllThumbnails = async (videoList) => {
  const results = [];
  let inProgress = 0;
  let currentIndex = 0;
  let completedCount = 0;
  const totalVideos = videoList.length;
  
  return new Promise((resolve) => {
    const processNext = async () => {
      // Check if we're completely done
      if (currentIndex >= totalVideos && inProgress === 0) {
        console.log(`\nAll ${totalVideos} videos processed for thumbnails!`);
        resolve(results);
        return;
      }
      
      // Fill empty slots up to MAX_CONCURRENT_POSTERS
      while (inProgress < MAX_CONCURRENT_POSTERS && currentIndex < totalVideos) {
        const videoInfo = videoList[currentIndex];
        const videoIndex = currentIndex;
        currentIndex++;
        inProgress++;
        
        console.log(`[${new Date().toISOString()}] Starting thumbnail ${videoIndex + 1}/${totalVideos}: ${videoInfo.bc_id} (${inProgress} in progress)`);
        
        // Start processing this video's thumbnail with timeout (non-blocking)
        processThumbnailWithTimeout(videoInfo)
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
            console.error(`[${new Date().toISOString()}] ${errorType} processing thumbnail ${videoIndex + 1}: ${videoInfo.bc_id} - ${error.message}`);
            results.push({ success: false, bc_id: videoInfo.bc_id, error: error.message });
            inProgress--;
            completedCount++;
            
            // Continue processing even after error
            processNext();
          });
      }
    };
    
    // Kick off the initial batch
    console.log(`Starting rolling queue with MAX_CONCURRENT_POSTERS=${MAX_CONCURRENT_POSTERS}`);
    processNext();
  });
};

const main = async () => {
  try {
    console.log('Starting Brightcove video migration...');
    console.log(`Skip existing files: ${SKIP_EXISTING_FILES ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Max concurrent videos: ${MAX_CONCURRENT_VIDEOS}`);
    console.log(`Processing timeout: ${MAX_PROCESSING_TIME_MS / 1000 / 60} minutes per video`);
    console.log(`Output path: ${OUTPUT_BASE_PATH}/{webroot}/${OUTPUT_SUFFIX_PATH}`);
    
    // Initialize output CSV file
    initializeOutputCsv();
    
    const videoList = readCsvFile(CSV_FILE_PATH);
    console.log(`Found ${videoList.length} videos to process`);
    
    const accessToken = await getAccessToken();
    console.log('Access token obtained');
    
    const results = await processAllVideos(videoList, accessToken);
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const timeoutCount = results.filter(r => !r.success && r.error && r.error.includes('Timeout')).length;
    const videoSkippedCount = results.filter(r => r.success && r.videoSkipped).length;
    const metadataSkippedCount = results.filter(r => r.success && r.metadataSkipped).length;
    
    console.log(`\n=== Processing Complete ===`);
    console.log(`Total: ${results.length} videos`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`  - Timeouts (>${MAX_PROCESSING_TIME_MS / 1000 / 60} min): ${timeoutCount}`);
    console.log(`  - Other errors: ${failedCount - timeoutCount}`);
    console.log(`Videos skipped (already exist): ${videoSkippedCount}`);
    console.log(`Metadata skipped (already exist): ${metadataSkippedCount}`);
    
    return results;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
};

const mainPosterDownload = async () => {
  try {
    console.log('Starting Brightcove image download (poster & thumbnail)...');
    console.log(`Skip existing files: ${SKIP_EXISTING_FILES ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Max concurrent downloads: ${MAX_CONCURRENT_POSTERS}`);
    console.log(`Processing timeout: ${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} minutes per video`);
    console.log(`Output path: ${OUTPUT_BASE_PATH}/{webroot}/${OUTPUT_SUFFIX_PATH}`);
    
    const videoList = readCsvFile(CSV_FILE_PATH);
    console.log(`Found ${videoList.length} videos to process for images`);
    
    const results = await processAllPosters(videoList);
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const timeoutCount = results.filter(r => !r.success && r.error && r.error.includes('Timeout')).length;
    const skippedCount = results.filter(r => r.success && (r.skipped || r.reason === 'No poster or thumbnail URL in metadata')).length;
    const metadataNotFoundCount = results.filter(r => !r.success && r.error && r.error.includes('Metadata file not found')).length;
    const noImageUrlCount = results.filter(r => r.success && r.reason === 'No poster or thumbnail URL in metadata').length;
    const posterDownloadedCount = results.filter(r => r.success && r.posterDownloaded).length;
    const posterSkippedCount = results.filter(r => r.success && r.posterSkipped).length;
    const thumbnailDownloadedCount = results.filter(r => r.success && r.thumbnailDownloaded).length;
    const thumbnailSkippedCount = results.filter(r => r.success && r.thumbnailSkipped).length;
    
    console.log(`\n=== Image Download Complete ===`);
    console.log(`Total: ${results.length} videos`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`  - Timeouts (>${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} min): ${timeoutCount}`);
    console.log(`  - Metadata not found: ${metadataNotFoundCount}`);
    console.log(`  - Other errors: ${failedCount - timeoutCount - metadataNotFoundCount}`);
    console.log(`\nPoster Statistics:`);
    console.log(`  - Downloaded: ${posterDownloadedCount}`);
    console.log(`  - Skipped (already exist): ${posterSkippedCount}`);
    console.log(`\nThumbnail Statistics:`);
    console.log(`  - Downloaded: ${thumbnailDownloadedCount}`);
    console.log(`  - Skipped (already exist): ${thumbnailSkippedCount}`);
    console.log(`\nSkipped (no URLs in metadata): ${noImageUrlCount}`);
    
    return results;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
};

const mainThumbnailDownload = async () => {
  try {
    console.log('Starting Brightcove thumbnail download...');
    console.log(`Skip existing files: ${SKIP_EXISTING_FILES ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Max concurrent downloads: ${MAX_CONCURRENT_POSTERS}`);
    console.log(`Processing timeout: ${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} minutes per video`);
    console.log(`Output path: ${OUTPUT_BASE_PATH}/{webroot}/${OUTPUT_SUFFIX_PATH}`);
    
    const videoList = readCsvFile(CSV_FILE_PATH);
    console.log(`Found ${videoList.length} videos to process for thumbnails`);
    
    const results = await processAllThumbnails(videoList);
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const timeoutCount = results.filter(r => !r.success && r.error && r.error.includes('Timeout')).length;
    const skippedCount = results.filter(r => r.success && (r.skipped || r.reason === 'No thumbnail URL in metadata')).length;
    const metadataNotFoundCount = results.filter(r => !r.success && r.error && r.error.includes('Metadata file not found')).length;
    const noThumbnailUrlCount = results.filter(r => r.success && r.reason === 'No thumbnail URL in metadata').length;
    const thumbnailDownloadedCount = results.filter(r => r.success && r.thumbnailDownloaded).length;
    const thumbnailSkippedCount = results.filter(r => r.success && r.thumbnailSkipped).length;
    
    console.log(`\n=== Thumbnail Download Complete ===`);
    console.log(`Total: ${results.length} videos`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`  - Timeouts (>${MAX_POSTER_PROCESSING_TIME_MS / 1000 / 60} min): ${timeoutCount}`);
    console.log(`  - Metadata not found: ${metadataNotFoundCount}`);
    console.log(`  - Other errors: ${failedCount - timeoutCount - metadataNotFoundCount}`);
    console.log(`Skipped (already exist or no thumbnail URL): ${skippedCount}`);
    console.log(`\nThumbnail Statistics:`);
    console.log(`  - Downloaded: ${thumbnailDownloadedCount}`);
    console.log(`  - Skipped (already exist): ${thumbnailSkippedCount}`);
    console.log(`  - No thumbnail URL in metadata: ${noThumbnailUrlCount}`);
    
    return results;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
};

// Command-line argument parsing
const getCommandLineArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    step: 'all', // 'video', 'poster', 'thumbnail', or 'all'
  };
  
  args.forEach(arg => {
    if (arg === '--video' || arg === '-v') {
      options.step = 'video';
    } else if (arg === '--poster' || arg === '-p') {
      options.step = 'poster';
    } else if (arg === '--thumbnail' || arg === '-t') {
      options.step = 'thumbnail';
    } else if (arg === '--all' || arg === '-a') {
      options.step = 'all';
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node app.js [OPTIONS]

Options:
  --video, -v       Run video and metadata download only
  --poster, -p      Run poster and thumbnail download only
  --thumbnail, -t   Run thumbnail download only
  --all, -a         Run both video and image download (default)
  --help, -h        Show this help message

Examples:
  node app.js --video      # Download videos and metadata only
  node app.js --poster     # Download posters and thumbnails only
  node app.js --thumbnail  # Download thumbnails only
  node app.js --all        # Download everything (videos, metadata, posters, thumbnails)
      `);
      process.exit(0);
    }
  });
  
  return options;
};

const run = async () => {
  const options = getCommandLineArgs();
  
  try {
    if (options.step === 'video' || options.step === 'all') {
      await main();
    }
    
    if (options.step === 'poster' || options.step === 'all') {
      // Add a separator if running both
      if (options.step === 'all') {
        console.log('\n' + '='.repeat(50));
        console.log('Starting poster download phase...');
        console.log('='.repeat(50) + '\n');
      }
      await mainPosterDownload();
    }
    
    if (options.step === 'thumbnail') {
      await mainThumbnailDownload();
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
};

// Run based on command-line arguments
run();

