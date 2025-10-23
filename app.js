require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pipeline } = require('stream/promises');

const CSV_FILE_PATH = './bc-video-multi-client.csv';

const BRIGHTCOVE_OAUTH_URL = 'https://oauth.brightcove.com/v4/access_token';
const BRIGHTCOVE_CMS_URL = 'https://cms.api.brightcove.com/v1';
const BRIGHTCOVE_ACCOUNT_ID = '659677170001';
const OUTPUT_BASE_PATH = '/home/ec2-user/assets.soundconcepts.com';
const OUTPUT_SUFFIX_PATH = 'assets/video';
const MAX_CONCURRENT_VIDEOS = 5;
const SKIP_EXISTING_FILES = true;

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
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
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
  const { bc_id, web_root } = videoInfo;
  
  console.log(`Processing video: ${bc_id} for ${web_root}`);
  
  const outputDir = path.join(OUTPUT_BASE_PATH, web_root, OUTPUT_SUFFIX_PATH);
  ensureDirectoryExists(outputDir);
  
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
  
  return { 
    bc_id, 
    web_root, 
    outputDir, 
    container: videoSource.container,
    videoSkipped: videoResult.skipped,
    metadataSkipped: metadataResult.skipped
  };
};

const isTokenExpiredError = (error) => {
  return error.response && error.response.status === 401;
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
    return { success: true, ...result };
  } catch (error) {
    console.error(`Failed to process ${videoInfo.bc_id}:`, error.message);
    return { success: false, bc_id: videoInfo.bc_id, error: error.message };
  }
};

const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const processAllVideos = async (videoList, initialAccessToken) => {
  const tokenManager = createTokenManager(initialAccessToken);
  const batches = chunkArray(videoList, MAX_CONCURRENT_VIDEOS);
  const results = [];
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} videos)`);
    
    const batchPromises = batch.map(videoInfo => 
      processSingleVideo(videoInfo, tokenManager)
    );
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    const successCount = batchResults.filter(r => r.success).length;
    console.log(`Batch ${i + 1} complete: ${successCount}/${batch.length} successful`);
  }
  
  return results;
};

const main = async () => {
  try {
    console.log('Starting Brightcove video migration...');
    console.log(`Skip existing files: ${SKIP_EXISTING_FILES ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Output path: ${OUTPUT_BASE_PATH}/{webroot}/${OUTPUT_SUFFIX_PATH}`);
    
    const videoList = readCsvFile(CSV_FILE_PATH);
    console.log(`Found ${videoList.length} videos to process`);
    
    const accessToken = await getAccessToken();
    console.log('Access token obtained');
    
    const results = await processAllVideos(videoList, accessToken);
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const videoSkippedCount = results.filter(r => r.success && r.videoSkipped).length;
    const metadataSkippedCount = results.filter(r => r.success && r.metadataSkipped).length;
    
    console.log(`\n=== Processing Complete ===`);
    console.log(`Total: ${results.length} videos`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Videos skipped (already exist): ${videoSkippedCount}`);
    console.log(`Metadata skipped (already exist): ${metadataSkippedCount}`);
    
    return results;
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
};

main();

