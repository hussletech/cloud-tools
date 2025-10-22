# Brightcove Video Migration Tool

Node.js application to migrate videos from Brightcove CMS to S3-mounted filesystem on EC2.

## Quick Start (Local Development)

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your credentials

# Run
node app.js
```

## EC2 Production Deployment

### Step 1: Upload to EC2
```bash
# From your local machine
scp -i your-key.pem -r bc-migration ec2-user@your-ec2-ip:/home/ec2-user/
```

### Step 2: Setup on EC2
```bash
# SSH into EC2
ssh -i your-key.pem ec2-user@your-ec2-ip

# Navigate to directory
cd /home/ec2-user/bc-migration

# Run setup script
chmod +x setup.sh
./setup.sh

# Edit credentials
nano .env
```

### Step 3: Run Application
```bash
# Test run
node app.js

# Production (with PM2)
npm install -g pm2
pm2 start app.js --name bc-migration
pm2 logs bc-migration
```

📖 **Full deployment guide**: See [DEPLOYMENT.md](./DEPLOYMENT.md)

## Configuration

### Environment Variables (.env)
```env
API_KEY=your_brightcove_client_id
API_SECRET=your_brightcove_client_secret
```

### Global Configuration (app.js)
```javascript
const OUTPUT_BASE_PATH = '/home/ec2-user/assets.soundconcepts.com';
const OUTPUT_SUFFIX_PATH = 'assets/video';
const MAX_CONCURRENT_VIDEOS = 5;
const SKIP_EXISTING_FILES = true;
```

## CSV Format

```csv
"db_name,""video_id"",""site_id"",""webroot"",""bc_id"""
"repsites_amare,5025,72,webroot_amare,""5522235072001"""
```

Required columns: `webroot`, `bc_id`

## Output Structure

```
/home/ec2-user/assets.soundconcepts.com/
└── {webroot}/
    └── assets/
        └── video/
            ├── {bc_id}.mp4      # Downloaded video
            └── {bc_id}.json     # Metadata with container info
```

## Features

✅ Parallel processing (5 videos at a time)  
✅ Automatic token refresh on expiration  
✅ Skip existing files (no overwrites)  
✅ Dynamic video extensions (MP4, MOV, etc.)  
✅ Error handling and retry logic  
✅ Comprehensive logging  
✅ Safe for S3-mounted filesystems  

## Monitoring

```bash
# View logs (PM2)
pm2 logs bc-migration

# View logs (systemd)
journalctl -u bc-migration -f

# View logs (manual)
tail -f migration.log
```

## Troubleshooting

### Check S3 Mount
```bash
df -h /home/ec2-user/assets.soundconcepts.com
ls -la /home/ec2-user/assets.soundconcepts.com
```

### Test Brightcove API
```bash
curl --location 'https://oauth.brightcove.com/v4/access_token' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --header 'Authorization: Basic [base64_credentials]' \
  --data-urlencode 'grant_type=client_credentials'
```

### Common Issues

**Error: ENOENT: no such file or directory**
- Verify S3 is mounted
- Check OUTPUT_BASE_PATH in app.js

**Error: 401 Unauthorized**
- Check API_KEY and API_SECRET in .env
- Verify credentials with Brightcove

**Memory issues**
- Increase Node.js memory: `node --max-old-space-size=4096 app.js`

## Dependencies

- `axios` - HTTP client for API requests
- `csv-parse` - CSV file parsing
- `dotenv` - Environment variable management

## License

ISC
