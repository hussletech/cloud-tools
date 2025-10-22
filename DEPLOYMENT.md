# EC2 Linux Deployment Guide

## 1. Prerequisites on EC2

```bash
# Install Node.js (if not already installed)
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verify installation
node --version
npm --version
```

## 2. Upload Application Files

### Option A: Using SCP from your local machine
```bash
# From your local machine
scp -i your-key.pem -r bc-migration ec2-user@your-ec2-ip:/home/ec2-user/
```

### Option B: Using Git (Recommended)
```bash
# On EC2
cd /home/ec2-user
git clone https://github.com/your-repo/cloud.git
cd cloud/bc-migration
```

### Option C: Manual upload
1. Connect to EC2: `ssh -i your-key.pem ec2-user@your-ec2-ip`
2. Create directory: `mkdir -p /home/ec2-user/bc-migration`
3. Upload files using SFTP or copy-paste

## 3. Setup on EC2

```bash
# Navigate to app directory
cd /home/ec2-user/bc-migration

# Install dependencies
npm install

# Create .env file with your credentials
cat > .env << EOF
API_KEY=your_brightcove_client_id
API_SECRET=your_brightcove_client_secret
EOF

# Set proper permissions for .env
chmod 600 .env

# Verify the output directory exists (or will be created)
# The app will create: /home/ec2-user/assets.soundconcepts.com/{webroot}/assets/video/
```

## 4. Test the Application

```bash
# Run a test with sample CSV
node app.js
```

## 5. Running in Production

### Option A: Run in Background (Simple)
```bash
# Run in background with nohup
nohup node app.js > migration.log 2>&1 &

# Check if running
ps aux | grep node

# View logs
tail -f migration.log

# Stop the process
pkill -f "node app.js"
```

### Option B: Using PM2 (Recommended for Production)
```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the application
pm2 start app.js --name bc-migration

# View logs
pm2 logs bc-migration

# Monitor
pm2 monit

# Stop
pm2 stop bc-migration

# Restart
pm2 restart bc-migration

# Make PM2 start on system reboot
pm2 startup
pm2 save
```

### Option C: Create a Systemd Service
```bash
# Create service file
sudo nano /etc/systemd/system/bc-migration.service
```

Add this content:
```ini
[Unit]
Description=Brightcove Video Migration Service
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/bc-migration
ExecStart=/usr/bin/node app.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/ec2-user/bc-migration/migration.log
StandardError=append:/home/ec2-user/bc-migration/error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:
```bash
# Reload systemd
sudo systemctl daemon-reload

# Start service
sudo systemctl start bc-migration

# Enable on boot
sudo systemctl enable bc-migration

# Check status
sudo systemctl status bc-migration

# View logs
journalctl -u bc-migration -f
```

## 6. Monitoring & Logs

```bash
# View real-time logs
tail -f /home/ec2-user/bc-migration/migration.log

# Check disk space (important for S3 mount)
df -h /home/ec2-user/assets.soundconcepts.com

# Monitor running processes
htop

# Check memory usage
free -m
```

## 7. Scheduling with Cron (Optional)

```bash
# Edit crontab
crontab -e

# Run daily at 2 AM
0 2 * * * cd /home/ec2-user/bc-migration && /usr/bin/node app.js >> /home/ec2-user/bc-migration/cron.log 2>&1

# Run every 6 hours
0 */6 * * * cd /home/ec2-user/bc-migration && /usr/bin/node app.js >> /home/ec2-user/bc-migration/cron.log 2>&1
```

## 8. Troubleshooting

### Check S3 mount
```bash
# Verify S3 is mounted
mount | grep s3fs
ls -la /home/ec2-user/assets.soundconcepts.com
```

### Permission issues
```bash
# Fix file permissions
chmod +x app.js
chown -R ec2-user:ec2-user /home/ec2-user/bc-migration
```

### Node.js memory issues (for large files)
```bash
# Increase Node.js memory limit
node --max-old-space-size=4096 app.js
```

### Check connectivity
```bash
# Test Brightcove API access
curl https://oauth.brightcove.com/v4/access_token

# Check network
ping brightcove.com
```

## 9. File Structure on EC2

```
/home/ec2-user/
├── bc-migration/
│   ├── app.js                    # Main application
│   ├── package.json              # Dependencies
│   ├── .env                      # Credentials (keep secure!)
│   ├── bc-video-amare-test.csv   # Input CSV file
│   ├── migration.log             # Application logs
│   └── node_modules/             # Installed packages
│
└── assets.soundconcepts.com/     # S3-mounted directory
    └── webroot_amare/            # Dynamic webroot folders
        └── assets/
            └── video/
                ├── 6313505637112.mp4
                └── 6313505637112.json
```

## 10. Security Best Practices

```bash
# Secure .env file
chmod 600 .env

# Never commit .env to git
echo ".env" >> .gitignore

# Use IAM roles instead of access keys when possible
# Restrict security group to only necessary ports

# Keep Node.js updated
sudo npm install -g n
sudo n stable
```

## 11. Quick Start Commands

```bash
# Complete setup in one go
cd /home/ec2-user/bc-migration
npm install
nano .env  # Add your credentials
node app.js  # Test run

# For production
pm2 start app.js --name bc-migration
pm2 logs bc-migration
```

## 12. Stopping the Application

```bash
# If using nohup
pkill -f "node app.js"

# If using PM2
pm2 stop bc-migration

# If using systemd
sudo systemctl stop bc-migration
```

